import { ApiDoc } from '../../platform/openapi/api-doc.decorator.js';
import {
  acceptInvitationResponse,
  createInvitationResponse,
  invitationPreview,
  invitationView,
  memberView,
  pageOf,
  roleView,
} from '@reservepro/contracts';
import { z as zod } from 'zod';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type InvitationTokenRequest,
  type UpdateMemberRequest,
  acceptInvitationRequest,
  createInvitationRequest,
  invitationTokenRequest,
  updateMemberRequest,
  uuid,
} from '@reservepro/contracts';
import { AppConfig } from '../../config/app-config.js';
import { type PageQuery, pageQuery } from '../../common/pagination.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AuthModule } from '../../platform/auth/auth.module.js';
import { RateLimit } from '../../platform/rate-limit/rate-limit.module.js';
import {
  Public,
  RequirePermissions,
  RequireVerifiedEmail,
} from '../../platform/rbac/authz.decorators.js';
import { InvitationsService } from './invitations.service.js';
import { MembersService } from './members.service.js';

const idParam = new ZodPipe(uuid);

/** Gestión de miembros e invitaciones de la empresa activa (autenticado). */
@Controller('tenants/current')
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly invitations: InvitationsService,
  ) {}

  @ApiDoc({
    summary: 'Listar los miembros de la empresa',
    description: 'Paginado por cursor (`cursor`, `limit` ≤ 100).',
    response: pageOf(memberView),
  })
  @RequirePermissions('members:read')
  @Get('members')
  listMembers(@Query(new ZodPipe(pageQuery)) query: PageQuery) {
    return this.members.list(query);
  }

  @ApiDoc({
    summary: 'Cambiar el estado y/o los roles de un miembro',
    description:
      'Anti-escalada: solo se otorga o gestiona lo que el actor mismo puede. Nadie se modifica a sí mismo. La empresa nunca queda sin propietario activo.',
    response: memberView,
    errors: {
      403: 'Roles o permisos superiores a los del actor (ROLE_NOT_ALLOWED)',
      404: 'Miembro no encontrado en la empresa activa',
      409: 'CANNOT_MODIFY_SELF o LAST_OWNER',
    },
  })
  @RequirePermissions('members:update')
  @Patch('members/:id')
  updateMember(
    @Param('id', idParam) id: string,
    @Body(new ZodPipe(updateMemberRequest)) body: UpdateMemberRequest,
  ) {
    return this.members.update(id, body);
  }

  @ApiDoc({ summary: 'Roles de la empresa con sus permisos', response: zod.array(roleView) })
  @RequirePermissions('members:read')
  @Get('roles')
  listRoles() {
    return this.members.listRoles();
  }

  @ApiDoc({
    summary: 'Invitar a una persona a la empresa',
    description:
      'Envía un email con un enlace de un solo uso (vigencia 7 días). El token NUNCA aparece en la respuesta. Requiere email verificado.',
    response: createInvitationResponse,
    errors: {
      403: 'EMAIL_NOT_VERIFIED o ROLE_NOT_ALLOWED',
      409: 'ALREADY_MEMBER, ALREADY_INVITED o LIMIT_REACHED',
    },
  })
  @RequirePermissions('members:invite')
  @RequireVerifiedEmail()
  @RateLimit(
    { name: 'invite-user', limit: 30, windowSec: 3600, by: 'user' },
    { name: 'invite-tenant', limit: 100, windowSec: 86_400, by: 'tenant' },
  )
  @Post('invitations')
  createInvitation(@Body(new ZodPipe(createInvitationRequest)) body: CreateInvitationRequest) {
    return this.invitations.create(body);
  }

  @ApiDoc({ summary: 'Invitaciones pendientes', response: zod.array(invitationView) })
  @RequirePermissions('members:read')
  @Get('invitations')
  listInvitations() {
    return this.invitations.listPending();
  }

  @RequirePermissions('members:invite')
  @RequireVerifiedEmail()
  @RateLimit(
    { name: 'invite-user', limit: 30, windowSec: 3600, by: 'user' },
    { name: 'invite-tenant', limit: 100, windowSec: 86_400, by: 'tenant' },
  )
  @ApiDoc({
    summary: 'Reenviar una invitación',
    description: 'Genera un token NUEVO (el anterior deja de servir) y extiende la vigencia.',
    response: createInvitationResponse,
    errors: { 404: 'Invitación no encontrada o ya resuelta' },
  })
  @Post('invitations/:id/resend')
  @HttpCode(200)
  resendInvitation(@Param('id', idParam) id: string) {
    return this.invitations.resend(id);
  }

  @RequirePermissions('members:invite')
  @ApiDoc({
    summary: 'Revocar una invitación pendiente',
    response: null,
    errors: { 404: 'Invitación no encontrada o ya resuelta' },
  })
  @Delete('invitations/:id')
  @HttpCode(204)
  async revokeInvitation(@Param('id', idParam) id: string): Promise<void> {
    await this.invitations.revoke(id);
  }
}

const REFRESH_COOKIE = 'rp_refresh';
const REFRESH_PATH = '/api/v1/auth';

/**
 * Lado invitado (público). El token viaja en el CUERPO (POST), nunca en la URL: así no queda en los
 * logs de acceso. Su posesión, enviada al buzón del invitado, es la prueba de identidad.
 */
@Controller('invitations')
export class PublicInvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly config: AppConfig,
  ) {}

  @ApiDoc({
    summary: 'Ver la invitación (empresa, rol y si ya existe la cuenta)',
    description: 'El token va en el CUERPO, nunca en la URL, para no quedar en logs de acceso.',
    response: invitationPreview,
    errors: { 400: 'Token inválido, usado, revocado o vencido (INVITATION_INVALID)' },
  })
  @Public()
  @RateLimit({ name: 'invitation-public', limit: 30, windowSec: 900, by: 'ip' })
  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodPipe(invitationTokenRequest)) body: InvitationTokenRequest) {
    return this.invitations.preview(body.token);
  }

  @ApiDoc({
    summary: 'Aceptar una invitación',
    description:
      'Cuenta nueva: exige fullName y password, crea la cuenta e inicia sesión (201 + cookie). Cuenta existente: se une sin iniciar sesión (200, outcome=joined).',
    response: acceptInvitationResponse,
    errors: {
      200: 'outcome=joined: ya tenía cuenta; debe iniciar sesión',
      400: 'INVITATION_INVALID o datos de la cuenta faltantes',
      409: 'ALREADY_MEMBER o EMAIL_TAKEN',
    },
  })
  @Public()
  @RateLimit({ name: 'invitation-public', limit: 30, windowSec: 900, by: 'ip' })
  @Post('accept')
  async accept(
    @Body(new ZodPipe(acceptInvitationRequest)) body: AcceptInvitationRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.invitations.accept(body, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    if (result.refreshToken) {
      res.cookie(REFRESH_COOKIE, result.refreshToken, {
        httpOnly: true,
        secure: this.config.isProduction,
        sameSite: 'lax',
        path: REFRESH_PATH,
        maxAge: this.config.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      });
      res.status(201);
    } else {
      res.status(200);
    }
    return result.body;
  }
}

@Module({
  imports: [AuthModule],
  controllers: [MembersController, PublicInvitationsController],
  providers: [MembersService, InvitationsService],
})
export class MembersModule {}
