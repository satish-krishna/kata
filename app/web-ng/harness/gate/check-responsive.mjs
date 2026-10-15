import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, launchChromium, visitBreakpoint } from '../playwright/serve-and-visit.mjs';
import { formatCorrectiveMessage } from './responsive-guidance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');

// Independent in-page check. Distinct code from the auditor's inPageMeasure.
function pageCheck({ tol, anchorSelector }) {
  const vw = window.innerWidth;
  const fails = [];
  const sel = (el) => {
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
    const c = (el.getAttribute && el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
    return el.tagName.toLowerCase() + (c ? '.' + c : '');
  };
  const scrollAncestor = (el, root) => {
    let e = el.parentElement;
    while (e && e !== root.parentElement) {
      const o = getComputedStyle(e).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
      e = e.parentElement;
    }
    return false;
  };
  // Hidden-element exemption, expressed differently from the auditor's: use
  // Element.closest() (native ancestor-selector matching) for the aria-hidden
  // check, and a separate manual parentElement walk for display/visibility,
  // since those need getComputedStyle rather than a selector match. Not
  // bounded by the measured root, and it does NOT consider transform/position,
  // so an element merely translated off-screen still fails.
  // The visually-hidden exemption is folded into the same predicate, but
  // expressed on the element's own rect rather than an ancestor walk: the
  // screen-reader-only pattern collapses the element itself, so the largest
  // side of its own box is what matters. Math.max(w, h) <= 1 is the same
  // boundary as "both dimensions at most 1px", just phrased the other way.
  // The 0x0 case is already gone by the time isExempt runs (the caller skips
  // zero-area rects first), so this only ever fires for a genuinely 1px box.
  const isExempt = (el, rect) => {
    if (el.closest('[aria-hidden="true"]')) return true;
    for (let e = el; e; e = e.parentElement) {
      const ecs = getComputedStyle(e);
      if (ecs.display === 'none' || ecs.visibility === 'hidden') return true;
    }
    return Math.max(rect.width, rect.height) <= 1;
  };
  if (document.documentElement.scrollWidth - vw > tol) {
    fails.push({ kind: 'viewport-escape', selector: 'html', detail: 'page scrolls horizontally' });
  }
  const root = document.querySelector(anchorSelector) || document.body;
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (isExempt(el, r)) continue;
    const cs = getComputedStyle(el);
    if ((r.right - vw > tol || r.left < -tol) && !scrollAncestor(el, root)) {
      fails.push({ kind: 'element-escape', selector: sel(el), detail: 'right ' + Math.round(r.right) + ' vs ' + vw });
    }
    const hidX = (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth - el.clientWidth > tol;
    const hidY = (cs.overflowY === 'hidden' || cs.overflowY === 'clip') && el.scrollHeight - el.clientHeight > tol;
    if (hidX || hidY) fails.push({ kind: 'element-clip', selector: sel(el), detail: 'clipped' });
  }
  return fails;
}

export async function assertResponsive({ origin, route, breakpoints = [375, 768, 1280], tolerancePx = 1, anchorSelector = 'app-hero-detail', browser: given }) {
  const browser = given ?? (await launchChromium());
  const failures = [];
  try {
    for (const bp of breakpoints) {
      const { page, context } = await visitBreakpoint(browser, `${origin}/${route}`, bp);
      const fails = await page.evaluate(pageCheck, { tol: tolerancePx, anchorSelector });
      for (const f of fails) failures.push({ breakpoint: bp, ...f });
      await context.close();
    }
  } finally {
    if (!given) await browser.close();
  }
  return { failures };
}

function parseCliArgs(argv) {
  const get = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  return { anchor: get('--anchor', 'app-hero-detail') };
}

async function cli() {
  const { anchor } = parseCliArgs(process.argv.slice(2));
  execFileSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true });
  const srv = await serveStatic(DIST, { spaFallback: true });
  try {
    const { failures } = await assertResponsive({ origin: srv.origin, route: 'detail/11', anchorSelector: anchor });
    if (failures.length) {
      process.stderr.write(formatCorrectiveMessage(failures) + '\n');
      process.exit(1);
    }
    process.stdout.write('responsive check passed at 375, 768, 1280\n');
  } finally {
    await srv.close();
  }
}

if (process.argv[1]?.endsWith('check-responsive.mjs')) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}
