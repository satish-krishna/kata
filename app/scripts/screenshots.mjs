// Release screenshot capture for the Kata Workbench.
//
// Serves the Angular app with `ng serve` on port 4318 (so it won't clash with
// `tauri:dev` on 1420), drives the installed Chrome via playwright-core, and
// captures the key views in browser/fixtures mode (outside Tauri the transport
// is the mock one — deterministic, no live engine).
//
//   npm run screenshots                 # serve with ng serve, capture all views
//   npm run screenshots -- --url URL    # capture against an already-running server
//   SCREENSHOTS_OUT=path npm run screenshots
//
// Requires Google Chrome (channel: "chrome"); falls back to Edge if absent.

import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "../parity/capture.mjs";

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
const PORT = 4318;

// Copied from check-parity.mjs: start `ng serve`, resolve once it is listening.
async function serve() {
  const child = spawn("npx", ["ng", "serve", "--port", String(PORT), "--configuration", "production"], { cwd: appRoot, shell: true });
  let seen = "";
  try {
    await new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error("ng serve did not start in 180s")), 180000);
      child.stdout.on("data", (d) => {
        // ng colors "Local" and ":" separately, so strip ANSI before matching.
        seen += String(d).replace(/\u001b\[[0-9;]*m/g, "");
        if (/Local:\s+http/.test(seen)) { clearTimeout(t); ok(); }
      });
      child.on("exit", (c) => fail(new Error(`ng serve exited ${c}`)));
    });
  } catch (e) { stop(child); throw e; }
  return child;
}

// `shell: true` puts a shell between us and ng, so child.kill() would leave ng
// serving on the port. Kill the whole tree.
function stop(child) {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else child.kill();
  } catch { /* already gone */ }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  let server;
  let base = urlArg?.replace(/\/$/, "");
  if (!base) {
    server = await serve();
    base = `http://localhost:${PORT}`;
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

  // The resumed run then pauses on a permission check; allow it so it finishes.
  const allow = page.getByRole("button", { name: "Allow · resume" });
  await allow.waitFor({ state: "visible", timeout: 15_000 });
  await allow.click();
  await ready(".wb-summary", 15_000);

  // Open the subagent's tool card so the shot shows its nested calls.
  await page.locator(".k-toolcard__row", { hasText: "Agent" }).first().click();
  await page.waitForTimeout(250);
  await shoot("03-observe-complete");

  // Library — saved katas, run history, and the run detail.
  await page.goto(base + "/library", { waitUntil: "networkidle" });
  await ready(".wb-kata");
  await shoot("04-library");

  await browser.close();
  if (server) stop(server);

  console.log(`\n${written.length} screenshot(s) written to ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
