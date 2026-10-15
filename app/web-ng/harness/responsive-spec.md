# The responsive spec (Part 5)

The written contract for Part 5, Plane 2: manufacturing the graph. This is the genuinely new move in the series. Parts 1 through 4 either constrained a vocabulary the compiler could then police, or freeloaded on a graph the compiler already built. Plane 2 has no graph to ride: whether a screen reflows at 375px lives in rendered pixels, and nothing built a model of that. So Part 5 builds one. It renders each slice at fixed breakpoints and measures it, turning "responsive" from a matter of taste into a matter of overflow in pixels.

Read `sealing-spec.md`, `layout-grammar-spec.md`, `component-shape-spec.md`, and `freeloader-spec.md` first. Part 5 keeps the cumulative-baseline model: by Part 5 the Parts 1 through 4 gates are baseline, on in both conditions, and `strictTemplates` stays on. The single variable is the responsive gate.

## Doc-first, because there is no framework rule to mechanize

Part 4 needed no doc-first work: `@if` over `*ngIf` and no `ngClass` are Angular's own rules, already in the agent's baseline `CLAUDE.md`. Plane 2 is different. Angular has no documented rule that says "the detail form must not overflow at 375px," and there is no compiler option that decides it. So the load-bearing principle still holds only if the definition of "correct" is written down as a doc the agent reads in both conditions, before any gate mechanizes it. Part 5 adds a "responsive correctness" section to the house-style skill (both mirrors, byte-identical), and the gate enforces exactly that section, no more.

The doc states the breakpoints, the three failure kinds, the tolerance, and the three exemptions. It is transcribed into `.claude/skills/house-style/SKILL.md` and `.agents/skills/house-style/SKILL.md` as a new section, and this spec is the source of its wording.

## What the house-style doc says (the graph, defined in pixels)

A screen is responsive-correct when, at each of three breakpoints, it commits none of three failures. The breakpoints are the viewport widths the auditor sets, height fixed at 900px:

- 375px, a small phone.
- 768px, a tablet.
- 1280px, a laptop.

The three failure kinds, each decidable from the rendered DOM with no model in the loop:

1. **`viewport-escape`.** The document scrolls horizontally: `document.documentElement.scrollWidth` exceeds the viewport width by more than a 1px sub-pixel tolerance. The page must never scroll sideways at these widths. This is the strongest and least ambiguous signal.
2. **`element-escape`.** An element inside the measured slice has a bounding-rect right edge past the viewport width, or a left edge below zero, beyond tolerance. This catches an element poking off-screen even when an `overflow: hidden` ancestor swallowed the page scrollbar, so `viewport-escape` alone read clean. An element that is not being shown to the user is exempt, see the hidden-element exemption below.
3. **`element-clip`.** An element clips its own content: its computed `overflow-x` or `overflow-y` is `hidden` or `clip`, and its `scrollWidth` exceeds its `clientWidth` (or `scrollHeight` its `clientHeight`) beyond tolerance. Content is cut off with no way to reach it.

There are three exemptions, and they are the reason the spec does not drown in false positives. Two of the three were found by running the auditor over a real rich layout rather than reasoned out in advance, which is worth stating plainly: the simple Part 5 slices were not complex enough to surface either.

**The scroll-container exemption.** An element whose computed overflow on the measured axis is `auto` or `scroll` is an intentional scroll container, not a bug, and is exempt from `element-clip`; an element inside one is exempt from `element-escape`. A deliberately scrollable panel is a design choice; a truncated label under `overflow: hidden` is a defect.

**The hidden-element exemption (added by the capstone).** An element that is not being shown to the user commits neither `element-escape` nor `element-clip`, because there is nothing on screen to escape or to truncate. An element counts as not shown when it, or any ancestor, is `display: none`, `visibility: hidden`, or carries `aria-hidden="true"`.

This exemption exists because the capstone's layout has a navigation rail that becomes an off-canvas drawer below 768px, and running the Part 5 auditor over that layout showed the closed drawer reading as `element-escape`: a drawer parked off-screen with a transform has a negative left edge, which is precisely the geometry the rule was written to catch. The Part 5 slices had no sidebar, so the case never arose. The naive fix, exempting any element with a negative left edge, would gut the rule. The correct fix is narrower and is a real accessibility rule rather than a measurement dodge: the drawer must actually be hidden.

