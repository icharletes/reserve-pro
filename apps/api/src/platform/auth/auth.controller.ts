import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  type LoginRequest,
  type RegisterRequest,
  type SwitchTenantRequest,
  loginRequest,
  registerRequest,
  switchTenantRequest,
} from '@reservepro/contracts';
import { AppConfig } from '../../config/app-config.js';
import { Errors } from '../../common/errors.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Authenticated, Public } from '../rbac/authz.decorators.js';
import { AuthService } from './auth.service.js';
import type { AuthedRequest } from './principal.js';

const REFRESH_COOKIE = 'rp_refresh';
const REFRESH_PATH = '/api/v1/auth';
const CSRF_HEADER = 'x-rp-csrf';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
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
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.requireCsrf(req);
    await this.auth.logout(this.readRefreshCookie(req));
    this.clearRefreshCookie(res);
  }

  @Authenticated()
  @Post('switch-tenant')
  @HttpCode(200)
  switchTenant(@Body(new ZodPipe(switchTenantRequest)) body: SwitchTenantRequest, @Req() req: AuthedRequest) {
    return this.auth.switchTenant(req.principal!, body.tenantId);
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
  @Get()
  me(@Req() req: AuthedRequest) {
    return this.auth.me(req.principal!);
  }
}
