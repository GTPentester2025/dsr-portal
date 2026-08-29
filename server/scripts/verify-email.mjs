// Confirm the Microsoft Graph mail path from the server, using the same env
// file systemd gives the service.
//   node scripts/verify-email.mjs
//   node scripts/verify-email.mjs --send someone@company.com
//
// Deliberately dependency-free and untranspiled: this has to run on a box
// where the build is broken, which is exactly when it is needed.
import { lookup } from 'node:dns/promises';
import { writeSync } from 'node:fs';

const REQUIRED = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'PRIVACY_MAILBOX'];
// Keep in step with EMAIL_PROVIDERS in src/email/email-config.ts. This script
// has to run untranspiled on a box where the build is broken, so it cannot
// import it.
const PROVIDERS = ['graph', 'console'];
const ENV_FILE = '/opt/dsr/server/.env';

// Whatever this process says last has to survive being piped. On POSIX a write
// to a pipe is asynchronous and process.exit() does not wait for it to drain,
// so `verify-email.mjs | tee verify.log` could lose the FAIL line and its hint
// — the two lines that get pasted into a ticket. Write those synchronously.
const say = (fd, text) => {
  try {
    writeSync(fd, text);
  } catch {
    // A non-blocking pipe can answer EAGAIN. Losing the message to an
    // exception would be worse than the truncation this exists to avoid.
    process.stderr.write(text);
  }
};

const sendTo = process.argv.includes('--send')
  ? process.argv[process.argv.indexOf('--send') + 1]
  : null;
if (process.argv.includes('--send') && !sendTo) {
  say(2, 'usage: verify-email.mjs [--send someone@company.com]\n');
  process.exit(1);
}

let step = 0;
const pass = (msg) => console.log(`  ok   ${++step}. ${msg}`);
const fail = (msg, hint) => {
  say(2, `  FAIL ${++step}. ${msg}\n${hint ? `       ${hint}\n` : ''}`);
  process.exit(1);
};

// 1 — configuration
const provider = process.env.EMAIL_PROVIDER || 'graph';
if (!PROVIDERS.includes(provider)) {
  // Exits non-zero on purpose. This used to print a cheerful note and exit 0,
  // so the one command an operator runs to confirm mail works reported success
  // on a portal whose first send would throw — and any deploy gate keyed on
  // the exit code passed with it.
  fail(
    `EMAIL_PROVIDER is ${JSON.stringify(provider)}, which is not an email provider this service has`,
    `Valid values are ${PROVIDERS.join(' and ')} — exact, lower case, no surrounding spaces. Correct it in ${ENV_FILE}; the API refuses to start until you do.`,
  );
}
if (provider === 'console') {
  say(1, `EMAIL_PROVIDER is "console": messages are written to the log, not sent. Nothing to check.\n`);
  process.exit(0);
}
const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k].trim());
if (missing.length) {
  fail(`missing ${missing.join(', ')}`, `Set them in ${ENV_FILE}, then restart dsr-api.`);
}
// Trimmed, because the presence check above trims: an address with a trailing
// space would otherwise pass step 1 and fail step 4 as a permissions problem.
const mailbox = process.env.PRIVACY_MAILBOX.trim();
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
  if (!token) {
    // Without this the next step sends `Bearer undefined` and Graph answers
    // 401, which reads as a mailbox-permission problem it is not.
    fail(
      'the token endpoint answered 200 but returned no access_token',
      'Something is answering for login.microsoftonline.com without issuing tokens — a captive portal or an intercepting proxy is the usual cause.',
    );
  }
  pass('client-credentials token issued');
} catch (e) {
  fail(`token request failed: ${e.message}`, 'Outbound HTTPS may be blocked.');
}

// 4 — mailbox. A valid token proves the app registration; it says nothing
// about Mail.Send consent or the application access policy. This does.
try {
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
} catch (e) {
  fail(`mailbox lookup failed: ${e.message}`, 'Outbound HTTPS to graph.microsoft.com may be blocked.');
}

// 5 — optional real send
if (sendTo) {
  try {
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
  } catch (e) {
    fail(`sendMail failed: ${e.message}`, 'Outbound HTTPS to graph.microsoft.com may be blocked.');
  }
}

console.log('\nGraph mail path is working.');
