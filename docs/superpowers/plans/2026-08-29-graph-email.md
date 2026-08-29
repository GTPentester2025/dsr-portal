# Graph-Only Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Microsoft Graph the only production email adapter, configured entirely from the environment file, with a boot-time guard and a one-command confirmation over SSH.

**Architecture:** `EmailDispatcher` stays as the single seam; provider selection stops being runtime-mutable database state and becomes environment configuration via a new `envOnly` flag on the settings catalog. Gmail, SMTP and Resend adapters are deleted, taking `googleapis` and `nodemailer` with them. A pure `missingEmailKeys()` runs before `app.listen()` so a missing credential stops the service instead of silently dropping the first data-subject email.

**Tech Stack:** NestJS 11, TypeScript (strict), Jest 30, node-postgres, Drizzle, Vite/React admin SPA. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-graph-email-design.md`

## Global Constraints

- **No new dependencies.** This plan only removes them: `googleapis`, `nodemailer`, `@types/nodemailer`.
- **Tests are colocated** `*.spec.ts` next to the source, run with `npm --prefix server test`. Existing specs are pure-function tests with no Nest `TestingModule`; follow that. Do not introduce a DB-backed test harness.
- **Commit style matches this repo:** an imperative sentence, no `feat:`/`fix:` prefix. See `git log --oneline`. Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NtXEr3cBGDqXwFLmPnFVye
  ```
- **`EMAIL_PROVIDER` accepts exactly `graph` and `console`.** Catalog default `graph`.
- **Required Graph keys:** `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `PRIVACY_MAILBOX`.
- **Env file path referenced in operator-facing messages:** `/etc/dsr/dsr-api.env`.
- **Console adapter stays blocked in production** unless `ALLOW_CONSOLE_EMAIL=true`. Do not weaken this.
- **Run after every task:** `npm --prefix server test` and `npm --prefix server run build`. Both must be green before commit.
- Line endings in this checkout are CRLF. Do not reformat whole files; keep diffs to the lines you change.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/email/net-diagnostics.ts` | **new** — transport-level probes (DNS, TCP, error explanation) shared by the Graph diagnose path. Rescued from `smtp.ts`. |
| `server/src/email/email-config.ts` | **new** — pure `missingEmailKeys()` plus the boot-time assertion. |
| `server/scripts/verify-email.mjs` | **new** — four-step operator confirmation CLI. |
| `server/src/email/email.module.ts` | dispatcher; loses three adapters and its host lookup table. |
| `server/src/email/email-provider.interface.ts` | gains `activeName(): string` on the interface. |
| `server/src/settings/settings.service.ts` | gains pure `resolveValue()` and `envOnly` enforcement. |
| `server/src/settings/settings.catalog.ts` | `envOnly` field; email group reduced to six keys. |
| `apps/admin/src/pages/SettingsPage.tsx` | loses the Gmail panels; renders `envOnly` keys read-only. |
| **Deleted** | `gmail.provider.ts`, `smtp.provider.ts`, `resend.provider.ts`, `smtp.ts`, `settings/gmail-oauth.service.ts`, `settings/gmail-callback.controller.ts`, `scripts/gmail-oauth.mjs` |

---

### Task 1: Extract `net-diagnostics.ts` from `smtp.ts`

Pure refactor, no behaviour change. Doing this first means the Task 5 deletion is mechanical.

**Files:**
- Create: `server/src/email/net-diagnostics.ts`
- Create: `server/src/email/net-diagnostics.spec.ts`
- Modify: `server/src/email/email.module.ts:16` (import path only)

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface DiagnosticStep { step: string; ok: boolean; detail: string; hint?: string; ms: number }`, `export const NET_TIMEOUTS: { connectionTimeout: number }`, `export function explainNetError(err: Error, host: string, port: number): string`, `export async function diagnoseHttpsEndpoint(host: string): Promise<DiagnosticStep[]>`.

- [ ] **Step 1: Write the failing test**

Create `server/src/email/net-diagnostics.spec.ts`:

```ts
import { explainNetError } from './net-diagnostics';

