import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic, launchChromium, visitBreakpoint } from '../playwright/serve-and-visit.mjs';

export function inPageMeasure({ tolerancePx, anchorSelector }) {
  const vw = window.innerWidth;
  const out = [];
  const cssPath = (el) => {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && parts.length < 5) {
      let seg = e.tagName.toLowerCase();
      if (e.id) { seg += '#' + e.id; parts.unshift(seg); break; }
      const cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      parts.unshift(seg);
      e = e.parentElement;
    }
    return parts.join(' > ');
  };
  const insideScrollContainer = (el, root) => {
    let e = el.parentElement;
    while (e && e !== root.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true;
      e = e.parentElement;
    }
    return false;
  };
  // Hidden-element exemption: an element is not shown to the user when it, or
  // ANY ancestor (walked all the way to the document, not just up to the
  // measured root), is display:none, visibility:hidden, or aria-hidden="true".
  // A single walk checks all three conditions per node. This deliberately does
  // NOT look at transforms or position: an element merely translated
  // off-screen is still rendered, still focusable, still exposed to
  // assistive tech, and stays a violation.
  const isNotShownToUser = (el) => {
    let e = el;
    while (e && e.nodeType === 1) {
      if (e.getAttribute('aria-hidden') === 'true') return true;
      const ecs = getComputedStyle(e);
      if (ecs.display === 'none' || ecs.visibility === 'hidden') return true;
      e = e.parentElement;
    }
    return false;
  };
  // Visually-hidden exemption: a box at most 1x1 CSS pixel in BOTH dimensions
  // is the screen-reader-only pattern (collapsed and clipped, but announced),
  // and is exempt for the same reason as aria-hidden: nothing on screen to
  // escape or truncate. This checks the element's own rendered rect only, not
  // its ancestors, since the pattern is applied to the element that carries
  // the text, not inherited from a parent the way display/visibility are.
  // A 0x0 element already falls out via the zero-area skip above; this is
  // strictly the >0-but-at-most-1px case, so the two skips do not overlap.
  const isVisuallyHidden = (rect) => rect.width <= 1 && rect.height <= 1;

  // 1. viewport-escape: the document scrolls horizontally.
  const docW = document.documentElement.scrollWidth;
  if (docW - vw > tolerancePx) {
    out.push({ kind: 'viewport-escape', selector: 'html',
      detail: 'document scrollWidth ' + docW + 'px exceeds viewport ' + vw + 'px' });
  }

  // slice subtree: the anchor selector's match, else body.
  const root = document.querySelector(anchorSelector) || document.body;
  const els = root.querySelectorAll('*');
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (isNotShownToUser(el)) continue;
    if (isVisuallyHidden(rect)) continue;

    // 2. element-escape: right past viewport (or left < 0), not inside an intentional scroller.
    if ((rect.right - vw > tolerancePx || rect.left < -tolerancePx) && !insideScrollContainer(el, root)) {
      out.push({ kind: 'element-escape', selector: cssPath(el),
        detail: 'right edge ' + Math.round(rect.right) + 'px vs viewport ' + vw + 'px' });
    }

    // 3. element-clip: hidden/clip box with content larger than its client box.
    const clipX = (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && (el.scrollWidth - el.clientWidth > tolerancePx);
    const clipY = (cs.overflowY === 'hidden' || cs.overflowY === 'clip') && (el.scrollHeight - el.clientHeight > tolerancePx);
    if (clipX || clipY) {
      out.push({ kind: 'element-clip', selector: cssPath(el),
        detail: 'content ' + el.scrollWidth + 'x' + el.scrollHeight + ' clipped to ' + el.clientWidth + 'x' + el.clientHeight });
    }
  }
  return out;
}

const KINDS = ['viewport-escape', 'element-escape', 'element-clip'];

export async function measureViolations(page, tolerancePx, anchorSelector) {
  return page.evaluate(inPageMeasure, { tolerancePx, anchorSelector });
}

function emptyKindCounts() {
  return { 'viewport-escape': 0, 'element-escape': 0, 'element-clip': 0 };
}

function assemble(rawByBp) {
  const totals = { ...emptyKindCounts(), all: 0 };
  const byBreakpoint = {};
  const violations = [];
  for (const { bp, list } of rawByBp) {
    byBreakpoint[bp] = emptyKindCounts();
    for (const v of list) {
      byBreakpoint[bp][v.kind] += 1;
      totals[v.kind] += 1;
      totals.all += 1;
      violations.push({ kind: v.kind, breakpoint: bp, selector: v.selector, detail: v.detail });
    }
  }
  // Deterministic order: breakpoint asc, then kind by KINDS order, then selector.
  violations.sort((a, b) =>
    a.breakpoint - b.breakpoint ||
    KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
    a.selector.localeCompare(b.selector));
  return { totals, byBreakpoint, violations };
}

export async function auditServed({ origin, route, breakpoints = [375, 768, 1280], tolerancePx = 1, anchorSelector = 'app-hero-detail', browser: given, onPage }) {
  const browser = given ?? (await launchChromium());
  const rawByBp = [];
  // The auditor is already in the browser, so it records runtime errors here as
  // well, in its own code path. The boot GATE (harness/gate/check-boot.mjs) is
  // what blocks; this is the independent observation of the same thing, kept
  // separate for the same reason the AST counters are kept separate from the AST
  // gates. It never blocks and never filters.
  const bootErrors = [];
  try {
    for (const bp of breakpoints) {
      const { page, context } = await visitBreakpoint(browser, `${origin}/${route}`, bp);
      page.on('pageerror', (err) =>
        bootErrors.push({ breakpoint: bp, kind: 'pageerror', text: String(err?.message ?? err) }),
      );
      try {
        if (onPage) await onPage(page, bp);
        const list = await measureViolations(page, tolerancePx, anchorSelector);
        rawByBp.push({ bp, list });
      } finally {
        await context.close();
      }
    }
  } finally {
    if (!given) await browser.close();
  }
  const tally = assemble(rawByBp);
  tally.bootErrors = bootErrors;
  return tally;
}

export async function auditBuild({ distDir, route = 'detail/11', outDir, breakpoints = [375, 768, 1280], tolerancePx = 1, anchorSelector = 'app-hero-detail' }) {
  const srv = await serveStatic(distDir, { spaFallback: true });
  const browser = await launchChromium();
  try {
    if (outDir) mkdirSync(outDir, { recursive: true });
    const tally = await auditServed({
      origin: srv.origin, route, breakpoints, tolerancePx, anchorSelector, browser,
      onPage: outDir
        ? async (page, bp) => page.screenshot({ path: join(outDir, `${bp}.png`), fullPage: true })
        : undefined,
    });
    if (outDir) writeFileSync(join(outDir, 'responsive-tally.json'), JSON.stringify(tally, null, 2) + '\n');
    return tally;
  } finally {
    await browser.close();
    await srv.close();
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('responsive-auditor.mjs')) {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const distDir = get('--dist');
  if (!distDir) { console.error('usage: responsive-auditor.mjs --dist <dir> [--route detail/11] [--out <dir>] [--anchor <selector>]'); process.exit(2); }
  auditBuild({ distDir, route: get('--route', 'detail/11'), outDir: get('--out'), anchorSelector: get('--anchor', 'app-hero-detail') })
    .then((t) => { process.stdout.write(JSON.stringify(t, null, 2) + '\n'); })
    .catch((e) => { console.error(e); process.exit(1); });
}
