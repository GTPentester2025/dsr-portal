import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CasesModule } from '../cases/cases.module';
import { EmailModule } from '../email/email.module';
import { GroupsService } from './groups.service';
import { StorageService } from '../cases/storage.service';
import { CryptoService } from '../crypto/crypto.service';
import { RateLimitService } from '../public/rate-limit.service';
import { DelegationService } from './delegation.service';
import { DelegationController } from './delegation.controller';
import { PublicDelegationController } from './public-delegation.controller';
import { DelegationRateGuard } from './delegation-rate.guard';

@Module({
  imports: [AuthModule, CasesModule, EmailModule],
  controllers: [DelegationController, PublicDelegationController],
  providers: [
    GroupsService,
    StorageService,
    CryptoService,
    RateLimitService,
    DelegationService,
    DelegationRateGuard,
  ],
})
export class DelegationModule {}
