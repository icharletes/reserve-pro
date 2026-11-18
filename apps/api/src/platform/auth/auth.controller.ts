import { ApiDoc } from '../openapi/api-doc.decorator.js';
import { authResponse as authResponseSchema, meResponse as meResponseSchema } from '@reservepro/contracts';
import { z as zod } from 'zod';
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  type ChangePasswordRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type RegisterRequest,
  type ResetPasswordRequest,
  type SwitchTenantRequest,
  type VerifyEmailRequest,
  changePasswordRequest,
  forgotPasswordRequest,
  loginRequest,
  registerRequest,
  resetPasswordRequest,
  switchTenantRequest,
  verifyEmailRequest,
} from '@reservepro/contracts';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RateLimit } from '../rate-limit/rate-limit.module.js';
import { Authenticated, Public } from '../rbac/authz.decorators.js';
import { AccountService } from './account.service.js';
import { AuthService } from './auth.service.js';
import type { AuthedRequest } from './principal.js';

const REFRESH_COOKIE = 'rp_refresh';
const REFRESH_PATH = '/api/v1/auth';
const CSRF_HEADER = 'x-rp-csrf';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly account: AccountService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @RateLimit({ name: 'register', limit: 5, windowSec: 3600, by: 'ip' })
  @ApiDoc({
    summary: 'Registrar una empresa y su propietario',
    description: 'Crea en una transacción: usuario, empresa, roles de sistema y membresía de propietario. Inicia sesión (cookie rp_refresh) y envía el email de verificación.',
    response: authResponseSchema,
    errors: { 409: 'Email ya registrado o identificador (slug) en uso (EMAIL_TAKEN / SLUG_TAKEN)' },
  })
  @Post('register')
  async register(
    @Body(new ZodPipe(registerRequest)) body: RegisterRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(body, this.client(req));
    this.setRefreshCookie(res, result.refreshToken);
    res.status(201);
    return result.body;
  }

  @Public()
  @RateLimit(
    { name: 'login-ip', limit: 20, windowSec: 60, by: 'ip' },
    { name: 'login-ip-email', limit: 10, windowSec: 900, by: 'ip+email' },
  )
  @ApiDoc({
    summary: 'Iniciar sesión',
    description: 'Si el usuario tiene varias empresas y no se indica `tenantId`, `activeTenantId` es null y debe llamarse a switch-tenant.',
    response: authResponseSchema,
    errors: { 401: 'Credenciales incorrectas (INVALID_CREDENTIALS)', 429: 'Cuenta bloqueada temporalmente (TOO_MANY_ATTEMPTS) o límite de tasa (RATE_LIMITED)' },
  })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginRequest)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, this.client(req));
    this.setRefreshCookie(res, result.refreshToken);
    return result.body;
  }

  /** Rota el refresh token (cookie HttpOnly). Exige cabecera anti-CSRF personalizada. */
  @Public()
  @RateLimit({ name: 'refresh', limit: 60, windowSec: 60, by: 'ip' })
  @ApiDoc({
    summary: 'Rotar el refresh token',
    description: 'Lee la cookie HttpOnly `rp_refresh` y exige la cabecera `x-rp-csrf: 1`. Reutilizar un token ya rotado revoca toda la sesión.',
    response: authResponseSchema,
    errors: { 401: 'Refresh token inválido, vencido o reutilizado (TOKEN_INVALID)', 403: 'Falta la cabecera anti-CSRF (CSRF_REJECTED)' },
  })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.requireCsrf(req);
    const token = this.readRefreshCookie(req);
    if (!token) throw Errors.tokenInvalid();
    try {
      const result = await this.auth.refresh(token, this.client(req));
      this.setRefreshCookie(res, result.refreshToken);
      return result.body;
    } catch (err) {
      this.clearRefreshCookie(res); // un token inválido no debe seguir viajando
      throw err;
    }
  }

  @Public()
  @ApiDoc({ summary: 'Cerrar sesión', description: 'Idempotente. Exige la cabecera `x-rp-csrf: 1`.', response: null, errors: { 403: 'Falta la cabecera anti-CSRF (CSRF_REJECTED)' } })
  @RateLimit({ name: 'logout', limit: 60, windowSec: 60, by: 'ip' })
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.requireCsrf(req);
    await this.auth.logout(this.readRefreshCookie(req));
    this.clearRefreshCookie(res);
  }

  @Authenticated()
  @ApiDoc({ summary: 'Cambiar la empresa activa', response: authResponseSchema, errors: { 403: 'El usuario no pertenece a esa empresa (FORBIDDEN)' } })
  @Post('switch-tenant')
  @HttpCode(200)
  switchTenant(@Body(new ZodPipe(switchTenantRequest)) body: SwitchTenantRequest, @Req() req: AuthedRequest) {
    return this.auth.switchTenant(req.principal!, body.tenantId);
  }

  // --- Contraseña y verificación de email -------------------------------------------------------
  /** Responde SIEMPRE 202 exista o no la cuenta: no revela qué emails están registrados. */
  @Public()
  @RateLimit(
    { name: 'forgot-ip', limit: 10, windowSec: 3600, by: 'ip' },
    { name: 'forgot-email', limit: 3, windowSec: 3600, by: 'email' },
  )
  @ApiDoc({ summary: 'Solicitar recuperación de contraseña', description: 'Responde SIEMPRE 202, exista o no la cuenta. El enlace llega por email.', response: zod.object({ status: zod.literal('accepted') }) })
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body(new ZodPipe(forgotPasswordRequest)) body: ForgotPasswordRequest) {
    await this.account.forgotPassword(body.email);
    return { status: 'accepted' };
  }

  @Public()
  @RateLimit({ name: 'reset-ip', limit: 10, windowSec: 900, by: 'ip' })
  @ApiDoc({ summary: 'Restablecer la contraseña con el token del email', description: 'Atómico y de un solo uso. Cierra TODAS las sesiones del usuario.', response: null, errors: { 400: 'Enlace inválido o vencido (LINK_INVALID) o contraseña débil (VALIDATION_ERROR)' } })
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body(new ZodPipe(resetPasswordRequest)) body: ResetPasswordRequest): Promise<void> {
    await this.account.resetPassword(body.token, body.password);
  }

  @Authenticated()
  @RateLimit({ name: 'change-password', limit: 5, windowSec: 900, by: 'user' })
  @ApiDoc({ summary: 'Cambiar la contraseña (autenticado)', description: 'Cierra las OTRAS sesiones y conserva la actual. Contraseña actual incorrecta: 400 INVALID_CREDENTIALS (no 401).', response: null })
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @Body(new ZodPipe(changePasswordRequest)) body: ChangePasswordRequest,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.account.changePassword(req.principal!, body.currentPassword, body.newPassword);
  }

  @Public()
  @RateLimit({ name: 'verify-email', limit: 20, windowSec: 900, by: 'ip' })
  @ApiDoc({ summary: 'Verificar el email con el token recibido', response: null, errors: { 400: 'Enlace inválido o vencido (LINK_INVALID)' } })
  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body(new ZodPipe(verifyEmailRequest)) body: VerifyEmailRequest): Promise<void> {
    await this.account.verifyEmail(body.token);
  }

  @Authenticated()
  @RateLimit({ name: 'resend-verification', limit: 3, windowSec: 3600, by: 'user' })
  @ApiDoc({ summary: 'Reenviar el email de verificación', description: 'Invalida el enlace anterior. No hace nada si el email ya está verificado.', response: null })
  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(@Req() req: AuthedRequest): Promise<void> {
    await this.account.resendVerification(req.principal!);
  }

  // -------------------------------------------------------------------------------------------
  private client(req: Request) {
    return { ip: req.ip, userAgent: req.get('user-agent') };
  }

  /** Las cabeceras personalizadas fuerzan preflight CORS: un formulario de otro sitio no puede enviarlas. */
  private requireCsrf(req: Request): void {
    if (req.get(CSRF_HEADER) !== '1') throw Errors.csrf();
  }

  private readRefreshCookie(req: Request): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: REFRESH_PATH,
      maxAge: this.config.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Authenticated()
  @ApiDoc({ summary: 'Usuario autenticado, empresa activa, roles y permisos', response: meResponseSchema })
  @Get()
  me(@Req() req: AuthedRequest) {
    return this.auth.me(req.principal!);
  }
}