That is the load-bearing half of this exemption, and it is why the exemption makes the gate stricter rather than laxer. A drawer merely translated out of view is still rendered, still in the tab order, and still read by a screen reader, so it is a genuine defect and stays a violation. Only a drawer that is properly `display: none`, `visibility: hidden`, or `aria-hidden` when closed is exempt, and a drawer in that state is one that also behaves correctly for keyboard and assistive-technology users. The exemption is written so that the only way to satisfy it is to fix the accessibility bug, which means a build cannot buy its way past the responsive gate by hiding a problem; it has to hide the element honestly.

`display: none` was already exempt before this change, incidentally, but only by accident: such an element has a zero-area bounding rect and the auditor skips zero-area elements. The capstone makes the exemption explicit and extends it to `visibility: hidden` and `aria-hidden`, which keep their boxes, so the behavior no longer rests on an implementation detail.

**The visually-hidden exemption (added by the capstone).** An element whose rendered box is at most 1x1 CSS pixel in BOTH dimensions is not shown to the user either, and commits neither `element-escape` nor `element-clip`.

This is the screen-reader-only pattern, and it is the exact mirror of `aria-hidden`: an `aria-hidden` element is visible but not announced, and a visually-hidden span is announced but not visible. Both are absent from the sighted user's screen, which is the only thing these two failure kinds are about. The pattern is implemented by collapsing an element to a 1px box and clipping its text, so by construction it trips `element-clip` on every screen that uses it, and it is used by spartan's own primitives.

Without this exemption the gate penalizes a build for labeling its icon-only buttons for screen readers, which is worse than useless: it is a responsive gate that pushes back against accessibility. The capstone probe measured exactly that, eight times per route, entirely from Helm's own markup.

The 1px threshold is not a new number. It is the same 1px the spec already uses as its comparison tolerance, applied to a box rather than to a difference, and nothing a user can read fits inside it.

The tolerance is 1px on every comparison, to absorb sub-pixel rounding, and it is stated in the doc so the gate cannot quietly widen it. Note what is deliberately NOT here: no threshold that excuses a clip for being small. A clip of two pixels is still a clip, and raising the tolerance until a run comes back clean is the suppression dial this repo bans everywhere else.

## The measurement model (cumulative baseline)

By Part 5 the Parts 1 through 4 hooks are baseline, on in both conditions, and `strictTemplates` is on in both. Part 5 moves one thing:

- **gate-off** (the baseline): Parts 1 through 4 gates on, `strictTemplates` on, no responsive gate. This is the screen an agent ships today from good docs, a responsive doc included, with nothing rendering and measuring it.
- **gate-on**: the same, plus the responsive gate active during the agent's run, so a build that overflows at a breakpoint fails the check and the agent must fix it before the task is done.

The auditor runs on every produced build in both conditions and counts drift independently of the gate. The report is the drift the gate-off builds shipped, what gate-on caught and fixed, and any residue gate-on still let through.

## The slice, the route, and the seed

The measured slice is the hero detail and edit screen, the same slice Parts 3 and 4 used, built by the agent from `task-prompt-detail-form.md`. It is a titled detail card over an edit form: a labeled name field, a Save button, and a Cancel button. The route is `detail/:id`, and the app seeds a dozen in-memory heroes, so the auditor navigates to a known id (`detail/11`) with a hero already loaded, because an empty form cannot overflow. The natural task is run unchanged; nothing is added to induce overflow, per the honest-reporting decision for this Part. If the natural run overflows, the gate has something to catch; if it does not, that is the finding, stated plainly, the way Part 4 reported its zeros.

## The auditor (independent measurement, no model)

`harness/counter/responsive-auditor.mjs` is the Plane 2 equivalent of the AST counters. It shares no measurement code with the gate; the two agree only on this spec. It:

- Builds the app (`ng build`) and serves `dist/angular-jig/browser` on an ephemeral local port with a single-page-app fallback, so a direct navigation to `detail/11` resolves to `index.html` and the client router takes over. It starts the server, measures, and tears the server down; it never runs `ng serve`, which hangs.
- Launches headless Chromium through Playwright. For each breakpoint it sets the viewport, navigates to the slice route, waits for the page to settle, then runs one in-page measurement function that walks the slice subtree and returns every violation as `{ kind, selector, breakpoint, detail }`.
- Writes `responsive-tally.json` (the counts per kind per breakpoint, plus the ordered violation list) and one screenshot per breakpoint under the run's evidence folder.

The slice subtree measured is the routed component's host and its descendants, found from a stable anchor, so chrome outside the slice does not pollute the count. `viewport-escape` is a page-level check and is measured against the document regardless.

