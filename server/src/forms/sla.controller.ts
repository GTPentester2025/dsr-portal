import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Ip,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { DbService } from '../db/db.module';
import { AuditService } from '../audit/audit.service';

const ZONES = new Set(['EUR', 'SAZ', 'MAZ']);

/** Request types the SLA matrix can be keyed on; '*' is the zone fallback. */
export const REQUEST_TYPES = [
  { value: '*', label: 'All request types (fallback)' },
  { value: 'access', label: 'Access' },
  { value: 'erasure', label: 'Deletion of personal data' },
  { value: 'rectify', label: 'Rectification' },
  { value: 'port', label: 'Data portability' },
  { value: 'object', label: 'Object to processing' },
  { value: 'restrict-process', label: 'Restrict processing' },
  { value: 'opt-out', label: 'Consent withdrawal / opt-out' },
  { value: 'confirmation', label: 'Confirmation of processing' },
  { value: 'other', label: 'Other' },
];

/** Units the UI may express an SLA target in. Storage is always minutes. */
const UNIT_MINUTES: Record<string, number> = { minutes: 1, hours: 60, days: 1440 };
/** One year. Long enough for any real policy, short enough to catch a typo. */
const MAX_TARGET_MINUTES = 525_600;

interface PolicyBody {
  targetValue?: number;
  targetUnit?: 'minutes' | 'hours' | 'days';
  /** Legacy field, still accepted so older clients keep working. */
  targetDays?: number;
  businessDays?: boolean;
  timezone?: string;
  holidays?: string[];
  pauseAllowed?: boolean;
  extensionAllowedDays?: number;
  reminderThresholds?: number[];
  escalationThreshold?: number;
}

