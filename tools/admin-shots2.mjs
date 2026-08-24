// Screenshot the redesigned admin in both themes.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.env.ADMIN_BASE ?? 'http://localhost:5182'
mkdirSync('capture', { recursive: true })

const login = await fetch(`${BASE}/internal/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'AdminPassw0rd12345' }),
})
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
const [name, value] = cookie.split('=')

const casesRes = await fetch(`${BASE}/internal/cases`, { headers: { cookie } })
const cases = await casesRes.json().catch(() => ({}))
const caseId = cases.items?.[0]?.id

const routes = [
  ['#/', 'dashboard'],
  ['#/settings', 'settings'],
  ['#/cases', 'cases'],
  ...(caseId ? [[`#/cases/${caseId}`, 'case-detail']] : []),
  ['#/team', 'team'],
  ['#/audit', 'audit'],
  ['#/templates', 'templates'],
]

const browser = await chromium.launch()

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } })
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }])
  await ctx.addInitScript(`localStorage.setItem('dsr.theme', '${theme}')`)
  const page = await ctx.newPage()

  for (const [hash, label] of routes) {
    await page.goto('about:blank')
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(900)
    await page.screenshot({ path: `capture/v2-${label}-${theme}.png`, fullPage: true })
    console.log(`${label} (${theme})`)
  }

  // Command palette overlay
  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `capture/v2-palette-${theme}.png` })
  console.log(`palette (${theme})`)

  await ctx.close()
}

// Logged-out login screen, dark
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } })
await ctx.addInitScript(`localStorage.setItem('dsr.theme','dark')`)
const p = await ctx.newPage()
await p.goto(BASE, { waitUntil: 'networkidle' })
await p.waitForTimeout(700)
await p.screenshot({ path: 'capture/v2-login-dark.png' })
console.log('login (dark)')

await browser.close()
