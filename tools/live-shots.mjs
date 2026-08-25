import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { portalBase } from '../deploy/target.mjs'
mkdirSync('capture', { recursive: true })

const BASE = portalBase()
const PW = process.env.ADMIN_PW

const browser = await chromium.launch()
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } })
  await ctx.addInitScript(`localStorage.setItem('dsr.theme','${theme}')`)
  const page = await ctx.newPage()

  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.screenshot({ path: `capture/live-login-${theme}.png` })

  await page.fill('#email', 'admin@abinbev.com')
  await page.fill('#password', PW)
  await page.click('button[type=submit]')
  await page.waitForTimeout(2200)
  await page.screenshot({ path: `capture/live-dashboard-${theme}.png`, fullPage: true })

  await page.goto(`${BASE}/admin/#/settings`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1400)
  await page.screenshot({ path: `capture/live-settings-${theme}.png`, fullPage: true })
  console.log(`captured ${theme}`)
  await ctx.close()
}

// public intake form, live
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
const p = await ctx.newPage()
await p.goto(`${BASE}/#/form/eur-1`, { waitUntil: 'networkidle' })
await p.waitForTimeout(2000)
await p.screenshot({ path: 'capture/live-public-form.png', fullPage: true })
console.log('captured public form')
await browser.close()
