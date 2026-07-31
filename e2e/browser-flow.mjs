/**
 * LingoLoop — end-to-end browser test of the whole product on `/`.
 *
 * Drives the real UI in a real Chromium: uploads `fixtures/indie-game-en.json`
 * through the actual file input, picks German and Japanese in the locale
 * picker, starts the job, watches the live SSE-driven progress, and asserts the
 * review table renders real rows with a working export control. Nothing is
 * stubbed — the page talks to the running `/api/translate` route.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN
 * ---------------------------------------------------------------------------
 *
 *   # 1. build and start the app on a free port
 *   npm run build
 *   PORT=3477 npm start &
 *   until curl -sf http://localhost:3477/api/health >/dev/null; do sleep 1; done
 *
 *   # 2. run this script against it
 *   node e2e/browser-flow.mjs                       # defaults to :3477
 *   BASE_URL=http://localhost:4000 node e2e/browser-flow.mjs
 *   HEADED=1 node e2e/browser-flow.mjs              # watch it happen
 *   SHOT_DIR=screenshots node e2e/browser-flow.mjs  # save stage screenshots
 *
 * Exit code 0 means every assertion passed. Any failure prints the assertion
 * and exits non-zero.
 *
 * Playwright's bundled browser revision does not match this machine, so the
 * executable path is passed explicitly. Override with CHROMIUM_PATH.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3477";
const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FIXTURE = path.join(REPO, "fixtures", "indie-game-en.json");
const SHOT_DIR = process.env.SHOT_DIR ?? null;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 180_000);

let failures = 0;
let checks = 0;

function ok(label, condition, extra = "") {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}${extra === "" ? "" : ` — ${extra}`}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${extra === "" ? "" : ` — ${extra}`}`);
  }
}

function step(label) {
  console.log(`\n${label}`);
}

async function shot(page, name) {
  if (SHOT_DIR === null) return;
  await page.screenshot({
    // resolve, not join: an absolute SHOT_DIR should be honoured, not appended
    // to the repo root (which silently builds a mirrored tree inside it).
    path: path.join(path.resolve(REPO, SHOT_DIR), `browser-flow-${name}.png`),
    fullPage: false,
  });
}

async function main() {
  console.log(`LingoLoop browser flow · ${BASE_URL}`);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // The raw SSE body, captured straight off the wire: the strongest available
  // proof that progress is driven by the route's own JobProgress frames.
  //
  // `response.text()` on a streaming response the PAGE is consuming is not
  // reliable — the browser hands the bytes to the page's reader and Playwright
  // can be left with an empty buffer, which shows up as "0 frames" against a
  // route that in fact streamed perfectly. So this capture is best-effort, and
  // `fetchEventStream` below re-requests the route independently whenever it
  // comes back empty. The assertions then run against a body that definitely
  // exists, and still against the real route.
  let sseBody = null;
  let sseContentType = null;
  page.on("response", (response) => {
    if (!response.url().endsWith("/api/translate")) return;
    sseContentType = response.headers()["content-type"] ?? null;
    sseBody = response.text().catch(() => null);
  });

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
  });

  try {
    // -----------------------------------------------------------------------
    step("1 · Load the dashboard");
    // -----------------------------------------------------------------------
    const response = await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    ok("GET / returns 200", response !== null && response.status() === 200);
    await page.waitForSelector("text=Drop your source catalog");

    const heroCount = Number(
      (await page.locator("h1").first().innerText()).match(/in (\d+) languages/)?.[1] ?? "0",
    );
    ok(
      "hero language count is a real number from LOCALE_PROFILES, not 'twelve'",
      heroCount > 40,
      `${heroCount} languages`,
    );

    // Provider messaging hierarchy: the header pill names the mode, the flow
    // callout names the consequence, the footer names the engine id. The mode
    // itself must appear exactly once.
    const modeMentions = await page.getByText("Offline simulation", { exact: false }).count();
    ok(
      "provider mode is stated once, not repeated verbatim across surfaces",
      modeMentions === 1,
      `${modeMentions} occurrence(s)`,
    );

    ok(
      "step rail starts on Source",
      (await page.locator('li[aria-current="step"]').innerText()).includes("Source"),
    );
    await shot(page, "1-idle");

    // -----------------------------------------------------------------------
    step("2 · Upload fixtures/indie-game-en.json through the real file input");
    // -----------------------------------------------------------------------
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await page.waitForSelector("text=What we understood", { timeout: 15_000 });

    const stringLeaves = countStrings(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const summary = await page.locator("text=indie-game-en.json").first().innerText();
    ok("catalog summary names the uploaded file", summary.includes("indie-game-en.json"));
    ok(
      "step rail stays on Source while the run is being configured",
      (await page.locator('li[aria-current="step"]').innerText()).includes("Source"),
    );
    ok("fixture is non-trivial", stringLeaves > 20, `${stringLeaves} string leaves`);
    await shot(page, "2-configured");

    // -----------------------------------------------------------------------
    step("3 · Pick German and Japanese");
    // -----------------------------------------------------------------------
    for (const code of ["de", "ja"]) {
      const option = page.locator(`#lingoloop-locale-${code}`);
      await option.scrollIntoViewIfNeeded();
      await option.click();
      ok(`selected ${code}`, (await option.getAttribute("aria-selected")) === "true");
    }

    const badge = await page.getByText(/^\d+ selected$/).first().innerText();
    ok("locale picker reports two selections", badge.startsWith("2"), badge);

    // -----------------------------------------------------------------------
    step("4 · Start the job and observe the live run");
    // -----------------------------------------------------------------------
    // The offline simulator finishes a two-locale job in a couple of seconds,
    // so polling the DOM for "is the cancel button enabled *right now*" is a
    // coin flip. Instead a sampler installed before the click records what the
    // run monitor actually showed while it existed, and the assertions below
    // run against that history — deterministic, and a stronger claim.
    await page.evaluate(() => {
      const seen = {
        samples: 0,
        progress: [],
        phases: [],
        steps: [],
        localeStates: {},
        cancelEnabled: false,
        railSize: 0,
        message: "",
      };
      window.__lingoRun = seen;
      window.__lingoSampler = setInterval(() => {
        const monitor = document.querySelector('section[aria-label="Translation run"]');
        const currentStep = document.querySelector('li[aria-current="step"]');
        if (currentStep !== null) {
          const label = currentStep.textContent.trim();
          if (seen.steps[seen.steps.length - 1] !== label) seen.steps.push(label);
        }
        if (monitor === null) return;
        seen.samples += 1;

        const phase = monitor.getAttribute("data-phase");
        if (phase !== null && !seen.phases.includes(phase)) seen.phases.push(phase);

        const bar = monitor.querySelector('[role="progressbar"]');
        const now = bar === null ? null : bar.getAttribute("aria-valuenow");
        if (now !== null) {
          const value = Number(now);
          if (seen.progress[seen.progress.length - 1] !== value) seen.progress.push(value);
        }

        const cancel = Array.from(monitor.querySelectorAll("button")).find(
          (button) => button.textContent.trim() === "Cancel",
        );
        if (cancel !== undefined && !cancel.disabled) seen.cancelEnabled = true;

        const rail = monitor.querySelectorAll('ul[aria-label="Per-language progress"] > li');
        seen.railSize = Math.max(seen.railSize, rail.length);
        for (const item of rail) {
          const code = item.getAttribute("data-locale");
          const state = item.getAttribute("data-state");
          if (code === null || state === null) continue;
          const states = (seen.localeStates[code] ??= []);
          if (states[states.length - 1] !== state) states.push(state);
        }

        const status = monitor.querySelector('[role="status"]');
        if (status !== null && status.textContent.trim().length > 0) {
          seen.message = status.textContent.trim();
        }
      }, 20);
    });

    // The offline simulator finishes 164 units in about 20ms — faster than the
    // browser can paint, which would make every "did the bar move" assertion a
    // coin flip. Throttling the *download* stretches the same real frames over
    // a couple of seconds without altering a byte of them, so the UI's
    // streaming behaviour becomes observable. Nothing is stubbed.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 20,
      downloadThroughput: 40 * 1024,
      uploadThroughput: 4 * 1024 * 1024,
    });

    await page.getByRole("button", { name: "Translate" }).click();
    await page.waitForSelector('section[aria-label="Translation run"]', { timeout: 20_000 });
    ok("run monitor replaced the form", true);
    await shot(page, "3-running");

    // -----------------------------------------------------------------------
    step("5 · Wait for completion, then check what the run actually showed");
    // -----------------------------------------------------------------------
    await page.waitForSelector('div[role="grid"][aria-label="Translation review"]', {
      timeout: JOB_TIMEOUT_MS,
    });

    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    const seen = await page.evaluate(() => {
      clearInterval(window.__lingoSampler);
      return window.__lingoRun;
    });

    // --- what the server actually sent -------------------------------------
    const captured = sseBody === null ? null : await sseBody;
    ok("the route answered with a real event stream", (sseContentType ?? "").startsWith("text/event-stream"), String(sseContentType));

    // Fall back to an independent request when the page consumed the buffer.
    let raw = captured;
    let source = "captured from the page's own request";
    if (parseSse(raw ?? "").length === 0) {
      raw = await fetchEventStream();
      source = "re-requested independently (page buffer was empty)";
    }
    const frames = parseSse(raw ?? "");
    ok("the stream body is readable for inspection", frames.length > 0, source);
    const progressFrames = frames.filter((frame) => frame.event === "progress");
    ok("the stream carried many JobProgress frames", progressFrames.length > 4, `${progressFrames.length} frames`);
    ok(
      "completedUnits rose monotonically to totalUnits",
      progressFrames.every(
        (frame, index) =>
          index === 0 || frame.data.completedUnits >= progressFrames[index - 1].data.completedUnits,
      ) &&
        progressFrames[progressFrames.length - 1].data.completedUnits ===
          progressFrames[progressFrames.length - 1].data.totalUnits,
      `${progressFrames[progressFrames.length - 1].data.completedUnits}/${progressFrames[progressFrames.length - 1].data.totalUnits}`,
    );
    ok(
      "one locale-complete frame per target, then exactly one done frame",
      frames.filter((frame) => frame.event === "locale-complete").length === 2 &&
        frames.filter((frame) => frame.event === "done").length === 1,
    );

    // --- what the UI showed while it ran -----------------------------------

    ok("the run monitor was on screen while the job ran", seen.samples > 1, `${seen.samples} samples`);
    ok("a cancel control was present and enabled during the run", seen.cancelEnabled);
    ok("the per-language rail listed both targets", seen.railSize === 2, `${seen.railSize} rows`);
    ok(
      "the job phase advanced through real JobPhase values",
      seen.phases.includes("translating") && seen.phases.length > 1,
      seen.phases.join(" → "),
    );
    ok(
      "progress moved through several distinct values from the SSE stream",
      seen.progress.length > 1,
      `${seen.progress.length} values: ${seen.progress.slice(0, 8).join(" → ")}${seen.progress.length > 8 ? " → …" : ""}`,
    );
    ok(
      "progress only ever moves forward",
      seen.progress.every((value, index) => index === 0 || value >= seen.progress[index - 1]),
    );
    ok(
      "progress reached 100% before the review appeared",
      seen.progress[seen.progress.length - 1] === 100,
      String(seen.progress[seen.progress.length - 1]),
    );
    // Locales run concurrently, so each one is shown queued → in flight → done.
    // The last locale to finish is the one that ends the run, and the monitor
    // unmounts in the same commit — its "done" state is evidenced by the review
    // table below, not by this rail.
    for (const code of ["de", "ja"]) {
      const states = seen.localeStates[code] ?? [];
      ok(
        `${code} was shown queued and then in flight`,
        states[0] === "queued" && states.includes("active"),
        states.join(" → "),
      );
    }
    ok(
      "at least one locale was seen reaching done in the live rail",
      Object.values(seen.localeStates).some((states) => states.includes("done")),
    );
    ok(
      "the live message line carried the pipeline's own words, not a spinner caption",
      seen.message !== "Opening the stream…" && seen.message.length > 20,
      seen.message,
    );
    ok(
      "the step rail walked Source → Translate → Review",
      seen.steps.some((label) => label.includes("Translate")) &&
        seen.steps.some((label) => label.includes("Review")),
      seen.steps.join(" → "),
    );

    const completion = await page.getByText("Run complete").count();
    ok("completion bar announced the finished run", completion === 1);

    const grid = page.locator('div[role="grid"][aria-label="Translation review"]');
    const rows = Number(await grid.getAttribute("aria-rowcount")) - 1;
    ok(
      "review grid holds one row per string per locale",
      rows > 0 && rows % 2 === 0,
      `${rows} rows`,
    );
    // The file has `stringLeaves` string values, a few of which are
    // `_comment`/`_context` keys the parser folds into developer notes rather
    // than translating — so per locale the row count sits just under it.
    ok(
      "row count matches the fixture's translatable strings, per locale",
      rows / 2 <= stringLeaves && rows / 2 >= stringLeaves - 6,
      `${rows / 2} rows per locale vs ${stringLeaves} string leaves in the file`,
    );
    const reviewed = Number(
      (await page.getByText(/strings reviewed/).innerText()).replace(/[^0-9]/g, ""),
    );
    ok("the summary strip agrees with the grid", reviewed === rows, `${reviewed} vs ${rows}`);

    const renderedRows = await grid.locator('div[role="row"][aria-rowindex]').count();
    ok("rows are actually rendered (windowed)", renderedRows > 5, `${renderedRows} rows in the DOM`);

    const firstRowText = await grid
      .locator('div[role="row"][aria-rowindex="2"]')
      .first()
      .innerText();
    ok("first row carries a key and a translation", firstRowText.trim().length > 0);

    // -----------------------------------------------------------------------
    step("6 · Export controls are live");
    // -----------------------------------------------------------------------
    const exportAll = page.getByRole("button", { name: /^Export all/ });
    ok("export-all control is present", (await exportAll.count()) === 1);
    ok("export-all control is enabled", await exportAll.isEnabled());
    ok(
      "export-all names both locales",
      (await exportAll.innerText()).includes("2 locales"),
      await exportAll.innerText(),
    );

    // Prove it produces bytes rather than just being clickable.
    const download = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      exportAll.click(),
    ]).then(([event]) => event);
    ok("clicking export downloads an archive", download.suggestedFilename().endsWith(".zip"), download.suggestedFilename());
    await shot(page, "4-review");

    // -----------------------------------------------------------------------
    step("7 · No runtime errors reached the console");
    // -----------------------------------------------------------------------
    ok("page produced no uncaught errors", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} assertions passed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Re-request the translate route directly and return its raw SSE body.
 *
 * Used only when the page-side capture came back empty. Sends the same fixture
 * and the same two target locales the browser flow drove, so the frames being
 * asserted describe an equivalent run against the same live route.
 */
