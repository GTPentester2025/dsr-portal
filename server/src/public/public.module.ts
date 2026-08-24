import { Module } from '@nestjs/common';
import { PublicUploadsController } from './public-uploads.controller';
import { StorageService } from '../cases/storage.service';
import { EmailModule } from '../email/email.module';
import { CasesModule } from '../cases/cases.module';
import { CryptoService } from '../crypto/crypto.service';
import { PublicController } from './public.controller';
import { VerificationService } from './verification.service';
import { IntakeService } from './intake.service';
import { RateLimitService } from './rate-limit.service';

@Module({
  imports: [EmailModule, CasesModule],
  controllers: [PublicController, PublicUploadsController],
  providers: [StorageService, CryptoService, VerificationService, IntakeService, RateLimitService],
})
export class PublicModule {}
