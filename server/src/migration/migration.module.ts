import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';
import { CryptoService } from '../crypto/crypto.service';
import { ImportUndoService } from './import-undo.service';
import { StorageService } from '../cases/storage.service';

@Module({
  imports: [AuthModule],
  controllers: [MigrationController],
  providers: [MigrationService, CryptoService, ImportUndoService, StorageService],
})
export class MigrationModule {}
