import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { EmailModule } from './email/email.module';
import { DbModule } from './db/db.module';
import { SettingsModule } from './settings/settings.module';
import { AuditModule } from './audit/audit.service';
import { PublicModule } from './public/public.module';
import { AuthModule } from './auth/auth.module';
import { CasesModule } from './cases/cases.module';
import { FormsModule } from './forms/forms.module';
import { MigrationModule } from './migration/migration.module';
import { DelegationModule } from './delegation/delegation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DbModule,
    AuditModule,
    SettingsModule,
    EmailModule,
    PublicModule,
    AuthModule,
    CasesModule,
    FormsModule,
    MigrationModule,
    DelegationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
