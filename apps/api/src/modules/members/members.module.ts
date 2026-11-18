import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
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
import { Public, RequirePermissions } from '../../platform/rbac/authz.decorators.js';
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

  @RequirePermissions('members:read')
  @Get('members')
  listMembers(@Query(new ZodPipe(pageQuery)) query: PageQuery) {
    return this.members.list(query);
  }

  @RequirePermissions('members:update')
  @Patch('members/:id')
  updateMember(@Param('id', idParam) id: string, @Body(new ZodPipe(updateMemberRequest)) body: UpdateMemberRequest) {
    return this.members.update(id, body);
  }

  @RequirePermissions('members:read')
  @Get('roles')
  listRoles() {
    return this.members.listRoles();
  }

  @RequirePermissions('members:invite')
  @Post('invitations')
  createInvitation(@Body(new ZodPipe(createInvitationRequest)) body: CreateInvitationRequest) {
    return this.invitations.create(body);
  }

  @RequirePermissions('members:read')
  @Get('invitations')
  listInvitations() {
    return this.invitations.listPending();
  }

  @RequirePermissions('members:invite')
  @Post('invitations/:id/resend')
  @HttpCode(200)
  resendInvitation(@Param('id', idParam) id: string) {
    return this.invitations.resend(id);
  }

  @RequirePermissions('members:invite')
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

  @Public()
  @Post('preview')
  @HttpCode(200)
  preview(@Body(new ZodPipe(invitationTokenRequest)) body: InvitationTokenRequest) {
    return this.invitations.preview(body.token);
  }

  @Public()
  @Post('accept')
  async accept(
    @Body(new ZodPipe(acceptInvitationRequest)) body: AcceptInvitationRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.invitations.accept(body, { ip: req.ip, userAgent: req.get('user-agent') });
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
