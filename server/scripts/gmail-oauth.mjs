// Mint a Gmail API refresh token for the OAuth2 provider.
//
// Gmail over OAuth2 talks to gmail.googleapis.com on port 443, so it works on
// hosts that block outbound SMTP. Run this on your own machine (it opens a
// local callback listener), then paste the printed values into Settings.
//
//   node scripts/gmail-oauth.mjs <client-id> <client-secret>
//
// Google Cloud console setup, once:
//   1. Create or pick a project, enable the Gmail API.
//   2. OAuth consent screen: External, add yourself as a test user.
//   3. Credentials, Create credentials, OAuth client ID, type "Web application".
//   4. Authorised redirect URI: http://127.0.0.1:8720/callback
import { createServer } from 'node:http'
import { createInterface } from 'node:readline/promises'

const [clientId, clientSecret] = process.argv.slice(2)
if (!clientId || !clientSecret) {
  console.error('usage: node scripts/gmail-oauth.mjs <client-id> <client-secret>')
  process.exit(1)
}

const REDIRECT = 'http://127.0.0.1:8720/callback'
const SCOPE = 'https://www.googleapis.com/auth/gmail.send'

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces a refresh token even on repeat runs
  })

console.log('\nOpen this URL, sign in as the sending account and approve:\n')
console.log(authUrl + '\n')

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', REDIRECT)
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const c = url.searchParams.get('code')
    const err = url.searchParams.get('error')
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<meta charset=utf-8><body style="font-family:system-ui;padding:40px">
       <h2>${c ? 'Authorised' : 'Authorisation failed'}</h2>
       <p>${c ? 'You can close this tab and return to the terminal.' : err}</p></body>`,
    )
    server.close()
    c ? resolve(c) : reject(new Error(err ?? 'no code returned'))
  })
  server.listen(8720, '127.0.0.1', () => console.log('Waiting for the redirect on 127.0.0.1:8720 ...'))
  // Fall back to pasting the code by hand if the browser cannot reach us.
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.question('...or paste the "code" query parameter here and press enter: ')
    .then((typed) => {
      if (typed.trim()) {
        server.close()
        rl.close()
        resolve(typed.trim())
      }
    })
    .catch(() => undefined)
})

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
})
const body = await res.json()
if (!res.ok || !body.refresh_token) {
  console.error('\nToken exchange failed:', JSON.stringify(body, null, 2))
  process.exit(1)
}

console.log('\nDone. In the portal open Settings, Email delivery, and set:\n')
console.log('  Active provider          Gmail')
console.log('  Gmail authentication     OAuth2')
console.log(`  Gmail account            <the address you just authorised>`)
console.log(`  OAuth client ID          ${clientId}`)
console.log(`  OAuth client secret      ${clientSecret}`)
console.log(`  OAuth refresh token      ${body.refresh_token}\n`)
process.exit(0)