@Controller('internal/sla-policies')
@UseGuards(AuthGuard)
export class SlaPolicyController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private assertZone(req: AuthedRequest, zone: string) {
    if (!ZONES.has(zone)) throw new BadRequestException('Unknown zone');
    if (req.user.role === 'zone_manager' && req.user.zoneId !== zone) {
      throw new ForbiddenException('You can only change SLAs for your own zone');
    }
  }

  @Get()
  @Requires('config.manage')
  async list(@Req() req: AuthedRequest) {
    // The SLA matrix lists every zone's policies for an administrator; these
    // rows are configuration, not case data.
    const rows = await this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT id, zone_id, request_type, target_minutes, business_days, timezone,
                holidays, pause_allowed, extension_allowed_days,
                reminder_thresholds, escalation_threshold
           FROM sla_policies
          ORDER BY zone_id, (request_type = '*') DESC, request_type`,
      );
      return res.rows;
    });
    const scoped =
      req.user.role === 'zone_manager' ? rows.filter((r) => r.zone_id === req.user.zoneId) : rows;
    return { policies: scoped, requestTypes: REQUEST_TYPES };
  }

  @Put(':zone/:requestType')
  @Requires('config.manage')
  async upsert(
    @Req() req: AuthedRequest,
    @Param('zone') zone: string,
    @Param('requestType') requestType: string,
    @Body() body: PolicyBody,
    @Ip() ip: string,
  ) {
    this.assertZone(req, zone);
    if (!REQUEST_TYPES.some((t) => t.value === requestType)) {
      throw new BadRequestException('Unknown request type');
    }

    const targetMinutes = resolveTargetMinutes(body);
    const extension = Number(body.extensionAllowedDays ?? 0);
    if (!Number.isInteger(extension) || extension < 0 || extension > 365) {
      throw new BadRequestException('Extension allowance must be between 0 and 365 days');
    }
    const thresholds = body.reminderThresholds ?? [0.75, 0.9, 1];
    if (
      !Array.isArray(thresholds) ||
      thresholds.some((t) => typeof t !== 'number' || t <= 0 || t > 2)
    ) {
      throw new BadRequestException('Reminder thresholds must be fractions of the SLA, such as 0.75');
    }
    const escalation = Number(body.escalationThreshold ?? 0.9);
    if (!Number.isFinite(escalation) || escalation <= 0 || escalation > 2) {
      throw new BadRequestException('Escalation threshold must be a fraction of the SLA');
    }
    const holidays = body.holidays ?? [];
    if (!Array.isArray(holidays) || holidays.some((h) => !/^\d{4}-\d{2}-\d{2}$/.test(String(h)))) {
      throw new BadRequestException('Holidays must be ISO dates such as 2026-12-25');
    }

    const before = await this.db.withContext(req.zoneCtx, async (_db, client) => {
      const res = await client.query(
        'SELECT * FROM sla_policies WHERE zone_id = $1 AND request_type = $2',
        [zone, requestType],
      );
      return res.rows[0];
    });

    await this.db.withContext(req.zoneCtx, async (_db, client) => {
      await client.query(
        `INSERT INTO sla_policies
           (zone_id, request_type, target_minutes, business_days, timezone, holidays,
            pause_allowed, extension_allowed_days, reminder_thresholds, escalation_threshold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (zone_id, request_type) DO UPDATE SET
           target_minutes = EXCLUDED.target_minutes,
           business_days = EXCLUDED.business_days,
           timezone = EXCLUDED.timezone,
           holidays = EXCLUDED.holidays,
           pause_allowed = EXCLUDED.pause_allowed,
           extension_allowed_days = EXCLUDED.extension_allowed_days,
           reminder_thresholds = EXCLUDED.reminder_thresholds,
           escalation_threshold = EXCLUDED.escalation_threshold`,
        [
          zone,
          requestType,
          targetMinutes,
          Boolean(body.businessDays),
          body.timezone || 'UTC',
          JSON.stringify(holidays),
          Boolean(body.pauseAllowed),
          extension,
          JSON.stringify(thresholds),
          JSON.stringify(escalation),
        ],
      );
    });

    await this.audit.record({
      actorId: req.user.id,
      actorType: 'user',
      action: before ? 'sla_policy.updated' : 'sla_policy.created',
      entityType: 'sla_policy',
      entityId: `${zone}:${requestType}`,
      zoneId: zone,
      before: before
        ? { targetMinutes: before.target_minutes, businessDays: before.business_days }
        : undefined,
      after: { targetMinutes, businessDays: Boolean(body.businessDays), extension },
      sourceIp: ip,
    });

    return { ok: true };
  }

  @Delete(':zone/:requestType')
  @Requires('config.manage')
  async remove(
    @Req() req: AuthedRequest,
    @Param('zone') zone: string,
    @Param('requestType') requestType: string,
    @Ip() ip: string,
  ) {
    this.assertZone(req, zone);
    if (requestType === '*') {
      throw new BadRequestException('The fallback policy for a zone cannot be removed');
    }
    await this.db.withContext(req.zoneCtx, async (_db, client) => {
      await client.query('DELETE FROM sla_policies WHERE zone_id = $1 AND request_type = $2', [
        zone,
        requestType,
      ]);
    });
    await this.audit.record({
      actorId: req.user.id,
      actorType: 'user',
      action: 'sla_policy.deleted',
      entityType: 'sla_policy',
      entityId: `${zone}:${requestType}`,
      zoneId: zone,
      sourceIp: ip,
    });
    return { ok: true };
  }
}

/**
 * Resolve a target into minutes.
 *
 * Accepts either the current {targetValue, targetUnit} pair or the legacy
 * targetDays. Rejecting a fractional value matters: 1.5 hours silently
 * truncating to 1 would make a policy quietly wrong.
 */
function resolveTargetMinutes(body: PolicyBody): number {
  let minutes: number;
  if (body.targetValue !== undefined) {
    const unit = body.targetUnit ?? 'days';
    const factor = UNIT_MINUTES[unit];
    if (!factor) {
      throw new BadRequestException('Target unit must be minutes, hours or days');
    }
    const value = Number(body.targetValue);
    if (!Number.isInteger(value) || value < 1) {
      throw new BadRequestException('Target duration must be a whole number of ' + unit);
    }
    minutes = value * factor;
  } else {
    const days = Number(body.targetDays);
    if (!Number.isInteger(days) || days < 1) {
      throw new BadRequestException('Target duration is required');
    }
    minutes = days * 1440;
  }
  if (minutes > MAX_TARGET_MINUTES) {
    throw new BadRequestException('Target duration cannot exceed one year');
  }
  return minutes;
}
