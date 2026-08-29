import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { WorkflowService } from './workflow.service';
import { AssignmentService } from './assignment.service';
import { SlaService } from './sla.service';
import { OutboundService } from './outbound.service';
import { DashboardService } from './dashboard.service';

@Controller('internal')
@UseGuards(AuthGuard)
export class CasesActionsController {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly assignment: AssignmentService,
    private readonly sla: SlaService,
    private readonly outbound: OutboundService,
    private readonly dashboard: DashboardService,
  ) {}

  @Post('cases/:id/status')
  @Requires('cases.work')
  changeStatus(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      toStatus: string; note?: string; justification?: string;
      newDueDate?: string; outcomeCode?: string; closureNote?: string;
    },
    @Ip() ip: string,
  ) {
    return this.workflow.changeStatus(req.zoneCtx, {
      caseId: id,
      toStatus: body?.toStatus ?? '',
      note: body?.note,
      justification: body?.justification,
      newDueDate: body?.newDueDate,
      outcomeCode: body?.outcomeCode,
      closureNote: body?.closureNote,
      actorId: req.user.id,
      ip,
    });
  }

  @Post('cases/:id/assign')
  @Requires('cases.work')
  assign(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { assigneeId: string; reason?: string },
    @Ip() ip: string,
  ) {
    return this.assignment.assign(req.zoneCtx, {
      caseId: id,
      assigneeId: body?.assigneeId ?? '',
      reason: body?.reason,
      actorId: req.user.id,
      ip,
    });
  }

  /** Grant more time on an open case. Approvers can do this; auditors cannot. */
  @Post('cases/:id/sla/extend')
  @Requires('cases.work')
  extendSla(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { value?: number; unit?: 'minutes' | 'hours' | 'days'; justification?: string },
  ) {
    return this.sla.extend(
      req.zoneCtx,
      id,
      {
        value: Number(body?.value),
        unit: body?.unit ?? 'days',
        justification: body?.justification ?? '',
      },
      req.user.id,
    );
  }

  @Post('cases/:id/sla/pause')
  @Requires('cases.work')
  pause(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sla.pause(req.zoneCtx, id, req.user.id);
  }

  @Post('cases/:id/sla/resume')
  @Requires('cases.work')
  resume(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.sla.resume(req.zoneCtx, id, req.user.id);
  }

  @Post('sla/recompute')
  @Requires('system.operate')
  recompute() {
    return this.sla.recomputeAll();
  }

  // ---- templates + outbound ----------------------------------------------

  @Get('templates')
  listTemplates(
    @Req() req: AuthedRequest,
    @Query('zone') zone?: string,
    @Query('requestType') requestType?: string,
  ) {
    return this.outbound.listTemplates(req.zoneCtx, zone, requestType);
  }

  @Post('templates')
  @Requires('config.manage')
  upsertTemplate(
    @Req() req: AuthedRequest,
    @Body() body: {
      id?: string; zoneId?: string | null; requestType?: string | null;
      name: string; subject: string; body: string; category?: string;
    },
  ) {
    return this.outbound.upsertTemplate(req.zoneCtx, { ...body, actorId: req.user.id });
  }

  @Get('cases/:id/draft-email')
  @Requires('cases.work')
  renderDraft(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('templateId', ParseUUIDPipe) templateId: string,
  ) {
    return this.outbound.renderDraft(req.zoneCtx, id, templateId);
  }

  @Post('cases/:id/send-email')
  @Requires('cases.work')
  sendEmail(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      to: string[]; cc?: string[]; bcc?: string[];
      subject: string; body: string; templateId?: string;
    },
    @Ip() ip: string,
  ) {
    return this.outbound.send(req.zoneCtx, {
      caseId: id,
      to: body?.to ?? [],
      cc: body?.cc,
      bcc: body?.bcc,
      subject: body?.subject ?? '',
      body: body?.body ?? '',
      templateId: body?.templateId,
      actorId: req.user.id,
      ip,
    });
  }

  /**
   * Mark the case as waiting on the people an email was addressed to.
   *
   * Used when a message is sent from the operator's own mail client: the server
   * never sees that send, so without this the case would show as waiting on
   * nobody. Same derivation as an in-portal send, so the two agree.
   */
  @Post('cases/:id/pending')
  @Requires('cases.work')
  setPending(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { to?: string[] },
  ) {
    return this.outbound.markPending(req.zoneCtx, id, body?.to ?? [], req.user.id);
  }

  // ---- dashboard ----------------------------------------------------------

  /**
   * Anyone below administrator sees their own zone whatever they ask for. The
   * filter is applied to the query rather than to the result, so there is no
   * request shape that returns another zone's figures.
   */
  @Get('dashboard')
  overview(@Req() req: AuthedRequest, @Query('zone') zone?: string) {
    const scoped =
      req.user.role === 'admin' || req.user.role === 'super_admin' || req.user.role === 'auditor'
        ? zone || undefined
        : req.user.zoneId ?? undefined;
    return this.dashboard.overview(req.zoneCtx, scoped);
  }
}
