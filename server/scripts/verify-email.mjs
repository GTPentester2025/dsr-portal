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
