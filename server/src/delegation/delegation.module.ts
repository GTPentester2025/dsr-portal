import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CasesModule } from '../cases/cases.module';
import { EmailModule } from '../email/email.module';
import { GroupsService } from './groups.service';
import { StorageService } from '../cases/storage.service';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimitService } from '../public/rate-limit.service';

@Module({
  imports: [AuthModule, CasesModule, EmailModule],
  controllers: [],
  providers: [GroupsService, StorageService, CryptoService, RateLimitService],
})
export class DelegationModule {}
