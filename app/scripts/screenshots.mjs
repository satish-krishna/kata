// Release screenshot capture for the Kata Workbench.
//
// Spins up the SvelteKit dev server in-process on a free port (so it won't
// clash with `tauri:dev` on 1420), drives the installed Chrome via
// playwright-core, and captures the key views in browser/fixtures mode
// (`inTauri()` is false, so it uses mock.ts — deterministic, no live engine).
//
//   npm run screenshots                 # serve in-process, capture all views
//   npm run screenshots -- --url URL    # capture against an already-running server
//   SCREENSHOTS_OUT=path npm run screenshots
//
// Requires Google Chrome (channel: "chrome"); falls back to Edge if absent.

import { chromium } from "playwright-core";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const repoRoot = resolve(appRoot, "..");

const args = process.argv.slice(2);
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const urlArg = argVal("--url");
const outArg = argVal("--out") ?? process.env.SCREENSHOTS_OUT;
const outDir = outArg ? (isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg)) : join(repoRoot, "docs", "screenshots");

// Desktop-only product (laptop → ultrawide); 2x for crisp retina output.
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;

async function launchBrowser() {
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      if (channel === "msedge") {
        throw new Error(`Could not launch Chrome or Edge for screenshots.\n${e.message}`);
      }
    }
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  let server;
  let base = urlArg?.replace(/\/$/, "");
  if (!base) {
    // Random free port + non-strict so a running tauri:dev (1420) doesn't block us.
    server = await createServer({
      root: appRoot,
      configFile: join(appRoot, "vite.config.js"),
      logLevel: "warn",
      server: { port: 0, strictPort: false, open: false },
    });
    await server.listen();
    base = server.resolvedUrls.local[0].replace(/\/$/, "");
    console.log(`serving ${base}`);
  } else {
    console.log(`using ${base}`);
  }

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const written = [];

  const ready = async (selector, timeout = 10_000) => {
    await page.waitForSelector(selector, { state: "visible", timeout });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
  };
  const shoot = async (name) => {
    const file = join(outDir, `${name}.png`);
    await page.screenshot({ path: file });
    written.push(file);
    console.log(`captured ${name}`);
  };

  // Compose pane — the form at rest.
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await ready(".wb-toolbar");
  await shoot("01-compose");

  // Observe pane — the scripted run pauses on the interactive ask_user panel.
  await page.goto(base + "/?demo=run", { waitUntil: "networkidle" });
  await ready(".k-ask", 30_000);
  await shoot("02-observe-ask");

  // Answer the ask (first option / sample text per question) so the run resumes
  // and finishes, surfacing the run.completed summary (exit / turns / cost).
  const groups = page.locator(".k-ask__q");
  for (let i = 0; i < (await groups.count()); i++) {
    const g = groups.nth(i);
    if (await g.locator("textarea").count()) {
      await g.locator("textarea").fill("Confirmed — proceed.");
      continue;
    }
    const opt = g.locator(".k-ask__opt, .k-ask__confirm-btn").first();
    if (await opt.count()) await opt.click();
  }
  await page.locator(".k-ask__foot button.k-btn--primary").click();
  await ready(".wb-summary", 15_000);
  await shoot("03-observe-complete");

  // Library — saved katas, run history, and the run detail.
  await page.goto(base + "/library", { waitUntil: "networkidle" });
  await ready(".wb-kata");
  await shoot("04-library");

  await browser.close();
  if (server) await server.close();

  console.log(`\n${written.length} screenshot(s) written to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
