import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SettingsService } from './settings.service';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const STATE_TTL_MS = 10 * 60_000;

/**
 * Browser-based Gmail authorisation.
 *
 * Gmail's SMTP ports are blocked by many hosts, so OAuth2 over HTTPS is often
 * the only way to send as a Gmail account. This turns the consent dance into
 * two clicks instead of a command-line script.
 */
@Injectable()
export class GmailOauthService {
  private readonly log = new Logger(GmailOauthService.name);

  /**
   * Pending authorisations, keyed by the OAuth `state` value.
   *
   * Held in memory deliberately: entries live for ten minutes and a restart
   * simply means the operator presses Connect again. The cookie cannot help
   * here because it is SameSite=Strict and Google's redirect is cross-site,
   * so `state` is what ties the callback back to the person who started it.
   */
  private pending = new Map<string, { userId: string; expires: number }>();

  constructor(private readonly settings: SettingsService) {}

  /** The exact URI that must be registered on the Google OAuth client. */
  redirectUri(): string {
    const base = this.settings
      .get<string>('INTERNAL_BASE_URL', '')
      .replace(/\/admin\/?$/, '')
      .replace(/\/$/, '');
    if (!base) {
      throw new BadRequestException(
        'Set the internal portal URL under Portal & URLs first; Google needs an exact redirect address.',
      );
    }
    return `${base}/internal/admin/settings/email/gmail/callback`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
  }

  /** Build the consent URL the operator should visit. */
  begin(userId: string): { url: string; redirectUri: string } {
    this.sweep();
    const clientId = this.settings.get<string>('GMAIL_OAUTH_CLIENT_ID', '');
    if (!clientId) {
      throw new BadRequestException('Save the OAuth client ID and secret first, then press Connect.');
    }
    const redirectUri = this.redirectUri();
    const state = randomBytes(24).toString('base64url');
    this.pending.set(state, { userId, expires: Date.now() + STATE_TTL_MS });

    const url =
      `${AUTH_URL}?` +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        // Google only returns a refresh token on first consent unless forced.
        prompt: 'consent',
        state,
      }).toString();

    return { url, redirectUri };
  }

  /**
   * Exchange the authorisation code for a refresh token and store it.
   * Returns the address that was authorised, for confirmation.
   */
  async complete(code: string, state: string): Promise<{ email: string; userId: string }> {
    this.sweep();
    const entry = state ? this.pending.get(state) : undefined;
    if (!entry) {
      throw new BadRequestException('This authorisation link has expired. Press Connect again.');
    }
    this.pending.delete(state); // single use

    const clientId = this.settings.get<string>('GMAIL_OAUTH_CLIENT_ID', '');
    const clientSecret = this.settings.get<string>('GMAIL_OAUTH_CLIENT_SECRET', '');
    if (!clientId || !clientSecret) {
      throw new BadRequestException('The OAuth client ID and secret are no longer configured.');
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: this.redirectUri(),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      refresh_token?: string;
      access_token?: string;
      error_description?: string;
      error?: string;
    };

    if (!res.ok || !body.refresh_token) {
      const reason = body.error_description ?? body.error ?? `HTTP ${res.status}`;
      this.log.warn(`Gmail token exchange failed: ${reason}`);
      throw new BadRequestException(
        body.refresh_token === undefined && res.ok
          ? 'Google did not return a refresh token. Remove the app from your Google account permissions and try again.'
          : `Google rejected the authorisation: ${reason}`,
      );
    }

    // Identify the mailbox that was actually authorised.
    let email = '';
    try {
      const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { authorization: `Bearer ${body.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await profile.json()) as { emailAddress?: string };
      email = data.emailAddress ?? '';
    } catch {
      /* the refresh token is what matters; the address is a convenience */
    }

    const patch: Record<string, string> = {
      GMAIL_OAUTH_REFRESH_TOKEN: body.refresh_token,
      GMAIL_AUTH: 'oauth2',
      EMAIL_PROVIDER: 'gmail',
    };
    if (email) patch.GMAIL_USER = email;
    await this.settings.updateMany(patch, entry.userId);

    return { email, userId: entry.userId };
  }
}