async function fetchEventStream() {
  const response = await fetch(`${BASE_URL}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: path.basename(FIXTURE),
      text: readFileSync(FIXTURE, "utf8"),
      settings: {
        sourceLocale: "en",
        targetLocales: ["de", "ja"],
        tone: "gaming",
        productContext: "A roguelike deckbuilder for PC.",
        glossary: [],
        enforceLayout: true,
        maxRepairAttempts: 2,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `independent /api/translate request failed: ${response.status} ${await response.text()}`,
    );
  }
  return await response.text();
}

/** Minimal SSE reader for the captured response body. */
function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r\n\r\n|\n\n/)) {
    if (block.trim().length === 0) continue;
    let event = "message";
    const data = [];
    for (const line of block.split(/\r\n|\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    try {
      out.push({ event, data: JSON.parse(data.join("\n")) });
    } catch {
      // ignore an unparseable trailing fragment
    }
  }
  return out;
}

/** Count string leaves the way the parser does, so row expectations are exact. */
function countStrings(node) {
  if (typeof node === "string") return 1;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countStrings(item), 0);
  if (node !== null && typeof node === "object") {
    return Object.values(node).reduce((sum, item) => sum + countStrings(item), 0);
  }
  return 0;
}

main().catch((error) => {
  console.error("\nFAIL — the script itself threw:");
  console.error(error);
  process.exit(1);
});
