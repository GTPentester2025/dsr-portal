import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DbService } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import type { Role } from './permissions';

/** What any authentication strategy returns once it has proved who the caller is. */
export interface AuthenticatedIdentity {
  id: string;
  email: string;
  name: string;
  role: Role;
  zoneId: string | null;
  mustChangePassword: boolean;
  isBreakGlass: boolean;
}

/**
 * The only code in the portal that knows a password exists.
 *
 * Everything downstream of a successful authentication — session creation, the
 * audit entry, the SessionUser shape — lives in AuthService.startSession and is
 * shared with any future strategy.
 */
@Injectable()
export class PasswordStrategy {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async authenticate(email: string, password: string, ip: string): Promise<AuthenticatedIdentity | null> {
    const norm = email.trim().toLowerCase();
    const row = await this.db.system(async (_db, client) => {
      const res = await client.query(
        `SELECT id, email, name, role, zone_id, active, password_hash,
                must_change_password, is_break_glass
           FROM users WHERE lower(email) = $1`,
        [norm],
      );
      return res.rows[0];
    });

    // Verify against a dummy hash when the user is unknown → no timing oracle.
    const hash =
      row?.password_hash ??
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$5vEDiXTDJWjhAfXpNZ92K2wZG2I5PpP0S3RTZ2VNjHY';
    const valid = await argon2.verify(hash, password).catch(() => false);
    if (!row || !row.active || !row.password_hash || !valid) {
      await this.audit.record({
        actorType: 'user',
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: row?.id,
        sourceIp: ip,
      });
      return null;
    }

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      zoneId: row.zone_id,
      mustChangePassword: row.must_change_password === true,
      isBreakGlass: row.is_break_glass === true,
    };
  }
}
