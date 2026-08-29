import { BadRequestException, Body, Controller, Get, Ip, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard, Requires } from '../auth/auth.guard';
import type { Response } from 'express';
import { toCsv, csvFilename } from '../cases/csv';
import { AuthService } from '../auth/auth.service';
import type { AuthedRequest } from '../auth/auth.guard';
import { DbService } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import { canAssignRole } from '../auth/admin-policy';
import type { Role } from '../auth/permissions';

const ROLES = new Set(['super_admin', 'admin', 'zone_manager', 'approver', 'auditor']);
const ZONES = new Set(['EUR', 'SAZ', 'MAZ']);

/** Team membership + assignment strategy administration (spec §6, §11). */
@Controller('internal/admin')
@UseGuards(AuthGuard)
export class AdminUsersController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  @Get('users')
  @Requires('team.manage')
  async listUsers(@Req() req: AuthedRequest, @Query('zone') zone?: string) {
    // Zone managers only see their own zone's team.
    const effectiveZone = req.user.role === 'zone_manager' ? req.user.zoneId : zone;
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT id, email, name, role, zone_id, active, capacity_weight,
                ooo_from, ooo_to, is_break_glass, created_at,
                (password_hash IS NOT NULL) AS has_password
           FROM users
          WHERE ($1::text IS NULL OR zone_id = $1)
          ORDER BY zone_id NULLS FIRST, name`,
        [effectiveZone ?? null],
      );
      return res.rows;
    });
  }

  @Post('users')
  @Requires('team.manage')
  async createUser(
    @Req() req: AuthedRequest,
    @Body() body: {
      email: string; name: string; role: string; zoneId?: string;
      capacityWeight?: number;
    },
    @Ip() ip: string,
  ) {
    if (!body?.email || !body?.name || !ROLES.has(body?.role)) {
      throw new BadRequestException('email, name and a valid role are required');
    }
    if (body.zoneId && !ZONES.has(body.zoneId)) throw new BadRequestException('bad zone');
    const refusal = canAssignRole(
      { role: req.user.role, zoneId: req.user.zoneId },
      body.role as Role,
      body.zoneId ?? null,
    );
    if (refusal) throw new BadRequestException(refusal);
    const row = await this.db.system(async (_db, client) => {
      const res = await client.query(
        `INSERT INTO users (email, name, role, zone_id, capacity_weight)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [body.email.toLowerCase(), body.name, body.role, body.zoneId ?? null, body.capacityWeight ?? 1],
      );
      return res.rows[0];
    });
    await this.audit.record({
      actorId: req.user.id, actorType: 'user', action: 'user.created',
      entityType: 'user', entityId: row.id, after: { ...body },
    });

    // Issue credentials as part of creating the account.
    //
    // Without this the row is active and immediately assignable — it collects
    // cases and assignment emails — while having no password and no invite, so
    // the person cannot sign in to the work being given to them. That state
    // existed unnoticed in production for two approvers holding 15 open cases.
    // The password is returned exactly once, to whoever created the account.
    const credentials = await this.auth.issueInitialPassword(row.id, req.user.id, ip);
    return { ...row, temporaryPassword: credentials.temporaryPassword };
  }

  @Patch('users/:id')
  @Requires('team.manage')
  async updateUser(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      name?: string; role?: string; zoneId?: string | null; active?: boolean;
      capacityWeight?: number; oooFrom?: string | null; oooTo?: string | null;
    },
  ) {
    if (body?.role && !ROLES.has(body.role)) throw new BadRequestException('bad role');
    const before = await this.db.system(async (_db, client) => {
      const res = await client.query(`SELECT * FROM users WHERE id = $1`, [id]);
      return res.rows[0];
    });
    if (!before) throw new BadRequestException('user not found');
    if (req.user.role === 'zone_manager' && before.zone_id !== req.user.zoneId) {
      throw new BadRequestException('Zone managers can only manage their own zone');
    }
    // The resulting role and zone, not just the current ones: a zone manager
    // must not be able to move a user they administer into another zone.
    const refusal = canAssignRole(
      { role: req.user.role, zoneId: req.user.zoneId },
      (body.role ?? before.role) as Role,
      body.zoneId !== undefined ? body.zoneId : before.zone_id,
    );
    if (refusal) throw new BadRequestException(refusal);
    await this.db.system(async (_db, client) => {
      await client.query(
        `UPDATE users SET
           name = COALESCE($2, name),
           role = COALESCE($3, role),
           zone_id = CASE WHEN $4::boolean THEN $5 ELSE zone_id END,
           active = COALESCE($6, active),
           capacity_weight = COALESCE($7, capacity_weight),
           ooo_from = CASE WHEN $8::boolean THEN $9::timestamptz ELSE ooo_from END,
           ooo_to = CASE WHEN $8::boolean THEN $10::timestamptz ELSE ooo_to END
         WHERE id = $1`,
        [
          id, body.name ?? null, body.role ?? null,
          body.zoneId !== undefined, body.zoneId ?? null,
          body.active ?? null, body.capacityWeight ?? null,
          body.oooFrom !== undefined || body.oooTo !== undefined,
          body.oooFrom ?? null, body.oooTo ?? null,
        ],
      );
    });
    await this.audit.record({
      actorId: req.user.id, actorType: 'user', action: 'user.updated',
      entityType: 'user', entityId: id,
      before: { role: before.role, active: before.active, zoneId: before.zone_id },
      after: { ...body },
    });
    return { ok: true };
  }

  // ---- assignment strategy / zone config ---------------------------------

  /**
   * Zone managers see only their own zone.
   *
   * The PATCH below already refuses a cross-zone write, so this was not a way
   * in — but listing every zone's escalation contact and strategy to a manager
   * who cannot act on it is disclosure without purpose.
   */
  @Get('assignment-config')
  @Requires('team.manage')
  getAssignmentConfig(@Req() req: AuthedRequest) {
    const ownZone = req.user.role === 'zone_manager' ? req.user.zoneId : null;
    return this.db.system(async (_db, client) => {
      const res = ownZone
        ? await client.query(
            `SELECT * FROM assignment_config WHERE zone_id = $1 ORDER BY zone_id`,
            [ownZone],
          )
        : await client.query(`SELECT * FROM assignment_config ORDER BY zone_id`);
      return res.rows;
    });
  }

  /**
   * Issue a one-time password for a user.
   *
   * Stored passwords are argon2id hashes, so there is nothing to reveal; this
   * is the supported way to get somebody back into their account. The value is
   * returned once, to the super administrator who asked, and is never
   * retrievable afterwards. Restricted to super_admin because it grants
   * immediate access to another person's account.
   */
  @Post('users/:id/reset-password')
  @Requires('instance.administer')
  async resetPassword(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.auth.resetPasswordFor(id, req.user.id, ip);
  }

  @Patch('assignment-config/:zone')
  @Requires('team.manage')
  async setAssignmentConfig(
    @Req() req: AuthedRequest,
    @Param('zone') zone: string,
    @Body()
    body: {
      strategy?: string;
      escalationEmail?: string;
      escalationAfterValue?: number;
      escalationAfterUnit?: 'minutes' | 'hours' | 'days';
    },
  ) {
    if (!ZONES.has(zone)) throw new BadRequestException('bad zone');
    if (req.user.role === 'zone_manager' && req.user.zoneId !== zone) {
      throw new BadRequestException('Zone managers can only manage their own zone');
    }
    const strategies = new Set(['round_robin', 'least_open', 'weighted', 'manual']);
    if (body?.strategy && !strategies.has(body.strategy)) {
      throw new BadRequestException('bad strategy');
    }

    // Stored in minutes so a delay can be rehearsed in minutes rather than
    // waiting out a two-day default.
    const unitMinutes: Record<string, number> = { minutes: 1, hours: 60, days: 1440 };
    let escalationAfterMinutes: number | null = null;
    if (body.escalationAfterValue !== undefined) {
      const factor = unitMinutes[body.escalationAfterUnit ?? 'hours'];
      if (!factor) throw new BadRequestException('Unit must be minutes, hours or days');
      const value = Number(body.escalationAfterValue);
      if (!Number.isInteger(value) || value < 1 || value * factor > 525_600) {
        throw new BadRequestException('Escalation delay must be a whole number, up to one year');
      }
      escalationAfterMinutes = value * factor;
    }
    await this.db.system(async (_db, client) => {
      await client.query(
        `UPDATE assignment_config SET
           strategy = COALESCE($2, strategy),
           escalation_email = COALESCE($3, escalation_email),
           escalation_after_minutes = COALESCE($4, escalation_after_minutes)
         WHERE zone_id = $1`,
        [zone, body.strategy ?? null, body.escalationEmail ?? null, escalationAfterMinutes],
      );
    });
    await this.audit.record({
      actorId: req.user.id, actorType: 'user', action: 'assignment_config.updated',
      entityType: 'zone', entityId: zone, after: { ...body },
    });
    return { ok: true };
  }

  // ---- audit log viewer ---------------------------------------------------

  /** The team roster as a spreadsheet. */
  @Get('users/export.csv')
  @Requires('team.manage')
  async exportUsers(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rows = await this.db.system(async (_db, client) => {
      const q = await client.query(
        `SELECT name, email, role, zone_id, active, capacity_weight, ooo_from, ooo_to, created_at
           FROM users ORDER BY role, name`,
      );
      return q.rows as Record<string, unknown>[];
    });
    // A zone manager sees only their own zone on screen; the export must match.
    const scoped =
      req.user.role === 'zone_manager'
        ? rows.filter((r) => r.zone_id === req.user.zoneId)
        : rows;

    const csv = toCsv(scoped, [
      { header: 'Name', value: (r) => r.name },
      { header: 'Email', value: (r) => r.email },
      { header: 'Role', value: (r) => r.role },
      { header: 'Zone', value: (r) => r.zone_id },
      { header: 'Active', value: (r) => (r.active ? 'yes' : 'no') },
      { header: 'Capacity weight', value: (r) => r.capacity_weight },
      { header: 'Out of office from', value: (r) => r.ooo_from },
      { header: 'Out of office to', value: (r) => r.ooo_to },
      { header: 'Created', value: (r) => r.created_at },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('team')}"`);
    return csv;
  }

  /** The audit trail as a spreadsheet, for evidencing to a regulator. */
  @Get('audit-log/export.csv')
  @Requires('audit.read')
  async exportAudit(
    @Res({ passthrough: true }) res: Response,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
  ) {
    const rows = await this.db.system(async (_db, client) => {
      const q = await client.query(
        `SELECT a.created_at, a.action, a.entity_type, a.entity_id, a.zone_id,
                a.actor_type, a.source_ip, a.before, a.after,
                u.name AS actor_name, u.email AS actor_email
           FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_id
          WHERE ($1::text IS NULL OR a.entity_type = $1)
            AND ($2::text IS NULL OR a.entity_id = $2)
          ORDER BY a.created_at DESC
          LIMIT 10000`,
        [entityType ?? null, entityId ?? null],
      );
      return q.rows as Record<string, unknown>[];
    });

    const csv = toCsv(rows, [
      { header: 'When', value: (r) => r.created_at },
      { header: 'Action', value: (r) => r.action },
      { header: 'Actor', value: (r) => r.actor_name ?? r.actor_type },
      { header: 'Actor email', value: (r) => r.actor_email },
      { header: 'Entity type', value: (r) => r.entity_type },
      { header: 'Entity', value: (r) => r.entity_id },
      { header: 'Zone', value: (r) => r.zone_id },
      { header: 'Source IP', value: (r) => r.source_ip },
      { header: 'Before', value: (r) => r.before },
      { header: 'After', value: (r) => r.after },
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFilename('audit-log')}"`);
    return csv;
  }

  @Get('audit-log')
  @Requires('audit.read')
  auditLog(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT * FROM audit_log
          WHERE ($1::text IS NULL OR entity_type = $1)
            AND ($2::text IS NULL OR entity_id = $2)
          ORDER BY id DESC LIMIT ${n}`,
        [entityType ?? null, entityId ?? null],
      );
      return res.rows;
    });
  }
}
