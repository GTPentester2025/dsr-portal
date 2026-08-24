// Screenshot the redesigned admin app (logs in via API, reuses the cookie).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5182';
mkdirSync('capture', { recursive: true });

const login = await fetch(`${BASE}/internal/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'AdminPassw0rd12345' }),
});
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const [name, value] = cookie.split('=');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// find a case id for the detail page
const casesRes = await fetch(`${BASE}/internal/cases`, { headers: { cookie } });
const cases = await casesRes.json();
const caseId = cases.items?.[0]?.id;

const shots = [
  ['#/', 'admin-dashboard'],
  ['#/cases', 'admin-cases'],
  ...(caseId ? [[`#/cases/${caseId}`, 'admin-case-detail']] : []),
  ['#/templates', 'admin-templates'],
  ['#/team', 'admin-team'],
  ['#/audit', 'admin-audit'],
];
for (const [hash, name2] of shots) {
  await page.goto('about:blank');
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `capture/${name2}.png`, fullPage: true });
  console.log(name2, 'captured');
}

// logged-out login page
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p2 = await ctx2.newPage();
await p2.goto(BASE, { waitUntil: 'networkidle' });
await p2.waitForTimeout(800);
await p2.screenshot({ path: 'capture/admin-login.png' });
console.log('admin-login captured');

await browser.close();
