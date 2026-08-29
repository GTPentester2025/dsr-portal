import { Global, Module, forwardRef } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { CryptoService } from '../crypto/crypto.service';
import { EmailModule } from '../email/email.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Global so every provider can read runtime configuration without importing
 * anything. EmailModule is forward-referenced because the email dispatcher
 * itself depends on settings.
 */
@Global()
@Module({
  imports: [forwardRef(() => EmailModule), forwardRef(() => AuthModule)],
  controllers: [SettingsController],
  providers: [SettingsService, CryptoService],
  exports: [SettingsService, CryptoService],
})
export class SettingsModule {}