describe('explainNetError', () => {
  it('names DNS failures as DNS failures', () => {
    const out = explainNetError(new Error('getaddrinfo ENOTFOUND graph.microsoft.com'), 'graph.microsoft.com', 443);
    expect(out).toContain('could not be resolved');
    expect(out).toContain('graph.microsoft.com');
  });

  it('describes a timeout as blocked outbound HTTPS, not blocked SMTP', () => {
    const out = explainNetError(new Error('connect ETIMEDOUT'), 'login.microsoftonline.com', 443);
    expect(out).toContain('443');
    expect(out).not.toMatch(/SMTP|465|587/);
  });

  it('explains a refused connection', () => {
    expect(explainNetError(new Error('connect ECONNREFUSED'), 'example.com', 443)).toContain('refused');
  });

  it('explains an unroutable host', () => {
    expect(explainNetError(new Error('connect ENETUNREACH'), 'example.com', 443)).toContain('No route');
  });

  it('explains a certificate failure', () => {
    expect(explainNetError(new Error('unable to verify the first certificate'), 'example.com', 443))
      .toContain('certificate');
  });

  it('passes an unrecognised error through unchanged', () => {
    expect(explainNetError(new Error('something odd'), 'example.com', 443)).toBe('something odd');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- net-diagnostics`
Expected: FAIL — `Cannot find module './net-diagnostics'`.

- [ ] **Step 3: Create `server/src/email/net-diagnostics.ts`**

```ts
import { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface DiagnosticStep {
  step: string;
  ok: boolean;
  detail: string;
  /** Operator-facing next action when the step fails. */
  hint?: string;
  ms: number;
}

/**
 * A socket that never connects would otherwise hang the request until nginx
 * gives up, so every stage is bounded.
 */
export const NET_TIMEOUTS = {
  connectionTimeout: 8_000,
};

function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error; ms: number }> {
  const started = Date.now();
  return fn()
    .then((value) => ({ value, ms: Date.now() - started }))
    .catch((error: Error) => ({ error, ms: Date.now() - started }));
}

/** Open a plain TCP socket with a hard deadline. */
function tcpProbe(host: string, port: number, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const done = (err?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done());
    socket.once('timeout', () => done(new Error(`no response within ${timeout / 1000}s`)));
    socket.once('error', (e) => done(e));
    // Many cloud hosts publish an AAAA record but have no working IPv6 route,
    // which surfaces as ENETUNREACH; pin the lookup to IPv4.
    socket.connect({ host, port, family: 4 });
  });
}

export function explainNetError(err: Error, host: string, port: number): string {
  const msg = err.message || String(err);
  if (/ENETUNREACH/i.test(msg)) {
    return `No route to ${host} (usually an IPv6 address on a host without IPv6). The portal already forces IPv4, so this points at a broken network route.`;
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) {
    return `Nothing answered on port ${port}. The portal reaches Microsoft Graph over HTTPS only, so outbound ${port} must be open. Check the host firewall and any egress proxy.`;
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `${host} actively refused port ${port}.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `The hostname ${host} could not be resolved. Check the server's DNS.`;
  }
  if (/self.signed|unable to verify|CERT/i.test(msg)) {
    return 'The TLS certificate could not be verified. An intercepting proxy will cause this; its CA must be in the system trust store.';
  }
  return msg;
}

/**
 * Transport-level reachability for an HTTPS host, reported stage by stage so
 * the failing layer is obvious instead of arriving as one opaque timeout.
 */
export async function diagnoseHttpsEndpoint(host: string): Promise<DiagnosticStep[]> {
  const steps: DiagnosticStep[] = [];

  const dns = await timed(() => lookup(host, { family: 4 }));
  steps.push({
    step: 'DNS lookup',
    ok: !dns.error,
    detail: dns.error
      ? explainNetError(dns.error, host, 443)
      : `${host} resolves to ${dns.value?.address}`,
    hint: dns.error ? "Check the server's DNS configuration." : undefined,
    ms: dns.ms,
  });
  if (dns.error) return steps;

  const tcp = await timed(() => tcpProbe(host, 443, NET_TIMEOUTS.connectionTimeout));
  steps.push({
    step: 'HTTPS connect to port 443',
    ok: !tcp.error,
    detail: tcp.error ? explainNetError(tcp.error, host, 443) : `${host} is reachable on 443`,
    hint: tcp.error
      ? 'Outbound HTTPS is blocked, which would also break the rest of the portal.'
      : undefined,
    ms: tcp.ms,
  });
  return steps;
}
```

- [ ] **Step 4: Point the dispatcher at the new module**

In `server/src/email/email.module.ts`, change line 16 from:

```ts
import { diagnoseHttpsEndpoint, type DiagnosticStep } from './smtp';
```

to:

```ts
import { diagnoseHttpsEndpoint, type DiagnosticStep } from './net-diagnostics';
```

Leave `smtp.ts` in place — it is still imported by `gmail.provider.ts` and `smtp.provider.ts`, both deleted in later tasks.

- [ ] **Step 5: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS, including the six new `explainNetError` cases.

- [ ] **Step 6: Commit**

```bash
git add server/src/email/net-diagnostics.ts server/src/email/net-diagnostics.spec.ts server/src/email/email.module.ts
git commit
```

Message: `Lift the HTTPS probes out of the SMTP module`

---

### Task 2: `envOnly` settings that a browser cannot write

**Files:**
- Modify: `server/src/settings/settings.catalog.ts` (the `SettingDef` interface only)
- Modify: `server/src/settings/settings.service.ts`
- Create: `server/src/settings/settings.service.spec.ts`

**Interfaces:**
- Consumes: `SettingDef` from Task 0 baseline.
- Produces: `SettingDef.envOnly?: boolean`; `export function resolveValue(args: { def?: SettingDef; dbValue?: string; envValue?: string }): { value?: string; source: 'database' | 'environment' | 'default' | 'unset' }` exported from `settings.service.ts`. Task 6 sets `envOnly: true` on the email keys; Task 7 relies on `get()` honouring it.

- [ ] **Step 1: Write the failing test**

Create `server/src/settings/settings.service.spec.ts`:

```ts
import { resolveValue } from './settings.service';
import type { SettingDef } from './settings.catalog';

const plain: SettingDef = { key: 'X', label: 'X', group: 'g', type: 'text', default: 'dflt' };
const locked: SettingDef = { ...plain, key: 'Y', envOnly: true };

describe('resolveValue', () => {
  it('prefers the database for an ordinary key', () => {
    expect(resolveValue({ def: plain, dbValue: 'db', envValue: 'env' }))
      .toEqual({ value: 'db', source: 'database' });
  });

  it('ignores a stale database row for an envOnly key', () => {
    expect(resolveValue({ def: locked, dbValue: 'db', envValue: 'env' }))
      .toEqual({ value: 'env', source: 'environment' });
  });

  it('falls back to the catalog default for an envOnly key with no env value', () => {
    expect(resolveValue({ def: locked, dbValue: 'db' }))
      .toEqual({ value: 'dflt', source: 'default' });
  });

  it('treats an empty string as absent', () => {
    expect(resolveValue({ def: plain, dbValue: '', envValue: 'env' }))
      .toEqual({ value: 'env', source: 'environment' });
  });

  it('reports unset when nothing supplies a value', () => {
    const bare: SettingDef = { key: 'Z', label: 'Z', group: 'g', type: 'text' };
    expect(resolveValue({ def: bare })).toEqual({ value: undefined, source: 'unset' });
  });

  it('still resolves when the key is not in the catalog', () => {
    expect(resolveValue({ dbValue: 'db' })).toEqual({ value: 'db', source: 'database' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- settings.service`
Expected: FAIL — `resolveValue is not a function`.

- [ ] **Step 3: Add `envOnly` to the catalog type**

In `server/src/settings/settings.catalog.ts`, inside `interface SettingDef`, immediately after the `secret?: boolean;` line and its comment, add:

```ts
  /**
   * Resolved from the environment only. A database row is ignored and the
   * settings API refuses to write one, so the file on the server is the whole
   * truth for this key.
   */
  envOnly?: boolean;
```

- [ ] **Step 4: Add the pure resolver and use it**

In `server/src/settings/settings.service.ts`, add above the `@Injectable()` class:

```ts
export function resolveValue(args: {
  def?: SettingDef;
  dbValue?: string;
  envValue?: string;
}): { value?: string; source: 'database' | 'environment' | 'default' | 'unset' } {
  const { def, dbValue, envValue } = args;
  if (!def?.envOnly && dbValue !== undefined && dbValue !== '') {
    return { value: dbValue, source: 'database' };
  }
  if (envValue !== undefined && envValue !== '') return { value: envValue, source: 'environment' };
  if (def?.default !== undefined) return { value: def.default, source: 'default' };
  return { value: undefined, source: 'unset' };
}
```

Replace the body of `get<T>()` with:

```ts
  /** Synchronous read: database value, then env, then catalog default. */
  get<T = string>(key: string, fallback?: T): T {
    const { value } = resolveValue({
      def: SETTINGS_BY_KEY[key],
      dbValue: this.cache.get(key),
      envValue: this.env.get<string>(key),
    });
    return (value ?? fallback) as T;
  }
```

In `describeAll()`, replace the `const source: ... =` expression and the `effective` line with:

```ts
      const { value: effective, source } = resolveValue({
        def,
        dbValue: inDb,
        envValue: inEnv,
      });
```

and use `effective ?? ''` where the old code used `effective`.

- [ ] **Step 5: Reject writes to a locked key**

In `updateMany()`, immediately after the `if (!def) throw new BadRequestException(...)` line, add:

```ts
      if (def.envOnly) {
        throw new BadRequestException(
          `${def.label} is set in /etc/dsr/dsr-api.env and cannot be changed here.`,
        );
      }
```

- [ ] **Step 6: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS. The six `resolveValue` cases pass and nothing else regresses.

- [ ] **Step 7: Commit**

```bash
git add server/src/settings/settings.catalog.ts server/src/settings/settings.service.ts server/src/settings/settings.service.spec.ts
git commit
```

Message: `Let a setting be owned by the environment file alone`

---

### Task 3: Record the adapter that actually sent the message

**Files:**
- Modify: `server/src/email/email-provider.interface.ts`
- Modify: `server/src/email/graph.provider.ts`, `server/src/email/console.provider.ts`, `server/src/email/gmail.provider.ts`, `server/src/email/smtp.provider.ts`, `server/src/email/resend.provider.ts` (one method each; the last three are deleted in Tasks 4–5, but the build must stay green in between)
- Modify: `server/src/public/intake.service.ts:294`, `server/src/cases/assignment.service.ts:289,304,341,356`, `server/src/cases/outbound.service.ts:302`
- Create: `server/src/email/provider-logging.spec.ts`

**Interfaces:**
- Consumes: `EmailProvider` from Task 0 baseline.
- Produces: `EmailProvider.activeName(): string`. `EmailDispatcher` already implements it; the six log-write sites call `this.email.activeName()`.

Rationale: all six sites inject the `EMAIL_PROVIDER` token typed as `EmailProvider`, which has no way to name the active adapter — which is why five of them write the literal `'active'` and one writes `'gmail'`. Adding `activeName()` to the interface is the smallest honest fix: adapters already report their own name in `verifyConnection()`, and it avoids injecting `SettingsService` into three more services and duplicating the `'graph'` default in each.

- [ ] **Step 1: Write the failing test**

Create `server/src/email/provider-logging.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every email_log row must name the adapter that actually sent the message.
// A literal here is how the column came to read 'active' for years.
const WRITE_SITES = [
  'public/intake.service.ts',
  'cases/assignment.service.ts',
  'cases/outbound.service.ts',
];

describe('email_log provider column', () => {
  it.each(WRITE_SITES)('%s never hardcodes a provider name', (rel) => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    expect(src).not.toMatch(/provider:\s*'(gmail|graph|active|console|smtp|resend)'/);
  });

  it.each(WRITE_SITES)('%s resolves the provider from the dispatcher', (rel) => {
    const src = readFileSync(join(__dirname, '..', rel), 'utf8');
    expect(src).toContain('this.email.activeName()');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- provider-logging`
Expected: FAIL — all six assertions fail; the literals are still present.

- [ ] **Step 3: Put `activeName()` on the interface**

In `server/src/email/email-provider.interface.ts`, add to the `EmailProvider` interface, after `verifyConnection()`:

```ts
  /** Name of the adapter that will handle the next send, for `email_log`. */
  activeName(): string;
```

- [ ] **Step 4: Implement it in every adapter**

Add to each adapter class. `graph.provider.ts`:

```ts
  activeName(): string {
    return 'graph';
  }
```

`console.provider.ts`:

```ts
  activeName(): string {
    return 'console';
  }
```

`gmail.provider.ts` returns `'gmail'`, `smtp.provider.ts` returns `'smtp'`, `resend.provider.ts` returns `'resend'` — same three-line shape. (Those three files are deleted in Tasks 4–5; they need the method only so this task compiles on its own.) `EmailDispatcher` in `email.module.ts` already has `activeName()`; leave it.

- [ ] **Step 5: Fix the six write sites**

`server/src/public/intake.service.ts:294` — replace `provider: 'gmail',` with:

```ts
        provider: this.email.activeName(),
```

`server/src/cases/assignment.service.ts` lines 289, 304, 341 and 356 — replace each `provider: 'active',` with:

```ts
            provider: this.email.activeName(),
```

Match the surrounding indentation at each site; lines 341 and 356 sit two levels shallower than 289 and 304.

`server/src/cases/outbound.service.ts:302` — replace `provider: 'active',` with:

```ts
        provider: this.email.activeName(),
```

- [ ] **Step 6: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS. `provider-logging.spec.ts` green; TypeScript confirms every adapter implements `activeName()`.

- [ ] **Step 7: Commit**

```bash
git add server/src/email server/src/public/intake.service.ts server/src/cases/assignment.service.ts server/src/cases/outbound.service.ts
git commit
```

Message: `Log which adapter actually sent each message`

---

### Task 4: Delete the Gmail adapter and its OAuth flow

**Files:**
- Delete: `server/src/email/gmail.provider.ts`, `server/src/settings/gmail-oauth.service.ts`, `server/src/settings/gmail-callback.controller.ts`, `server/scripts/gmail-oauth.mjs`
- Modify: `server/src/email/email.module.ts`, `server/src/settings/settings.module.ts`, `server/src/settings/settings.controller.ts`, `server/src/settings/settings.catalog.ts`, `server/package.json`

**Interfaces:**
- Consumes: `activeName()` from Task 3.
- Produces: no `gmail` arm in the dispatcher; no `GMAIL_*` catalog keys.

- [ ] **Step 1: Delete the files**

```bash
git rm server/src/email/gmail.provider.ts \
       server/src/settings/gmail-oauth.service.ts \
       server/src/settings/gmail-callback.controller.ts \
       server/scripts/gmail-oauth.mjs
```

- [ ] **Step 2: Unwire the dispatcher**

In `server/src/email/email.module.ts`: delete the `import { GmailProvider } from './gmail.provider';` line, the `private readonly gmail: GmailProvider,` constructor parameter, `GmailProvider` from the `providers` array, the `case 'gmail': return this.gmail;` arm in `active()`, and both Gmail branches in `diagnose()` — the `if (which === 'gmail' && ...) return this.gmail.diagnose();` block and the `: which === 'gmail' ? 'gmail.googleapis.com'` arm of the `httpsHost` ternary.

Update the console-adapter error message, which names Gmail:

```ts
          throw new Error(
            'The console email adapter is not allowed in production. Set EMAIL_PROVIDER=graph in /etc/dsr/dsr-api.env.',
          );
```

- [ ] **Step 3: Unwire settings**

In `server/src/settings/settings.module.ts`: remove the two Gmail imports, `GmailCallbackController` from `controllers`, and `GmailOauthService` from `providers`.

In `server/src/settings/settings.controller.ts`: remove the `GmailOauthService` import, the `private readonly gmailOauth: GmailOauthService,` constructor parameter, and both the `@Post('email/gmail/authorize')` and `@Get('email/gmail/redirect-uri')` handlers with their doc comments. Keep `email/verify`, `email/diagnose` and `email/test-send`.

In `server/src/settings/settings.catalog.ts`: delete the six `GMAIL_*` entries (`GMAIL_AUTH`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`, `GMAIL_SMTP_PORT`) and the `{ value: 'gmail', ... }` option from `EMAIL_PROVIDER`.

In `server/src/settings/settings.service.ts`, `updateMany()`: the `GMAIL_APP_PASSWORD` whitespace special-case now refers to a deleted key. Replace

```ts
      const value = def.key === 'GMAIL_APP_PASSWORD' ? rawValue.replace(/\s+/g, '') : rawValue.trim();
```

with:

```ts
      const value = rawValue.trim();
```

- [ ] **Step 4: Drop the dependency**

```bash
npm --prefix server uninstall googleapis
```

- [ ] **Step 5: Verify it is gone and the build is clean**

```bash
grep -rn "googleapis\|GmailProvider\|gmail-oauth\|GMAIL_" server/src server/scripts server/package.json
npm --prefix server test && npm --prefix server run build
```

Expected: the grep prints nothing; tests and build pass. The admin SPA still references the removed routes — that is Task 9 and does not affect this build.

- [ ] **Step 6: Commit**

```bash
git add -A server/src server/scripts server/package.json server/package-lock.json
git commit
```

Message: `Remove the Gmail adapter and its OAuth consent flow`

---

### Task 5: Delete the SMTP and Resend adapters

**Files:**
- Delete: `server/src/email/smtp.provider.ts`, `server/src/email/resend.provider.ts`, `server/src/email/smtp.ts`
- Modify: `server/src/email/email.module.ts`, `server/src/settings/settings.catalog.ts`, `server/package.json`

**Interfaces:**
- Consumes: `diagnoseHttpsEndpoint` from Task 1, already re-imported from `net-diagnostics`.
- Produces: `EmailDispatcher.active()` resolves only `graph` and `console`; `activeName()` defaults to `'graph'`.

- [ ] **Step 0: Write the failing dispatcher test**

Create `server/src/email/email.module.spec.ts`. `EmailDispatcher` is a plain class, so construct it directly with stubs rather than booting a Nest context — the same approach the other specs take:

```ts
import { EmailDispatcher } from './email.module';

const stub = (name: string) => ({ activeName: () => name }) as never;
const dispatcherFor = (provider?: string) =>
  new EmailDispatcher(
    { get: (_k: string, fallback?: string) => provider ?? fallback } as never,
    stub('graph'),
    stub('console'),
  );

describe('EmailDispatcher', () => {
  it('defaults to graph when nothing is configured', () => {
    expect(dispatcherFor(undefined).activeName()).toBe('graph');
  });

  it('resolves graph', () => {
    expect(dispatcherFor('graph').activeName()).toBe('graph');
  });

  it('resolves console', () => {
    expect(dispatcherFor('console').activeName()).toBe('console');
  });

  it('names the offending value when the provider is unknown', async () => {
    await expect(dispatcherFor('smtp').verifyConnection()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('smtp'),
    });
  });

  it('has nothing to diagnose for the console adapter', async () => {
    await expect(dispatcherFor('console').diagnose()).resolves.toBeNull();
  });
});
```

Note the fourth case: `verifyConnection()` catches and reports rather than throwing, so an unknown provider surfaces as `ok: false` carrying the bad value — that is the existing contract and this test pins it.

- [ ] **Step 0b: Run it and confirm it fails**

Run: `npm --prefix server test -- email.module`
Expected: FAIL — the constructor still takes five adapters, and `activeName()` defaults to `'gmail'`.

- [ ] **Step 1: Delete the files**

```bash
git rm server/src/email/smtp.provider.ts server/src/email/resend.provider.ts server/src/email/smtp.ts
```

`smtp.ts` is safe to delete now: Task 1 moved its only surviving consumer to `net-diagnostics.ts`, and its other importers were removed in Task 4 and this step.

- [ ] **Step 2: Collapse the dispatcher**

In `server/src/email/email.module.ts`: remove the `SmtpProvider` and `ResendProvider` imports, both constructor parameters, both entries in the `providers` array, and their `case` arms in `active()`.

`diagnose()` reduces to:

```ts
  /**
   * Stage-by-stage connectivity report for the active adapter: HTTPS
   * reachability, then an authenticated call.
   */
  async diagnose(): Promise<DiagnosticStep[] | null> {
    if (this.activeName() !== 'graph') return null;

    const steps = await diagnoseHttpsEndpoint('graph.microsoft.com');
    if (steps.every((s) => s.ok)) {
      const started = Date.now();
      const status = await this.verifyConnection();
      steps.push({
        step: 'Authentication',
        ok: status.ok,
        detail: status.detail,
        hint: status.ok ? undefined : 'Check GRAPH_* credentials in /etc/dsr/dsr-api.env.',
        ms: Date.now() - started,
      });
    }
    return steps;
  }
```

Change the `activeName()` default from `'gmail'` to `'graph'`:

```ts
  activeName(): string {
    return this.settings.get<string>('EMAIL_PROVIDER', 'graph');
  }
```

- [ ] **Step 3: Reduce the catalog to two providers**

In `server/src/settings/settings.catalog.ts`, delete the six `smtp`/`resend` keys (`RESEND_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`) and set the `EMAIL_PROVIDER` entry to:

```ts
  {
    key: 'EMAIL_PROVIDER',
    label: 'Active provider',
    group: 'email',
    type: 'select',
    default: 'graph',
    help: 'Set in /etc/dsr/dsr-api.env. Changing it needs a service restart.',
    options: [
      { value: 'graph', label: 'Microsoft Graph (shared mailbox)' },
      { value: 'console', label: 'Console (development only, writes to the log)' },
    ],
  },
```

- [ ] **Step 4: Drop the dependencies**

```bash
npm --prefix server uninstall nodemailer @types/nodemailer
```

- [ ] **Step 5: Verify and build**

```bash
grep -rn "nodemailer\|SmtpProvider\|ResendProvider\|SMTP_\|RESEND_" server/src server/package.json
npm --prefix server test && npm --prefix server run build
```

Expected: grep prints nothing; tests and build pass, including the five `EmailDispatcher` cases from Step 0.

- [ ] **Step 6: Commit**

```bash
git add -A server/src server/package.json server/package-lock.json
git commit
```

Message: `Leave Graph and the console stub as the only mail adapters`

---

### Task 6: Hand the email settings to the environment file

**Files:**
- Modify: `server/src/settings/settings.catalog.ts`
- Modify: `server/src/cases/report.service.ts:359-362`
- Modify: `server/src/email/system-template.service.ts:174`
- Modify: `server/.env.example`

**Interfaces:**
- Consumes: `SettingDef.envOnly` from Task 2, the reduced catalog from Task 5.
- Produces: all six email keys resolve from env only. Task 7 asserts on exactly these keys.

- [ ] **Step 1: Write the failing test**

Append to `server/src/settings/settings.service.spec.ts`:

```ts
import { SETTINGS_BY_KEY } from './settings.catalog';

describe('email settings ownership', () => {
  const EMAIL_KEYS = [
    'EMAIL_PROVIDER',
    'EMAIL_FROM_NAME',
    'PRIVACY_MAILBOX',
    'GRAPH_TENANT_ID',
    'GRAPH_CLIENT_ID',
    'GRAPH_CLIENT_SECRET',
  ];

  it.each(EMAIL_KEYS)('%s is owned by the environment', (key) => {
    expect(SETTINGS_BY_KEY[key]?.envOnly).toBe(true);
  });

  it('has no email key outside that list', () => {
    const inGroup = Object.values(SETTINGS_BY_KEY)
      .filter((d) => d.group === 'email')
      .map((d) => d.key)
      .sort();
    expect(inGroup).toEqual([...EMAIL_KEYS].sort());
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- settings.service`
Expected: FAIL — `envOnly` is `undefined` on all six.

- [ ] **Step 3: Flag the keys**

Add `envOnly: true,` to each of the six email entries in `server/src/settings/settings.catalog.ts`. The three `GRAPH_*` entries keep `secret: true` where they already have it, and lose their `visibleWhen` clauses, which referenced deleted provider values.

- [ ] **Step 4: Fix the report from-address**

In `server/src/cases/report.service.ts`, replace:

```ts
          fromMailbox: this.settings.get<string>(
            'PRIVACY_MAILBOX',
            this.settings.get<string>('GMAIL_USER', 'privacy@example.com'),
          ),
```

with:

```ts
          // Boot validation guarantees PRIVACY_MAILBOX is set, so there is no
          // fallback to invent here — an example.com sender would bounce.
          fromMailbox: this.settings.get<string>('PRIVACY_MAILBOX'),
```

- [ ] **Step 5: Correct the preview sample**

In `server/src/email/system-template.service.ts:174`, change `provider: 'gmail',` to `provider: 'graph',`. This is sample data for the template preview screen, not a log write.

- [ ] **Step 6: Rewrite `server/.env.example`**

Replace the whole file with:

```
# --- core ---
PORT=3000
DATABASE_URL=postgres://dsr:dsr@127.0.0.1:5432/dsr

# --- email (spec: Graph-only, environment-owned) ---
# These six keys are read from this file only. A row in app_settings is
# ignored, and the settings API refuses to write one.
EMAIL_PROVIDER=graph                    # graph | console
EMAIL_FROM_NAME=Privacy Team
PRIVACY_MAILBOX=privacy@company.com

# Azure app registration with Mail.Send application permission, admin
# consented, and an application access policy scoped to PRIVACY_MAILBOX.
GRAPH_TENANT_ID=
GRAPH_CLIENT_ID=
GRAPH_CLIENT_SECRET=

# Development only. The console adapter refuses to run in production
# unless this is explicitly set.
# ALLOW_CONSOLE_EMAIL=true
```

- [ ] **Step 7: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS, including the seven new ownership assertions.

- [ ] **Step 8: Commit**

```bash
git add server/src/settings/settings.catalog.ts server/src/settings/settings.service.spec.ts server/src/cases/report.service.ts server/src/email/system-template.service.ts server/.env.example
git commit
```

Message: `Move the email configuration into the environment file`

---

### Task 7: Refuse to start without the Graph credentials

**Files:**
- Create: `server/src/email/email-config.ts`
- Create: `server/src/email/email-config.spec.ts`
- Modify: `server/src/main.ts`

**Interfaces:**
- Consumes: the six email keys from Task 6.
- Produces: `export const REQUIRED_GRAPH_KEYS: readonly string[]`, `export function missingEmailKeys(read: (key: string) => string | undefined): string[]`, `export function assertEmailConfig(read: (key: string) => string | undefined, log: { error: (m: string) => void }): void`. Task 8's CLI reuses `REQUIRED_GRAPH_KEYS` and `missingEmailKeys`.

- [ ] **Step 1: Write the failing test**

Create `server/src/email/email-config.spec.ts`:

```ts
import { REQUIRED_GRAPH_KEYS, missingEmailKeys, assertEmailConfig } from './email-config';

const full: Record<string, string> = {
  EMAIL_PROVIDER: 'graph',
  GRAPH_TENANT_ID: 't',
  GRAPH_CLIENT_ID: 'c',
  GRAPH_CLIENT_SECRET: 's',
  PRIVACY_MAILBOX: 'privacy@company.com',
};
const reader = (o: Record<string, string>) => (k: string) => o[k];

describe('missingEmailKeys', () => {
  it('passes a complete graph configuration', () => {
    expect(missingEmailKeys(reader(full))).toEqual([]);
  });

  it.each(REQUIRED_GRAPH_KEYS)('reports %s when it is absent', (key) => {
    const partial = { ...full };
    delete partial[key];
    expect(missingEmailKeys(reader(partial))).toEqual([key]);
  });

  it.each(REQUIRED_GRAPH_KEYS)('treats %s set to an empty string as missing', (key) => {
    expect(missingEmailKeys(reader({ ...full, [key]: '' }))).toEqual([key]);
  });

  it('reports every missing key at once, not just the first', () => {
    expect(missingEmailKeys(reader({ EMAIL_PROVIDER: 'graph' }))).toEqual([...REQUIRED_GRAPH_KEYS]);
  });

  it('requires nothing of the console adapter', () => {
    expect(missingEmailKeys(reader({ EMAIL_PROVIDER: 'console' }))).toEqual([]);
  });

  it('defaults to graph when EMAIL_PROVIDER is unset', () => {
    expect(missingEmailKeys(reader({}))).toEqual([...REQUIRED_GRAPH_KEYS]);
  });
});

describe('assertEmailConfig', () => {
  it('says nothing when the configuration is complete', () => {
    const log = { error: jest.fn() };
    expect(() => assertEmailConfig(reader(full), log)).not.toThrow();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('names every missing key and the file to fix', () => {
    const log = { error: jest.fn() };
    expect(() => assertEmailConfig(reader({ EMAIL_PROVIDER: 'graph' }), log)).toThrow();
    const output = log.error.mock.calls.flat().join('\n');
    for (const key of REQUIRED_GRAPH_KEYS) expect(output).toContain(key);
    expect(output).toContain('/etc/dsr/dsr-api.env');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm --prefix server test -- email-config`
Expected: FAIL — `Cannot find module './email-config'`.

- [ ] **Step 3: Create `server/src/email/email-config.ts`**

```ts
/**
 * Boot-time check on the mail configuration.
 *
 * A missing Graph credential used to surface as a silently dropped email to a
 * data subject waiting on a verification link. Failing here instead means
 * systemd reports a service that refused to start and `journalctl` names the
 * key, seconds after a bad deploy rather than hours later.
 *
 * Pure over an injected reader so it can be tested without a Nest context and
 * reused by scripts/verify-email.mjs.
 */

export const REQUIRED_GRAPH_KEYS = [
  'GRAPH_TENANT_ID',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',
  'PRIVACY_MAILBOX',
] as const;

export const ENV_FILE = '/etc/dsr/dsr-api.env';

export function missingEmailKeys(read: (key: string) => string | undefined): string[] {
  const provider = read('EMAIL_PROVIDER') || 'graph';
  if (provider !== 'graph') return [];
  return REQUIRED_GRAPH_KEYS.filter((key) => {
    const v = read(key);
    return v === undefined || v.trim() === '';
  });
}

export function assertEmailConfig(
  read: (key: string) => string | undefined,
  log: { error: (message: string) => void },
): void {
  const missing = missingEmailKeys(read);
  if (missing.length === 0) return;
  log.error(
    `Email is set to Microsoft Graph but ${missing.length} required ` +
      `setting${missing.length === 1 ? ' is' : 's are'} empty:`,
  );
  for (const key of missing) log.error(`  ${key}`);
  log.error(`Set them in ${ENV_FILE}, then restart the service.`);
  throw new Error(`Incomplete email configuration: ${missing.join(', ')}`);
}
```

- [ ] **Step 4: Wire it into the bootstrap**

In `server/src/main.ts`, add to the imports:

```ts
import { Logger } from '@nestjs/common';
import { SettingsService } from './settings/settings.service';
import { assertEmailConfig } from './email/email-config';
```

and insert immediately before the final `await app.listen(...)` line:

```ts
  // Read through SettingsService so the envOnly resolution used at runtime is
  // the same one validated here.
  const settings = app.get(SettingsService);
  const log = new Logger('EmailConfig');
  try {
    assertEmailConfig((key) => settings.get<string | undefined>(key, undefined), {
      error: (m) => log.error(m),
    });
  } catch {
    await app.close();
    process.exit(1);
  }
```

`SettingsModule` is `@Global()`, so `app.get(SettingsService)` resolves without importing the module here.

- [ ] **Step 5: Run tests and build**

Run: `npm --prefix server test && npm --prefix server run build`
Expected: PASS — 15 assertions across the two describes.

- [ ] **Step 6: Prove the guard fires**

```bash
cd server && GRAPH_CLIENT_SECRET= EMAIL_PROVIDER=graph node dist/main; echo "exit=$?"
```

Expected: the log names `GRAPH_CLIENT_SECRET` and `/etc/dsr/dsr-api.env`; `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add server/src/email/email-config.ts server/src/email/email-config.spec.ts server/src/main.ts
git commit
```

Message: `Stop the service at boot when Graph is not fully configured`

---

### Task 8: One command that confirms the mail path

**Files:**
- Create: `server/scripts/verify-email.mjs`

**Interfaces:**
- Consumes: `REQUIRED_GRAPH_KEYS` semantics from Task 7 (duplicated as a literal — the script is plain `.mjs` and must run without a TypeScript build, which is the point of it working on a broken deploy).
- Produces: exit code 0 on success, 1 on first failure. Task 10 wires it into `deploy/smoke.mjs`.

- [ ] **Step 1: Create `server/scripts/verify-email.mjs`**

```js
// Confirm the Microsoft Graph mail path from the server, using the same env
// file systemd gives the service.
//   node scripts/verify-email.mjs
//   node scripts/verify-email.mjs --send someone@company.com
//
// Deliberately dependency-free and untranspiled: this has to run on a box
// where the build is broken, which is exactly when it is needed.
import { lookup } from 'node:dns/promises';

const REQUIRED = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'PRIVACY_MAILBOX'];
const ENV_FILE = '/etc/dsr/dsr-api.env';

const sendTo = process.argv.includes('--send')
  ? process.argv[process.argv.indexOf('--send') + 1]
  : null;
if (process.argv.includes('--send') && !sendTo) {
  console.error('usage: verify-email.mjs [--send someone@company.com]');
  process.exit(1);
}

let step = 0;
const pass = (msg) => console.log(`  ok   ${++step}. ${msg}`);
const fail = (msg, hint) => {
  console.error(`  FAIL ${++step}. ${msg}`);
  if (hint) console.error(`       ${hint}`);
  process.exit(1);
};

// 1 — configuration
const provider = process.env.EMAIL_PROVIDER || 'graph';
if (provider !== 'graph') {
  console.log(`EMAIL_PROVIDER is "${provider}", not graph. Nothing to check.`);
  process.exit(0);
}
const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k].trim());
if (missing.length) {
  fail(`missing ${missing.join(', ')}`, `Set them in ${ENV_FILE}, then restart dsr-api.`);
}
const mailbox = process.env.PRIVACY_MAILBOX;
pass(`configuration present, sending as ${mailbox}`);

// 2 — reachability
try {
  const { address } = await lookup('login.microsoftonline.com', { family: 4 });
  pass(`login.microsoftonline.com resolves to ${address}`);
} catch (e) {
  fail(`cannot resolve login.microsoftonline.com: ${e.message}`, "Check the server's DNS.");
}

// 3 — token
let token;
try {
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GRAPH_CLIENT_ID,
        client_secret: process.env.GRAPH_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  );
  if (!res.ok) {
    fail(
      `token request rejected: ${res.status} ${await res.text()}`,
      'Wrong tenant id, client id, or an expired client secret.',
    );
  }
  token = (await res.json()).access_token;
  pass('client-credentials token issued');
} catch (e) {
  fail(`token request failed: ${e.message}`, 'Outbound HTTPS may be blocked.');
}

// 4 — mailbox. A valid token proves the app registration; it says nothing
// about Mail.Send consent or the application access policy. This does.
const who = await fetch(
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}`,
  { headers: { authorization: `Bearer ${token}` } },
);
if (!who.ok) {
  fail(
    `mailbox lookup failed: ${who.status} ${await who.text()}`,
    'Grant Mail.Send application permission with admin consent, and scope the application access policy to this mailbox.',
  );
}
pass(`mailbox reachable: ${(await who.json()).displayName || mailbox}`);

// 5 — optional real send
if (sendTo) {
  const sent = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: 'DSR portal mail path check',
          body: { contentType: 'Text', content: `Sent by verify-email.mjs from ${mailbox}.` },
          toRecipients: [{ emailAddress: { address: sendTo } }],
        },
        saveToSentItems: true,
      }),
    },
  );
  if (sent.status !== 202) {
    fail(`sendMail rejected: ${sent.status} ${await sent.text()}`, 'Mail.Send consent is the usual cause.');
  }
  pass(`test message accepted for ${sendTo}`);
}

console.log('\nGraph mail path is working.');
```

- [ ] **Step 2: Confirm it reports a missing key**

```bash
cd server && env -u GRAPH_CLIENT_SECRET EMAIL_PROVIDER=graph GRAPH_TENANT_ID=t GRAPH_CLIENT_ID=c \
  PRIVACY_MAILBOX=a@b.com node scripts/verify-email.mjs; echo "exit=$?"
```

Expected: `FAIL 1. missing GRAPH_CLIENT_SECRET`, names the env file, `exit=1`.

- [ ] **Step 3: Confirm it separates a bad tenant from a bad mailbox**

```bash
cd server && set -a && . /etc/dsr/dsr-api.env && set +a && \
  GRAPH_TENANT_ID=00000000-0000-0000-0000-000000000000 node scripts/verify-email.mjs; echo "exit=$?"
```

Expected: passes steps 1 and 2, fails at step 3 (token), never reaches step 4. This is the distinction the script exists to make.

- [ ] **Step 4: Confirm the happy path**

```bash
cd server && set -a && . /etc/dsr/dsr-api.env && set +a && node scripts/verify-email.mjs
```

Expected: four `ok` lines and `Graph mail path is working.`

- [ ] **Step 5: Commit**

```bash
git add server/scripts/verify-email.mjs
git commit
```

Message: `Add a one-command check of the Graph mail path`

---

### Task 9: Strip Gmail from the admin Settings screen

**Files:**
- Modify: `apps/admin/src/lib/api.ts` (the `SettingDef` type)
- Modify: `apps/admin/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `GET /internal/admin/settings`, which returns `{ groups, fields: SETTINGS, values: describeAll() }`. The `fields` array is the server catalog verbatim, so `envOnly` reaches the client through it — not through `values`, whose entries carry only `key`, `value`, `isSet`, `source` and `secret`.
- Produces: no admin route calls a deleted endpoint.

- [ ] **Step 1: Widen the client-side `SettingDef`**

The page reads `def.envOnly`, so the mirrored type must know about it. In `apps/admin/src/lib/api.ts`, add to the `SettingDef` interface:

```ts
  /** Resolved from the server's environment file; not editable here. */
  envOnly?: boolean
```

Without this the page compiles against a type that lacks the field and Step 2 fails to build.

- [ ] **Step 2: Remove the Gmail code paths**

In `apps/admin/src/pages/SettingsPage.tsx` delete, in this order:

- the `gmail=connected` hash handler and its toast (around lines 106–115), including the `/internal/admin/settings/email/gmail/redirect-uri` fetch
- the `connectGmail` function (around lines 188–196)
- the `current('EMAIL_PROVIDER') === 'gmail' && current('GMAIL_AUTH') === 'oauth2'` card (around line 512), including the Google Cloud setup instructions list
- both `current('EMAIL_PROVIDER') === 'gmail' && current('GMAIL_AUTH') === 'app-password'` blocks (around lines 578 and 586) — the "This host blocks Gmail SMTP" alert and the app-password card

- [ ] **Step 3: Render environment-owned fields read-only**

Each setting arrives from the API with a `source`. Where the input for a setting is rendered, disable it when the catalog marks it `envOnly` and show where the value comes from. Add near the existing `SOURCE_LABEL` chip (around line 321):

```tsx
{def.envOnly && (
  <span className="text-faint">Set in /etc/dsr/dsr-api.env</span>
)}
```

and add `disabled={def.envOnly}` to the input/select rendered for that setting. The existing `SOURCE_LABEL` chip already communicates `environment` vs `default`; leave it.

- [ ] **Step 4: Confirm no dead endpoints remain**

```bash
grep -rn "gmail\|Gmail\|GMAIL\|smtp\|SMTP\|resend\|RESEND" apps/admin/src
```

Expected: no matches.

- [ ] **Step 5: Build the admin bundle**

Run: `npm --prefix apps/admin run build`
Expected: clean build, no TypeScript errors about removed fields.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/lib/api.ts apps/admin/src/pages/SettingsPage.tsx
git commit
```

Message: `Show the email settings as read-only, owned by the server`

---

### Task 10: Update the operator-facing documentation and checks

**Files:**
- Modify: `deploy/smoke.mjs`, `server/scripts/e2e-settings.mjs`, `README.md`, `docs/build_dev_handbook.py`, `docs/build_user_guide.py`, `deploy/deploy.sh`

**Interfaces:**
- Consumes: `verify-email.mjs` from Task 8.
- Produces: nothing downstream; this is the last task of the sub-project.

- [ ] **Step 1: Find every stale reference**

```bash
grep -rn "gmail\|Gmail\|GMAIL\|nodemailer\|googleapis\|RESEND\|SMTP_\|ADMIN_API_TOKEN" \
  README.md deploy docs server/scripts --exclude-dir=node_modules
```

Work through the list. Every hit is either updated to Graph or deleted.

- [ ] **Step 2: Update the smoke checks**

In `deploy/smoke.mjs`, replace any assertion naming Gmail with the Graph equivalent, and add the mail-path check as its own case:

```js
await check('email: graph mail path', async () => {
  const { status } = spawnSync('node', ['server/scripts/verify-email.mjs'], { stdio: 'inherit' });
  if (status !== 0) throw new Error('verify-email.mjs failed');
});
```

Import `spawnSync` from `node:child_process` at the top if it is not already imported.

- [ ] **Step 3: Update `server/scripts/e2e-settings.mjs`**

Remove any step that writes a `GMAIL_*` or `SMTP_*` key. Add one that proves the lock holds:

```js
// An envOnly key must be refused, not silently ignored.
const res = await fetch(`${BASE}/internal/admin/settings`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ PRIVACY_MAILBOX: 'attacker@example.com' }),
});
if (res.status !== 400) throw new Error(`expected 400 for an envOnly key, got ${res.status}`);
```

- [ ] **Step 4: Remove the dead token from the deploy script**

In `deploy/deploy.sh`, delete the `ADMIN_API_TOKEN=${ADMIN_API_TOKEN}` line (around line 97). No server code has read this since internal auth landed.

- [ ] **Step 5: Update the prose**

In `README.md` and both `docs/build_*.py` generators, replace the Gmail/SMTP/Resend provider descriptions with a single Graph section covering: the six env keys, the Azure app registration with `Mail.Send` application permission and admin consent, the application access policy scoping it to `PRIVACY_MAILBOX`, and `node server/scripts/verify-email.mjs` as the confirmation command.

- [ ] **Step 6: Confirm nothing stale survives**

```bash
grep -rn "gmail\|Gmail\|GMAIL\|nodemailer\|googleapis\|RESEND\|SMTP_\|ADMIN_API_TOKEN" \
  README.md deploy docs server apps --exclude-dir=node_modules --exclude-dir=docshots
```

Expected: no matches.

- [ ] **Step 7: Full verification**

```bash
npm --prefix server test
npm --prefix server run build
npm --prefix apps/admin run build
npm --prefix apps/public-form run build
```

Expected: all four green.

- [ ] **Step 8: Commit**

```bash
git add README.md deploy docs server/scripts
git commit
```

Message: `Document Microsoft Graph as the only mail provider`

---

## Definition of done

- [ ] `EMAIL_PROVIDER` resolves only `graph` or `console`; the catalog default is `graph`.
- [ ] `grep -rn "googleapis\|nodemailer" server/package.json` returns nothing.
- [ ] `server/node_modules` is materially smaller after `npm ci` — the reason this started.
- [ ] Emptying `GRAPH_CLIENT_SECRET` and restarting stops the service, and `journalctl -u dsr-api` names the key.
- [ ] A row in `app_settings` setting `EMAIL_PROVIDER=console` does not change the resolved provider.
- [ ] `PUT /internal/admin/settings` with `PRIVACY_MAILBOX` returns 400.
- [ ] `node server/scripts/verify-email.mjs` passes four checks; `--send` delivers.
- [ ] A sent acknowledgement writes `email_log.provider = 'graph'`, not `'active'` or `'gmail'`.
- [ ] All four builds pass and the full Jest suite is green.
