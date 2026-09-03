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
import { CaseSourceGuard } from './case-source.guard';
import { CollaborationService } from './collaboration.service';

@Controller('internal')
@UseGuards(AuthGuard)
export class CasesActionsController {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly assignment: AssignmentService,
    private readonly sla: SlaService,
    private readonly outbound: OutboundService,
    private readonly dashboard: DashboardService,
    private readonly source: CaseSourceGuard,
    private readonly collab: CollaborationService,
  ) {}

  /**
   * The transition table and status list, so the console can offer only the
   * moves the server would accept. Read-only and role-free on purpose: it
   * describes the workflow, not any case.
   */
  @Get('workflow/transitions')
  transitions() {
    return this.workflow.transitionTable();
  }

  @Post('cases/:id/status')
  @Requires('cases.work')
  async changeStatus(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      toStatus: string; note?: string; justification?: string;
      newDueDate?: string; outcomeCode?: string; closureNote?: string;
      expectedUpdatedAt?: string;
    },
    @Ip() ip: string,
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'moved to another status');
    return this.workflow.changeStatus(req.zoneCtx, {
      caseId: id,
      toStatus: body?.toStatus ?? '',
      note: body?.note,
      justification: body?.justification,
      newDueDate: body?.newDueDate,
      outcomeCode: body?.outcomeCode,
      closureNote: body?.closureNote,
      expectedUpdatedAt: body?.expectedUpdatedAt,
      actorId: req.user.id,
      ip,
    });
  }

  // ---- collaboration ------------------------------------------------------

  /** Append an internal comment. Append-only; the record is the point. */
  @Post('cases/:id/comments')
  @Requires('cases.work')
  async comment(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { body?: string },
    @Ip() ip: string,
  ) {
    return this.collab.addComment(req.zoneCtx, id, req.user.id, body?.body ?? '', ip);
  }

  @Post('cases/:id/watch')
  @Requires('cases.work')
  watch(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.collab.watch(req.zoneCtx, id, req.user.id);
  }

  @Post('cases/:id/unwatch')
  @Requires('cases.work')
  unwatch(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.collab.unwatch(req.zoneCtx, id, req.user.id);
  }

  @Post('cases/:id/priority')
  @Requires('cases.work')
  async setPriority(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { priority?: string },
    @Ip() ip: string,
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'prioritised');
    return this.collab.setPriority(req.zoneCtx, id, body?.priority ?? '', req.user.id, ip);
  }

  @Post('cases/:id/tags')
  @Requires('cases.work')
  setTags(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { tags?: unknown },
    @Ip() ip: string,
  ) {
    return this.collab.setTags(req.zoneCtx, id, body?.tags ?? [], req.user.id, ip);
  }

  @Post('cases/:id/snooze')
  @Requires('cases.work')
  async snooze(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { until?: string | null },
    @Ip() ip: string,
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'snoozed');
    return this.collab.setSnooze(req.zoneCtx, id, body?.until ?? null, req.user.id, ip);
  }

  /**
   * Assign several cases in one action. Each case goes through exactly the
   * same path as a single assignment — source guard, zone check, audit row —
   * and a failure on one does not abort the rest: the caller gets a verdict
   * per case rather than a transaction that hides which one was the problem.
   */
  @Post('cases/bulk-assign')
  @Requires('cases.work')
  async bulkAssign(
    @Req() req: AuthedRequest,
    @Body() body: { ids?: string[]; assigneeId?: string; reason?: string },
    @Ip() ip: string,
  ) {
    const ids = [...new Set(body?.ids ?? [])].slice(0, 100);
    if (ids.length === 0 || !body?.assigneeId) {
      return { ok: false, results: [], error: 'ids and assigneeId are required' };
    }
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        await this.source.assertLive(req.zoneCtx, id, 'assigned to somebody');
        await this.assignment.assign(req.zoneCtx, {
          caseId: id,
          assigneeId: body.assigneeId,
          reason: body.reason?.trim() || 'Bulk assignment from the case list',
          actorId: req.user.id,
          ip,
        });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return {
      ok: results.every((r) => r.ok),
      assigned: results.filter((r) => r.ok).length,
      results,
    };
  }

  /**
   * The outcome report has gone to the requester. Separate from closing: a
   * case can be decided days before the answer actually reaches the person who
   * asked, and the gap between the two is exactly what an audit looks at.
   */
  @Post('cases/:id/report/publish')
  @Requires('cases.work')
  async publishReport(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { note?: string },
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'marked as answered');
    return this.workflow.markReportPublished(req.zoneCtx, id, req.user.id, body?.note);
  }

  /** Confirmed read by the data subject — a receipt, a reply, or a call. */
  @Post('cases/:id/report/accessed')
  @Requires('cases.work')
  async reportAccessed(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { note?: string },
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'marked as read');
    return this.workflow.markReportAccessed(req.zoneCtx, id, req.user.id, body?.note);
  }

  /** Raise an appeal against a closed case; creates a linked new case. */
  @Post('cases/:id/appeal')
  @Requires('cases.work')
  async appeal(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
    @Ip() ip: string,
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'appealed here');
    return this.workflow.openAppeal(req.zoneCtx, {
      caseId: id,
      reason: body?.reason ?? '',
      actorId: req.user.id,
      ip,
    });
  }

  /** Record the decision on an appeal case. */
  @Post('cases/:id/appeal/decide')
  @Requires('cases.work')
  async decideAppeal(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status?: string },
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'decided here');
    return this.workflow.setAppealStatus(req.zoneCtx, id, body?.status ?? '', req.user.id);
  }

  @Post('cases/:id/assign')
  @Requires('cases.work')
  async assign(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { assigneeId: string; reason?: string; expectedUpdatedAt?: string },
    @Ip() ip: string,
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'assigned to somebody');
    return this.assignment.assign(req.zoneCtx, {
      caseId: id,
      assigneeId: body?.assigneeId ?? '',
      reason: body?.reason,
      expectedUpdatedAt: body?.expectedUpdatedAt,
      actorId: req.user.id,
      ip,
    });
  }

  /** Grant more time on an open case. Approvers can do this; auditors cannot. */
  @Post('cases/:id/sla/extend')
  @Requires('cases.work')
  async extendSla(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { value?: number; unit?: 'minutes' | 'hours' | 'days'; justification?: string },
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'given more time');
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
  async pause(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.source.assertLive(req.zoneCtx, id, 'paused');
    return this.sla.pause(req.zoneCtx, id, req.user.id);
  }

  @Post('cases/:id/sla/resume')
  @Requires('cases.work')
  async resume(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.source.assertLive(req.zoneCtx, id, 'resumed');
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
  async sendEmail(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      to: string[]; cc?: string[]; bcc?: string[];
      subject: string; body: string; templateId?: string;
      /** Hand the case to this user as part of the send (e.g. mailing another team). */
      assignToId?: string;
    },
    @Ip() ip: string,
  ) {
    // The one that matters most: writing to somebody about a request they made
    // years ago, already answered by a system that no longer runs.
    await this.source.assertLive(req.zoneCtx, id, 'written to');
    const sent = await this.outbound.send(req.zoneCtx, {
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

    // Ownership transfer rides along with the send: writing to another team
    // often means the case is now theirs. After the send on purpose — the
    // message going out must not depend on the reassignment being legal, and
    // a failed transfer is reported on a sent mail rather than blocking it.
    if (body?.assignToId) {
      try {
        await this.assignment.assign(req.zoneCtx, {
          caseId: id,
          assigneeId: body.assignToId,
          reason: `Ownership transferred while sending "${body?.subject ?? ''}"`,
          actorId: req.user.id,
          ip,
        });
      } catch (err) {
        return { ...sent, assignWarning: (err as Error).message };
      }
    }
    return sent;
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
  async setPending(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { to?: string[] },
  ) {
    await this.source.assertLive(req.zoneCtx, id, 'marked as awaiting a reply');
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
