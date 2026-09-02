import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportService } from './report.service';
import { ReportPdfService } from './report-pdf.service';
import { StorageService } from './storage.service';
import { CasePdfService } from './case-pdf.service';
import { AttachmentsController } from './attachments.controller';
import { ReportController } from './report.controller';
import { EmailModule } from '../email/email.module';
import { CasesController } from './cases.controller';
import { CasesService } from './cases.service';
import { CasesActionsController } from './cases-actions.controller';
import { WorkflowService } from './workflow.service';
import { AssignmentService } from './assignment.service';
import { HousekeepingService } from './housekeeping.service';
import { SlaService } from './sla.service';
import { OutboundService } from './outbound.service';
import { DashboardService } from './dashboard.service';
import { AdminUsersController } from '../admin/admin-users.controller';
import { SchemaController } from '../admin/schema.controller';
import { SchemaService } from '../admin/schema.service';
import { CryptoService } from '../crypto/crypto.service';
import { CaseSourceGuard } from './case-source.guard';
import { CaseDeletionService } from './case-deletion.service';

@Module({
  imports: [AuthModule, EmailModule],
  controllers: [ReportController, AttachmentsController, CasesController, CasesActionsController, AdminUsersController, SchemaController],
  providers: [ReportService, ReportPdfService, StorageService, CasePdfService, 
    CasesService,
    WorkflowService,
    AssignmentService,
    HousekeepingService,
    SlaService,
    OutboundService,
    DashboardService,
    CryptoService,
    CaseSourceGuard,
    SchemaService,
    CaseDeletionService,
  ],
  exports: [CasesService, AssignmentService, SlaService, CaseSourceGuard],
})
export class CasesModule {}
