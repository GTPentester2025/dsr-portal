import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, ZoneContext } from '../db/db.module';
import { AuditService } from '../audit/audit.service';

export interface GroupMemberInput {
  name: string;
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Standing lists of people outside the portal who can be sent a case.
 *
 * Zone-scoped like everything else, so an approver sees their own zone's
 * groups. Membership is a name and an address: these people never get an
 * account, and nothing here should imply they might.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: ZoneContext) {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT g.id, g.zone_id, g.name, g.default_message, g.active, g.created_at,
                COALESCE(json_agg(json_build_object('id', m.id, 'name', m.name, 'email', m.email)
                         ORDER BY m.name) FILTER (WHERE m.id IS NOT NULL), '[]') AS members
           FROM case_groups g
      LEFT JOIN case_group_members m ON m.group_id = g.id
          GROUP BY g.id
          ORDER BY g.zone_id, g.name`,
      );
      return r.rows;
    });
  }

  /** Members with a usable address, which is who an invitation can reach. */
  async membersOf(ctx: ZoneContext, groupId: string) {
    return this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query(
        `SELECT m.id, m.name, m.email
           FROM case_group_members m
           JOIN case_groups g ON g.id = m.group_id
          WHERE m.group_id = $1 AND g.active
          ORDER BY m.name`,
        [groupId],
      );
      return r.rows as { id: string; name: string; email: string }[];
    });
  }

  async create(
    ctx: ZoneContext,
    args: {
      zoneId: string;
      name: string;
      defaultMessage?: string;
      members: GroupMemberInput[];
      actorId: string;
    },
  ) {
    const name = args.name?.trim();
    if (!name) throw new BadRequestException('The group needs a name');
    const members = this.cleanMembers(args.members);
    if (members.length === 0) {
      throw new BadRequestException('A group with nobody in it cannot be sent anything');
    }

    const group = await this.db.withContext(ctx, async (_db, client) => {
      const g = await client.query(
        `INSERT INTO case_groups (zone_id, name, default_message, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [args.zoneId, name, args.defaultMessage ?? '', args.actorId],
      );
      const id = g.rows[0].id as string;
      for (const m of members) {
        await client.query(
          'INSERT INTO case_group_members (group_id, name, email) VALUES ($1,$2,$3)',
          [id, m.name, m.email],
        );
      }
      return id;
    });

    await this.audit.record({
      actorId: args.actorId,
      actorType: 'user',
      action: 'group.created',
      entityType: 'case_group',
      entityId: group,
      zoneId: args.zoneId,
      after: { name, members: members.map((m) => m.email) },
    });
    return { id: group };
  }

  async update(
    ctx: ZoneContext,
    id: string,
    patch: { name?: string; defaultMessage?: string; active?: boolean; members?: GroupMemberInput[] },
    actorId: string,
  ) {
    const before = await this.db.withContext(ctx, async (_db, client) => {
      const r = await client.query('SELECT * FROM case_groups WHERE id = $1', [id]);
      return r.rows[0];
    });
    if (!before) throw new NotFoundException();

    const members = patch.members ? this.cleanMembers(patch.members) : null;
    if (members && members.length === 0) {
      throw new BadRequestException('A group with nobody in it cannot be sent anything');
    }

    await this.db.withContext(ctx, async (_db, client) => {
      await client.query(
        `UPDATE case_groups SET
           name = COALESCE($2, name),
           default_message = COALESCE($3, default_message),
           active = COALESCE($4, active)
         WHERE id = $1`,
        [id, patch.name?.trim() ?? null, patch.defaultMessage ?? null, patch.active ?? null],
      );
      if (members) {
        // Replaced wholesale: the screen edits the list as a list, and a
        // member removed there has to actually go, or they keep receiving
        // invitations nobody meant to send them.
        await client.query('DELETE FROM case_group_members WHERE group_id = $1', [id]);
        for (const m of members) {
          await client.query(
            'INSERT INTO case_group_members (group_id, name, email) VALUES ($1,$2,$3)',
            [id, m.name, m.email],
          );
        }
      }
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action: 'group.updated',
      entityType: 'case_group',
      entityId: id,
      zoneId: before.zone_id,
      before: { name: before.name, active: before.active },
      after: { ...patch, members: members?.map((m) => m.email) },
    });
    return { ok: true };
  }

  private cleanMembers(members: GroupMemberInput[]): GroupMemberInput[] {
    const seen = new Set<string>();
    const out: GroupMemberInput[] = [];
    for (const m of members ?? []) {
      const email = (m.email ?? '').trim().toLowerCase();
      const name = (m.name ?? '').trim();
      if (!email) continue;
      if (!EMAIL_RE.test(email)) {
        throw new BadRequestException(`${email} is not an email address`);
      }
      if (seen.has(email)) continue;
      seen.add(email);
      out.push({ name: name || email, email });
    }
    return out;
  }
}
