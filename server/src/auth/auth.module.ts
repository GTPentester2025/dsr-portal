import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { RateLimitService } from '../public/rate-limit.service';
import { PasswordStrategy } from './password.strategy';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, RateLimitService, PasswordStrategy],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