The anchor is a selector, passed to both engines as `--anchor`, defaulting to `app-hero-detail` so Part 5's own runs are unchanged; if the selector matches nothing the engines fall back to `body`. The capstone passes `--anchor body` deliberately. Its screens live inside a persistent app shell, and the navigation drawer that the hidden-element exemption exists for is a sibling of the routed component, not a descendant of it. Measuring only the routed host on the capstone would exclude the single element the exemption was written for, which would be a measurement that quietly avoids looking at the interesting part.

### Flakiness is the enemy; these controls kill it

Pixel measurement wanders unless it is pinned, so the auditor:

- waits for `networkidle` and for `document.fonts.ready` before measuring, so late layout shifts do not race the measurement.
- injects a stylesheet disabling all CSS animations and transitions, so nothing is mid-motion when measured.
- fixes the device-scale-factor and the viewport height, and uses the deterministic seed data, so the same build renders identically every run.

The determinism self-test (`responsive-auditor.test.mjs`) runs the auditor twice over one committed build and asserts an identical tally, exactly as the AST counters self-test. If the auditor cannot pass its own self-test, its numbers are worthless and nothing downstream is trusted. This proves the measurement does not wander; the three agent trials prove the drift reduction, if any, is real across the agent's variance.

## The gate (enforcement), and the asymmetry it does not hide

`npm run check:responsive` is the gate. It is separate code from the auditor, sharing only a thin launch-build-serve-and-navigate helper (`harness/playwright/serve-and-visit.mjs`); the assertion logic is written independently, so a disagreement between gate and auditor on the same build is a finding, not a rounding error, exactly as with the two-engine AST specs. On any failure it exits non-zero with a corrective message that names the failing breakpoint, the offending element, and the doc's definition of the failure, following the corrective-message convention Part 3 proved (0 of 3 to 3 of 3). The message hands back the doc, never new guidance invented at the gate.

The boundary is the build, not the edit. Playwright needs the whole rendered app, so a per-file edit-time hook is physically impossible; this is the same nature-forced call Part 4 made for `strictTemplates`. In gate-on the task prompt instructs the agent to run `npm run check:responsive` and fix until it passes, exactly as it already runs `ng build`.

The honest asymmetry, stated here so the post cannot paper over it: `strictTemplates` is a hard gate, because the compiler fails the build and the agent cannot proceed. `check:responsive` is only as hard as the agent's willingness to run a command it was told to run. That is a genuinely weaker gate. So the driver runs the auditor independently no matter what, and a gate-on build that still ships responsive drift is not a measurement gap; it is a finding about how far a self-run gate holds versus a compiler-hard one. Part 5 reports that difference rather than hiding it, and it may be the most interesting thing the Part turns up.

## The tally shape (the auditor's output contract)

```json
{
  "totals": { "viewport-escape": 0, "element-escape": 0, "element-clip": 0, "all": 0 },
  "byBreakpoint": {
    "375": { "viewport-escape": 0, "element-escape": 0, "element-clip": 0 },
    "768": { "viewport-escape": 0, "element-escape": 0, "element-clip": 0 },
    "1280": { "viewport-escape": 0, "element-escape": 0, "element-clip": 0 }
  },
  "violations": [
    { "kind": "element-escape", "breakpoint": 375, "selector": "form > .actions", "detail": "right edge 412px exceeds viewport 375px" }
  ]
}
```

`totals.all` is the sum of the three kinds across all breakpoints. `violations` is ordered by breakpoint, then kind, then selector, so the same rendered build serializes byte-identically. The gate reports the same kinds by the same names; the strings match on both sides.

## What each engine does, and why they stay independent

- The **auditor** owns the tally. It measures with its own in-page code and writes `responsive-tally.json`. It is the drift count, never the gate's fire count.
- The **gate** owns enforcement. It runs its own assertion during the agent's build and exits non-zero to force a fix.
- They share only `serve-and-visit.mjs`, the plumbing that builds, serves the bundle with SPA fallback, launches Chromium, and navigates to a breakpoint. Neither imports the other's measurement logic.

Two independent measurements of one rendered screen, one spec. The independence is load-bearing for the same reason it is in Parts 1 and 2: if drift were whatever the gate flagged, the gate would reduce it to zero by construction and prove nothing. The auditor is the audit the gate does not touch.

## The evidence

Per-run evidence lands in `../experiments/part5/detail-form/{gate-off,gate-on}/`, three trials per condition, each with the built `impl/`, the `responsive-tally.json`, the three breakpoint screenshots, the diff, and the run record. Three trials per condition because Part 5 introduces brand-new machinery (the first Playwright auditor) and is therefore a proving Part under the protocol, not a one-trial rider on already-proven machinery.
