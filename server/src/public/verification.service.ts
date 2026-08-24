import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { and, eq, isNull } from 'drizzle-orm';
import { DbService } from '../db/db.module';
import { formDrafts, verificationTokens } from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { EMAIL_PROVIDER, type EmailProvider } from '../email/email-provider.interface';
import { RateLimitService } from './rate-limit.service';
import { Inject } from '@nestjs/common';

const TOKEN_TTL_MINUTES = 15;
const DRAFT_TTL_HOURS = 24;
/** Uniform response floor (spec §3: no timing side channel). */
const MIN_RESPONSE_MS = 400;
/**
 * Hard ceiling on the whole attempt. A blocked SMTP port would otherwise keep
 * the socket open until the reverse proxy returns a gateway timeout, which
 * looks to the requester like the button does nothing.
 */
const MAX_SEND_MS = 12_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

@Injectable()
export class VerificationService {
  private readonly log = new Logger(VerificationService.name);

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly rate: RateLimitService,
    private readonly config: SettingsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async createDraft(formKey: string, sessionId: string): Promise<{ draftId: string }> {
    const expiresAt = new Date(Date.now() + DRAFT_TTL_HOURS * 3600_000);
    return this.db.system(async (db) => {
      const [row] = await db
        .insert(formDrafts)
        .values({ formKey, sessionId, expiresAt })
        .returning({ id: formDrafts.id });
      return { draftId: row.id };
    });
  }

