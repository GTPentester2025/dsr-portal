// Comprehensive UI/UX audit across the admin console and the public forms.
//
// Checks the things that actually break a page for a user: console errors,
// horizontal overflow, unreadable contrast, controls with no accessible name,
// touch targets too small to hit, and images that never loaded — at three
// widths and in both themes.
//
//   BASE=https://host ADMIN_PW=... node tools/ui-audit.mjs
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'https://134-209-146-74.sslip.io'
const PW = process.env.ADMIN_PW
const findings = []

function record(page, severity, kind, detail) {
  findings.push({ page, severity, kind, detail })
}

const WIDTHS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]

/**
 * Contrast ratio per WCAG.
 *
 * Only rgb() is comparable: Tailwind v4 emits oklab() for some computed
 * backgrounds, and treating those numbers as rgb produces nonsense — a nearly
 * white oklab background scored 1.17:1 against dark text. Anything not rgb is
 * reported as unmeasurable rather than guessed at.
 */
function contrast(fg, bg) {
  if (!/^rgba?\(/.test(fg) || !/^rgba?\(/.test(bg)) return null
  const parse = (c) => (c.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map(Number)
  const lum = (rgb) =>
    rgb
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
  const l1 = lum(parse(fg))
  const l2 = lum(parse(bg))
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

async function auditPage(page, label) {
  // Give async content a chance to land.
  await page.waitForTimeout(1200)

  // 1. Horizontal overflow — the most common responsive break.
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    if (doc.scrollWidth <= doc.clientWidth + 1) return null
    const wide = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`)
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, wide }
  })
  if (overflow) {
    record(label, 'high', 'horizontal-overflow',
      `content is ${overflow.scrollWidth}px wide in a ${overflow.clientWidth}px viewport (${overflow.wide.join(', ')})`)
  }

  // 2. Controls with no accessible name.
  const unnamed = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea')) {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const name =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent?.trim() ||
        (el.labels && el.labels.length ? el.labels[0].textContent?.trim() : '') ||
        el.getAttribute('placeholder')
      if (!name) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`)
    }
    return out.slice(0, 6)
  })
  if (unnamed.length) {
    record(label, 'medium', 'missing-accessible-name', unnamed.join(', '))
  }

  // 3. Touch targets below 44px on the smallest width.
  const small = await page.evaluate(() => {
    if (window.innerWidth > 500) return []
    const out = []
    for (const el of document.querySelectorAll('button, a[href], input[type=checkbox], select')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.height < 40 || r.width < 40) {
        out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
    }
    return out.slice(0, 5)
  })
  if (small.length) record(label, 'low', 'small-touch-target', small.join(', '))

  // 4. Text contrast.
  const lowContrast = await page.evaluate(() => {
    const samples = []
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n
    let seen = 0
    while ((n = walk.nextNode()) && seen < 400) {
      const text = n.textContent?.trim()
      if (!text || text.length < 3) continue
      const el = n.parentElement
      if (!el) continue
      const s = getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.3) continue
      // Skip anything the user cannot actually see: an off-canvas drawer is
      // still in the DOM, and measuring it composites against the wrong
      // backdrop and reports contrast failures that do not exist on screen.
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if (box.right <= 0 || box.left >= window.innerWidth) continue
      if (el.closest('[aria-hidden="true"], [inert]')) continue
      // An off-canvas drawer sits inside a clipping ancestor and is scrolled
      // out of it; its own rect still looks on-screen, so check the ancestor.
      let clipped = false
      for (let a = el.parentElement; a && !clipped; a = a.parentElement) {
        const as = getComputedStyle(a)
        if (!/hidden|clip|auto|scroll/.test(as.overflowX + as.overflowY)) continue
        const ar = a.getBoundingClientRect()
        if (box.right <= ar.left + 1 || box.left >= ar.right - 1) clipped = true
      }
      if (clipped) continue
      // Definitive test: is this element actually the thing painted at its own
      // centre? If an overlay (the mobile drawer scrim) sits on top, the text
      // is dimmed on purpose and its contrast against the page is irrelevant.
      const cx = Math.min(window.innerWidth - 1, Math.max(1, box.left + box.width / 2))
      const cy = Math.min(window.innerHeight - 1, Math.max(1, box.top + box.height / 2))
      const hit = document.elementFromPoint(cx, cy)
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) continue
      seen++
      // Composite every translucent layer down to an opaque colour. A 14%
      // tint of the text colour is not "the same colour as the text" — it sits
      // over whatever is behind it, and comparing against the raw rgba reads as
      // 1.00:1 when the rendered contrast is fine.
      // Round-trip exotic colour functions through the browser to get rgb.
      /*
       * Resolve any CSS colour to concrete rgba by painting it.
       *
       * Setting the value on a probe element and reading it back does not
       * convert oklab — Chrome returns oklab again — so a translucent
       * oklab background parsed as near-black and every contrast reading
       * against it was wrong. A canvas gives real pixels for every syntax.
       */
      const probeCanvas = document.createElement('canvas')
      probeCanvas.width = probeCanvas.height = 1
      const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true })
      const toRgba = (value) => {
        if (!value) return [0, 0, 0, 0]
        probeCtx.clearRect(0, 0, 1, 1)
        probeCtx.fillStyle = '#000'
        probeCtx.fillStyle = value
        probeCtx.fillRect(0, 0, 1, 1)
        const d = probeCtx.getImageData(0, 0, 1, 1).data
        return [d[0], d[1], d[2], d[3] / 255]
      }
      const toRgb = (value) => {
        const [r, g, b] = toRgba(value)
        return `rgb(${r}, ${g}, ${b})`
      }
      const layers = []
      let bgEl = el
      while (bgEl) {
        // Normalise first: Tailwind emits oklab() for some backgrounds, and
        // reading those numbers as rgb makes a white surface parse as black —
        // which is where every phantom grey background came from.
        const [r, g, b, alpha] = toRgba(getComputedStyle(bgEl).backgroundColor)
        if (alpha > 0) layers.push({ rgb: [r, g, b], alpha })
        if (alpha === 1) break
        bgEl = bgEl.parentElement
      }
      let composed = [255, 255, 255]
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i]
        composed = composed.map((base, k) => l.rgb[k] * l.alpha + base * (1 - l.alpha))
      }
      const bg = `rgb(${composed.map((v) => Math.round(v)).join(', ')})`
      samples.push({
        text: text.slice(0, 32),
        fg: toRgb(s.color),
        bg,
        size: parseFloat(s.fontSize),
        weight: s.fontWeight,
      })
    }
    return samples
  })
  for (const s of lowContrast) {
    const ratio = contrast(s.fg, s.bg)
    if (ratio === null) continue
    const large = s.size >= 24 || (s.size >= 18.66 && Number(s.weight) >= 700)
    const required = large ? 3 : 4.5
    if (ratio < required) {
      record(label, ratio < 3 ? 'high' : 'medium', 'low-contrast',
        `"${s.text}" ${ratio.toFixed(2)}:1 (needs ${required}:1) ${s.fg} on ${s.bg}`)
      break // one per page is enough to act on
    }
  }

  // 5. Images that failed to load.
  const broken = await page.evaluate(() =>
    [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src).slice(0, 3),
  )
  if (broken.length) record(label, 'high', 'broken-image', broken.join(', '))

  // 6. Duplicate element ids — breaks label association and testing.
  const dupes = await page.evaluate(() => {
    const seen = new Map()
    for (const el of document.querySelectorAll('[id]')) {
      seen.set(el.id, (seen.get(el.id) ?? 0) + 1)
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id).slice(0, 5)
  })
  if (dupes.length) record(label, 'medium', 'duplicate-id', dupes.join(', '))
}

