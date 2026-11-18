import { Module } from '@nestjs/common';
import { AuthController, MeController } from './auth.controller.js';
import { AuthGuard, PermissionsGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService, PasswordService, TokenService, SessionService, AuthGuard, PermissionsGuard],
  exports: [AuthGuard, PermissionsGuard, AuthService, TokenService, SessionService, PasswordService],
})
export class AuthModule {}