  /**
   * Always resolves to the same uniform result after a padded delay,
   * whatever happened internally (rate-limited, bad captcha, send failure).
   */
  async sendVerification(args: {
    draftId: string;
    email: string;
    sessionId: string;
    ip: string;
    captchaToken?: string;
    language?: string;
  }): Promise<{ status: 'accepted' }> {
    const started = Date.now();
    try {
      await Promise.race([
        this.trySend(args),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`send exceeded ${MAX_SEND_MS}ms`)), MAX_SEND_MS),
        ),
      ]);
    } catch (err) {
      // Deliberately swallowed: uniform response, no enumeration surface.
      this.log.warn(`verification send suppressed error: ${(err as Error).message}`);
    }
    const elapsed = Date.now() - started;
    if (elapsed < MIN_RESPONSE_MS) {
      await new Promise((r) => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    }
    return { status: 'accepted' };
  }

  private async trySend(args: {
    draftId: string;
    email: string;
    sessionId: string;
    ip: string;
    captchaToken?: string;
    language?: string;
  }): Promise<void> {
    const email = args.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 320) {
      this.log.warn('verification not sent: address failed validation');
      return;
    }

    if (!(await this.verifyCaptcha(args.captchaToken, args.ip))) {
      this.log.warn(`verification not sent: CAPTCHA rejected for ${args.ip}`);
      return;
    }

    const perEmail = this.config.getNumber('VERIFY_EMAIL_RATE_LIMIT', 3);
    const perIp = this.config.getNumber('VERIFY_IP_RATE_LIMIT', 10);
    const emailOk = await this.rate.consume(`verify-email:${this.crypto.lookupHmac(email)}`, perEmail);
    const ipOk = await this.rate.consume(`verify-ip:${args.ip}`, perIp);
    if (!emailOk || !ipOk) {
      // Named precisely so an operator can tell which limit to raise, and told
      // where to raise it. The requester still sees the uniform response.
      const which = !emailOk
        ? `address limit of ${perEmail}/hour (VERIFY_EMAIL_RATE_LIMIT)`
        : `IP limit of ${perIp}/hour for ${args.ip} (VERIFY_IP_RATE_LIMIT)`;
      this.log.warn(
        `verification not sent: hit the ${which}. Raise it under Settings, Security, or wait for the hour to roll over.`,
      );
      return;
    }

    const token = this.crypto.randomToken(32); // 256 bits CSPRNG
    const tokenHash = this.crypto.sha256Hex(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);

    const ok = await this.db.system(async (db) => {
      const draft = await db.query.formDrafts.findFirst({
        where: and(eq(formDrafts.id, args.draftId), eq(formDrafts.sessionId, args.sessionId)),
      });
      if (!draft) {
        // Drafts are keyed to the browser session, so this is what a blocked or
        // dropped cookie looks like from the server side.
        this.log.warn(
          `verification not sent: no draft ${args.draftId} for this session — the session cookie was missing or did not match`,
        );
        return false;
      }
      if (draft.expiresAt < new Date()) {
        this.log.warn(`verification not sent: draft ${args.draftId} expired at ${draft.expiresAt.toISOString()}`);
        return false;
      }
      await db.insert(verificationTokens).values({
        tokenHash,
        draftId: args.draftId,
        sessionId: args.sessionId,
        email,
        expiresAt,
      });
      return true;
    });
    if (!ok) return;

    const base = this.config.get<string>('PUBLIC_BASE_URL', 'http://127.0.0.1:3000');
    // Only in production: local development legitimately runs on localhost, and
    // refusing there would break the dev loop and the e2e suite.
    if (process.env.NODE_ENV === 'production' && isUnreachableBase(base)) {
      this.log.error(
        `verification link would point at ${base}, which no requester can open. ` +
          'Set the public portal address under Settings, Portal and URLs. Sending anyway ' +
          'would produce a dead link.',
      );
      return;
    }
    // Deliver out of band: the token is already stored, so the requester gets
    // an immediate answer even when the provider is slow or unreachable.
    void this.email
      .sendTransactional(email, 'verify-email', {
        verification_url: `${base}/public/verification/consume?token=${token}`,
        ttl_minutes: String(TOKEN_TTL_MINUTES),
      // Answer in the language the form was filled in.
      }, { language: args.language })
      .then(() => this.log.log('verification email dispatched'))
      .catch((err: Error) =>
        this.log.error(
          `verification email could not be delivered: ${err.message}. ` +
            'Check Settings, Email delivery, and run the SMTP check.',
        ),
      );
  }

  /**
   * Consume a magic link. Atomic single-use: the UPDATE claims the token,
   * a replay sees zero affected rows and gets the generic message.
   */
  async consumeToken(rawToken: string): Promise<boolean> {
    if (!rawToken || rawToken.length > 200) return false;
    const tokenHash = this.crypto.sha256Hex(rawToken);
    return this.db.system(async (_db, client) => {
      const res = await client.query(
        `UPDATE verification_tokens
           SET consumed_at = now()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING draft_id, session_id, email`,
        [tokenHash],
      );
      if (res.rowCount !== 1) return false;
      const { draft_id, email } = res.rows[0];
      await client.query(
        `UPDATE form_drafts SET verified_email = $1, verified_at = now() WHERE id = $2`,
        [email, draft_id],
      );
      return true;
    });
  }

  /** Poll endpoint for the originating browser session. */
  async draftStatus(draftId: string, sessionId: string): Promise<{ verified: boolean }> {
    return this.db.system(async (db) => {
      const draft = await db.query.formDrafts.findFirst({
        where: and(
          eq(formDrafts.id, draftId),
          eq(formDrafts.sessionId, sessionId),
        ),
      });
      return { verified: Boolean(draft?.verifiedAt) };
    });
  }

  /** Changing email after verification invalidates the flag (spec §3.5). */
  async requireVerified(draftId: string, sessionId: string, email: string): Promise<boolean> {
    return this.db.system(async (db) => {
      const draft = await db.query.formDrafts.findFirst({
        where: and(eq(formDrafts.id, draftId), eq(formDrafts.sessionId, sessionId)),
      });
      if (!draft?.verifiedAt || !draft.verifiedEmail) return false;
      return draft.verifiedEmail === email.trim().toLowerCase();
    });
  }

  private async verifyCaptcha(token: string | undefined, ip: string): Promise<boolean> {
    const secret = this.config.get<string>('TURNSTILE_SECRET');
    if (!secret) return true; // dev mode: captcha not configured
    if (!token) return false;
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      });
      const data = (await res.json()) as { success: boolean };
      return data.success;
    } catch {
      return false;
    }
  }
}

/**
 * A base URL that only resolves on the server itself. Sending a link to one of
 * these is worse than failing: the requester gets a message that looks correct
 * and cannot be acted on.
 */
function isUnreachableBase(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    // Not a parseable URL at all, which is equally unusable.
    return true;
  }
}
