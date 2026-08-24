// Screenshot the local replica for side-by-side comparison with capture/*.live.png
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const keys = process.argv.slice(2).length ? process.argv.slice(2) : ['eur-1'];
mkdirSync('capture', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
for (const key of keys) {
  await page.goto('about:blank');
  await page.goto(`http://localhost:5180/#/form/${key}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.formio-form', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `capture/${key}.replica.png`, fullPage: true });
  console.log(`${key} replica captured`);
}
await browser.close();
