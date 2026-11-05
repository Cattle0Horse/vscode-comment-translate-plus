import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 })
  for (const name of ["hero", "reading-modes"]) {
    const source = new URL(`../assets/${name}.svg`, import.meta.url)
    const output = fileURLToPath(new URL(`../assets/${name}.png`, import.meta.url))
    await page.goto(source.href)
    await page.evaluate(() => document.fonts.ready)
    await page.locator("svg:root").screenshot({ path: output, omitBackground: true })
    console.log(`Rendered assets/${name}.png`)
  }
} finally {
  await browser.close()
}
