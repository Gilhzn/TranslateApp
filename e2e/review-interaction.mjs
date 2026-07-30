/**
 * Pointer-level regression guard for the review grid.
 *
 * Why this is a browser script and not a Vitest test: the defect it guards
 * against only exists between mousedown and mouseup. Focusing the grid without
 * `preventScroll` moves the button out from under a stationary cursor, so
 * mouseup lands on a different element and the click never completes — the
 * first click on any row was silently swallowed. `element.click()` and the
 * keyboard path both worked, so nothing short of a real pointer sequence in a
 * real browser reproduces it. The suite runs in the node environment with no
 * jsdom, and jsdom would not model scroll displacement anyway.
 *
 * Run:
 *   npm run build
 *   PORT=3210 npm start &
 *   node e2e/review-interaction.mjs            # or: PORT=3210 node e2e/...
 *
 * Exits non-zero on regression.
 */

import { chromium } from "playwright";

/** The environment's chromium; playwright's bundled build does not match. */
const CHROME =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = process.env.PORT ?? "3210";
const URL = `http://localhost:${PORT}/preview/review`;

/** Rows spread down the grid so at least one starts below the fold. */
const ROWS = ["meta.version", "menu.play", "hud.hp", "menu.dailyChallenge"];

const browser = await chromium.launch({ executablePath: CHROME });
let failures = 0;

for (const key of ROWS) {
  // A fresh page each time: the bug only fires on the session's FIRST
  // interaction, before the grid has ever held focus.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);

  const button = page.locator(`[role="row"]:has-text("${key}") button`).first();
  await button.waitFor({ state: "visible" });

  const before = await button.boundingBox();
  await button.click(); // real pointer sequence: mousedown -> mouseup -> click
  await page.waitForTimeout(350);

  const expanded = await button.getAttribute("aria-expanded");
  const after = await button.boundingBox();

  const ok = expanded === "true";
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${key.padEnd(20)} aria-expanded=${expanded} ` +
      `button top ${before?.y?.toFixed(1)} -> ${after?.y?.toFixed(1)}`,
  );
  await page.close();
}

await browser.close();

if (failures > 0) {
  console.error(`\n${failures}/${ROWS.length} rows did not open on the first click`);
  process.exit(1);
}
console.log("\nALL PASS — a single pointer click opens the row detail");