const browser = await chromium.launch()

for (const theme of ['light', 'dark']) {
  for (const vp of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    await ctx.addInitScript(`localStorage.setItem('dsr.theme','${theme}')`)
    const page = await ctx.newPage()
    const errors = []
    page.on('console', (m) => {
      // The shell probes /internal/auth/me before the user signs in; a 401
      // there is the expected answer, not a fault.
      if (m.type() === 'error' && !/auth\/me/.test(m.text()) && !/401/.test(m.text())) {
        errors.push(m.text())
      }
    })
    page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`))

    await page.goto(`${BASE}/admin/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    await page.fill('#email', 'admin@abinbev.com').catch(() => {})
    await page.fill('#password', PW).catch(() => {})
    await page.click('button[type=submit]').catch(() => {})
    await page.waitForTimeout(2600)

    const routes = [
      ['dashboard', '#/'],
      ['cases', '#/cases'],
      ['forms', '#/forms'],
      ['templates', '#/templates'],
      ['team', '#/team'],
      ['audit', '#/audit'],
      ['settings', '#/settings'],
    ]
    for (const [name, hash] of routes) {
      await page.goto(`${BASE}/admin/${hash}`, { waitUntil: 'domcontentloaded' })
      await auditPage(page, `${name} ${vp.name} ${theme}`)
    }

    // A case detail page, which is the densest screen.
    await page.goto(`${BASE}/admin/#/cases`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    const row = page.locator('tbody tr').first()
    if (await row.count()) {
      await row.click()
      await auditPage(page, `case-detail ${vp.name} ${theme}`)
    }

    if (errors.length) {
      record(`console ${vp.name} ${theme}`, 'high', 'console-error', [...new Set(errors)].slice(0, 4).join(' | '))
    }
    await ctx.close()
  }
}

// Public form, the surface a requester sees.
for (const vp of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`))
  await page.goto(`${BASE}/#/form/eur-1`, { waitUntil: 'domcontentloaded' })
  await auditPage(page, `public-form ${vp.name}`)
  if (errors.length) {
    record(`public-form ${vp.name}`, 'high', 'console-error', [...new Set(errors)].slice(0, 3).join(' | '))
  }
  await ctx.close()
}

await browser.close()

const order = { high: 0, medium: 1, low: 2 }
findings.sort((a, b) => order[a.severity] - order[b.severity])
const grouped = new Map()
for (const f of findings) {
  const key = `${f.severity}|${f.kind}|${f.detail}`
  if (!grouped.has(key)) grouped.set(key, { ...f, pages: [] })
  grouped.get(key).pages.push(f.page)
}

console.log(`\n${grouped.size} distinct finding(s)\n`)
for (const f of grouped.values()) {
  console.log(`[${f.severity.toUpperCase()}] ${f.kind}`)
  console.log(`   ${f.detail}`)
  console.log(`   on: ${[...new Set(f.pages)].slice(0, 4).join(', ')}${f.pages.length > 4 ? ` (+${f.pages.length - 4})` : ''}\n`)
}
