import { NotFoundException, BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { DbService, ZoneContext } from '../db/db.module';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { seesEveryZone } from './permissions';
import { PasswordStrategy, type AuthenticatedIdentity } from './password.strategy';
import { canUsePassword } from './break-glass';

const DEFAULT_IDLE_TIMEOUT_MIN = 30;
const DEFAULT_ABSOLUTE_LIFETIME_H = 8;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'admin' | 'zone_manager' | 'approver' | 'auditor';
  zoneId: string | null;
  /** True after an administrative reset, until the user chooses their own. */
  mustChangePassword?: boolean;
}

export function zoneContextFor(user: SessionUser): ZoneContext {
  // Super admins, admins and auditors see every zone; the rest are pinned.
  // The membership test is shared with `canAssignRole` (ZONE_WIDE_ROLES in
  // permissions.ts) so that a role cannot be zone-wide here while a zone
  // manager is still allowed to create one there.
  //
  // The role itself is passed through unchanged: collapsing super_admin into
  // admin here would make an instance-administration policy inexpressible in
  // the database, because the two would be indistinguishable by the time a
  // query ran.
  if (seesEveryZone(user.role)) {
    return { role: user.role, zone: '*' };
  }
  return { role: user.role, zone: user.zoneId ?? '__none__' };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly password: PasswordStrategy,
  ) {}

  /** Session lifetimes are operator-configurable from the Settings screen. */
  private get idleMinutes(): number {
    return this.settings.getNumber('SESSION_IDLE_MINUTES', DEFAULT_IDLE_TIMEOUT_MIN);
  }

  private get absoluteHours(): number {
    return this.settings.getNumber('SESSION_ABSOLUTE_HOURS', DEFAULT_ABSOLUTE_LIFETIME_H);
  }

  static validatePasswordPolicy(password: string): string | null {
    if (password.length < 14) return 'Password must be at least 14 characters';
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return 'Password must mix upper case, lower case and digits';
    }
    return null;
  }

  static hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3 });
  }

  /**
   * Everything that happens after a strategy has proved who the caller is.
   * Provider-agnostic on purpose: an identity-provider strategy calls this with
   * its own `via`, so there is one place that creates a session and one place
   * that records a successful sign-in.
   */
  async startSession(
    identity: AuthenticatedIdentity,
    ip: string,
    via: string,
  ): Promise<{ sessionId: string; user: SessionUser }> {
    const sessionId = randomBytes(32).toString('base64url');
    await this.db.system(async (_db, client) => {
      await client.query(
        `INSERT INTO internal_sessions (id, user_id, absolute_expires_at, source_ip)
         VALUES ($1, $2, now() + interval '${this.absoluteHours} hours', $3)`,
        [sessionId, identity.id, ip],
      );
    });
    await this.audit.record({
      actorId: identity.id,
      actorType: 'user',
      action: 'auth.login',
      entityType: 'user',
      entityId: identity.id,
      after: { via },
      sourceIp: ip,
    });
    return {
      sessionId,
      user: {
        id: identity.id,
        email: identity.email,
        name: identity.name,
        role: identity.role,
        zoneId: identity.zoneId,
      },
    };
  }

  async login(email: string, password: string, ip: string): Promise<{ sessionId: string; user: SessionUser }> {
    const identity = await this.password.authenticate(email, password, ip);
    if (!identity) throw new UnauthorizedException('Invalid credentials');

    // Policy AFTER authentication, never before: checking first would tell an
    // unauthenticated caller which accounts keep a password.
    const ssoEnabled = this.settings.get<string>('SSO_ENABLED', 'false') === 'true';
    const refusal = canUsePassword(identity, ssoEnabled);
    if (refusal) {
      await this.audit.record({
        actorId: identity.id,
        actorType: 'user',
        action: 'auth.login_refused_sso',
        entityType: 'user',
        entityId: identity.id,
        sourceIp: ip,
      });
      throw new UnauthorizedException(refusal);
    }

    return this.startSession(identity, ip, 'password');
  }

  /** Validates idle + absolute timeouts, touches last_seen, returns the user. */
  async resolveSession(sessionId: string): Promise<SessionUser | null> {
    if (!sessionId || !/^[A-Za-z0-9_-]{40,50}$/.test(sessionId)) return null;
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `UPDATE internal_sessions s
            SET last_seen_at = now()
          FROM users u
         WHERE s.id = $1
           AND u.id = s.user_id
           AND s.revoked_at IS NULL
           AND s.absolute_expires_at > now()
           AND s.last_seen_at > now() - interval '${this.idleMinutes} minutes'
           AND u.active
        RETURNING u.id, u.email, u.name, u.role, u.zone_id, u.must_change_password`,
        [sessionId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        zoneId: row.zone_id,
        mustChangePassword: row.must_change_password === true,
      };
    });
  }

  /**
   * Change your own password.
   *
   * The current password is required unless the account is flagged by an
   * administrative reset — in that case the temporary password the admin handed
   * over is the current one, and requiring it again adds nothing.
   *
   * Every other session for the user is revoked: if the reason for changing is
   * that someone else knew the old password, leaving their session alive would
   * defeat the change.
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId: string,
    ip: string,
  ): Promise<{ ok: true }> {
    const problem = AuthService.validatePasswordPolicy(newPassword);
    if (problem) throw new BadRequestException(problem);

    const row = await this.db.system(async (_db, client) => {
      const res = await client.query(
        'SELECT password_hash, must_change_password FROM users WHERE id = $1',
        [userId],
      );
      return res.rows[0];
    });
    if (!row) throw new UnauthorizedException();

    if (!row.must_change_password) {
      const ok = await argon2.verify(row.password_hash ?? '', currentPassword).catch(() => false);
      if (!ok) throw new UnauthorizedException('Current password is incorrect');
    }
    if (row.password_hash && (await argon2.verify(row.password_hash, newPassword).catch(() => false))) {
      throw new BadRequestException('The new password must be different from the current one');
    }

    const hash = await AuthService.hashPassword(newPassword);
    await this.db.system(async (_db, client) => {
      await client.query(
        `UPDATE users
            SET password_hash = $2, must_change_password = false, password_set_at = now()
          WHERE id = $1`,
        [userId, hash],
      );
      await client.query(
        'UPDATE internal_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
        [userId, keepSessionId],
      );
    });
    await this.audit.record({
      actorId: userId,
      actorType: 'user',
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: userId,
      sourceIp: ip,
    });
    return { ok: true };
  }

  /**
   * Issue a one-time password for another user.
   *
   * Returns the plaintext exactly once, to the administrator who asked. It is
   * never stored in readable form and cannot be retrieved again — only what is
   * hashed goes to the database. All of that user's sessions are revoked, so a
   * reset also cuts off anyone currently signed in as them.
   */
  /**
   * Credentials for an account that has never had any.
   *
   * Mechanically identical to a reset, recorded differently: "password reset"
   * on an account that never had a password misreads the history, and the
   * distinction matters when someone is reconstructing who could sign in when.
   */
  async issueInitialPassword(
    targetUserId: string,
    actorId: string,
    ip: string,
  ): Promise<{ temporaryPassword: string; email: string; name: string }> {
    return this.setPasswordFor(targetUserId, actorId, ip, 'auth.credentials_issued');
  }

  async resetPasswordFor(
    targetUserId: string,
    actorId: string,
    ip: string,
  ): Promise<{ temporaryPassword: string; email: string; name: string }> {
    return this.setPasswordFor(targetUserId, actorId, ip, 'auth.password_reset');
  }

  private async setPasswordFor(
    targetUserId: string,
    actorId: string,
    ip: string,
    action: 'auth.password_reset' | 'auth.credentials_issued',
  ): Promise<{ temporaryPassword: string; email: string; name: string }> {
    const user = await this.db.system(async (_db, client) => {
      const res = await client.query('SELECT id, email, name FROM users WHERE id = $1', [targetUserId]);
      return res.rows[0];
    });
    if (!user) throw new NotFoundException('No such user');

    const temporaryPassword = generateTemporaryPassword();
    const hash = await AuthService.hashPassword(temporaryPassword);

    await this.db.system(async (_db, client) => {
      await client.query(
        `UPDATE users
            SET password_hash = $2, must_change_password = true, password_set_at = now()
          WHERE id = $1`,
        [targetUserId, hash],
      );
      await client.query(
        'UPDATE internal_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [targetUserId],
      );
    });

    await this.audit.record({
      actorId,
      actorType: 'user',
      action,
      entityType: 'user',
      entityId: targetUserId,
      sourceIp: ip,
      // Deliberately records that a reset happened, never the value.
      after: { email: user.email, sessionsRevoked: true },
    });

    return { temporaryPassword, email: user.email, name: user.name };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.system(async (_db, client) => {
      await client.query(`UPDATE internal_sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
    });
  }
}

/**
 * A temporary password that is strong but can be read aloud or typed without
 * ambiguity: no characters that look alike (0/O, 1/l/I), grouped for legibility.
 */
function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
