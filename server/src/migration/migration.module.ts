import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { CryptoService } from '../crypto/crypto.service';

@Module({
  imports: [AuthModule],
  controllers: [MigrationController],
  providers: [MigrationService, CryptoService],
})
export class MigrationModule {}
