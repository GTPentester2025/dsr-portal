// Capture every screen the documentation references, at a consistent size.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { portalBase } from '../deploy/target.mjs'

const BASE = portalBase()
const PW = process.env.ADMIN_PW
mkdirSync('docshots', { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await ctx.addInitScript(`localStorage.setItem('dsr.theme','light')`)
const page = await ctx.newPage()

const shot = async (name, opts = {}) => {
  await page.waitForTimeout(opts.wait ?? 900)
  await page.screenshot({ path: `docshots/${name}.png`, fullPage: opts.full ?? true })
  console.log('  ', name)
}

// ---------------------------------------------------------------- public --
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await shot('public-picker')
await page.goto(`${BASE}/#/form/eur-1`, { waitUntil: 'networkidle' })
await shot('public-form', { wait: 2200 })
await page.fill('#email', 'data.subject@example.com').catch(() => {})
await page.waitForTimeout(300)
await shot('public-verify', { full: false })

// ----------------------------------------------------------------- login --
await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' })
await shot('login', { full: false })

await page.fill('#email', 'admin@abinbev.com')
await page.fill('#password', PW)
await page.click('button[type=submit]')
await page.waitForTimeout(2400)

// ------------------------------------------------------------- main nav --
const routes = [
  ['#/', 'dashboard'],
  ['#/cases', 'cases'],
  ['#/forms', 'forms-list'],
  ['#/templates', 'templates'],
  ['#/team', 'team'],
  ['#/audit', 'audit'],
  ['#/settings', 'settings'],
]
for (const [hash, name] of routes) {
  await page.goto(`${BASE}/admin/${hash}`, { waitUntil: 'networkidle' })
  await shot(name)
}

// SLA tab
await page.goto(`${BASE}/admin/#/forms`, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
await page.getByRole('tab', { name: /SLA policies/i }).click()
await shot('sla-policies')

// form editor tabs
await page.goto(`${BASE}/admin/#/forms/eur-1`, { waitUntil: 'networkidle' })
await shot('form-editor-fields', { wait: 1500 })
// select a field so the property panel is populated
await page.getByText('First Name', { exact: false }).first().click().catch(() => {})
await shot('form-editor-field-selected', { wait: 700 })
for (const [tab, name] of [['Page content', 'form-editor-content'], ['Workflow & SLA', 'form-editor-workflow'], ['Versions', 'form-editor-versions']]) {
  await page.getByRole('tab', { name: new RegExp(tab, 'i') }).click()
  await shot(name, { wait: 700 })
}
// add-field palette
await page.getByRole('tab', { name: /Fields/i }).click()
await page.waitForTimeout(500)
await page.getByRole('button', { name: /Add field/i }).click()
await shot('form-editor-add-field', { full: false, wait: 600 })
await page.keyboard.press('Escape')

// case detail
await page.goto(`${BASE}/admin/#/cases`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
// The list renders as a button per case, not a table row.
const firstCase = page.locator('main li button').first()
if (await firstCase.count()) {
  await firstCase.click()
  await shot('case-detail', { wait: 1800 })
} else {
  console.warn('  ! no cases in scope — case-detail not captured')
}

// settings diagnostics
await page.goto(`${BASE}/admin/#/settings`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1000)
const diagnostics = page.getByRole('button', { name: /Run diagnostics/i })
if (await diagnostics.count()) {
  await diagnostics.click()
  await shot('settings-diagnostics', { wait: 11000 })
} else {
  console.warn('  ! Run diagnostics not visible (super_admin only) — skipped')
}

// command palette
await page.goto(`${BASE}/admin/#/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)
await page.keyboard.press('Control+k')
await shot('command-palette', { full: false, wait: 600 })
await page.keyboard.press('Escape')

// dark variants of the two headline screens
await ctx.addInitScript(`localStorage.setItem('dsr.theme','dark')`)
const dark = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await dark.addInitScript(`localStorage.setItem('dsr.theme','dark')`)
const dp = await dark.newPage()
await dp.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' })
await dp.fill('#email', 'admin@abinbev.com')
await dp.fill('#password', PW)
await dp.click('button[type=submit]')
await dp.waitForTimeout(2400)
for (const [hash, name] of [['#/', 'dashboard-dark'], ['#/forms/eur-1', 'form-editor-dark']]) {
  await dp.goto(`${BASE}/admin/${hash}`, { waitUntil: 'networkidle' })
  await dp.waitForTimeout(1400)
  await dp.screenshot({ path: `docshots/${name}.png`, fullPage: true })
  console.log('  ', name)
}

await browser.close()
console.log('done')
