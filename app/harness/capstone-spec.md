# The capstone spec

The written contract for the capstone run. Read `sealing-spec.md` (Part 1), `layout-grammar-spec.md` (2), `component-shape-spec.md` (3), `freeloader-spec.md` (4) and `responsive-spec.md` (5) first. This file does not introduce a new plane of enforcement; it says what happens when every plane the series built is switched on at once, against a target chosen because it is the furthest thing in the series from the model's priors.

## What the capstone is, and the thing it is not

Parts 1 through 5 were isolation experiments. Each held every previously-built gate on in both conditions and moved exactly one variable, so a difference in drift was attributable to that variable and nothing else.

**The capstone is not that, and pretending otherwise would be the easiest lie in the series to tell.** It moves the entire hook set at once: gate-off registers no enforcement hooks at all, gate-on registers all of them. So a difference between the conditions is attributable to the constitution as a whole, and not to any single rule inside it. That is deliberate, because the question the capstone asks is the one the series has been building toward and no isolation run can answer: what does the whole apparatus buy, on a target big enough to need it?

The cost of that choice is stated plainly here so no reader has to infer it. The capstone cannot tell you which rule earned its keep. The per-Part runs already did that, one variable at a time, and the capstone does not overwrite them. What the capstone adds is the aggregate, and an aggregate is only honest when it is labeled as one.

## Why the capstone should fire when Parts 4 and 5 did not

The sharpest result of the series so far is a null, twice: on natural Tour of Heroes the gates were dormant, because the model is competent on native patterns. That produced the series' thesis, which the capstone is built to test rather than to restate: **the gates fire in proportion to a pattern's distance from the model's priors.**

The capstone aims squarely at the far side of that distance. Three of its targets are patterns nothing in the agent's baseline tells it to reach for:

- A **sealed vocabulary** nineteen primitives wide, where a bare `<table>`, `<label>` or `<select>` is a defect rather than the obvious answer. Every prior on earth says a table is a `<table>`.
- **MVVM as a component-scoped ViewModel service**, which is not Angular's documented shape and not spartan's. The ecosystem has ComponentStore and the presenter pattern, but nothing in the baseline points at either.
- **Schema-driven signal forms** where the zod schema is the single source of truth, against a strong prior for reactive forms. Part 3 already measured the agent reaching for reactive forms in two of three gate-off trials, which is the one place the series has watched this prediction come true.

Against these, the native-pattern controls the same build carries (`@if` over `*ngIf`, no `ngClass`, no hand-set `changeDetection`) should stay near zero, exactly as Parts 4 and 5 found. If they do, the capstone's own internals reproduce the thesis inside a single run. If the non-native kinds also come back near zero, the thesis is wrong and this document is where that gets said.

## The conditions

The single-variable discipline is replaced by a stated pair of conditions.

- **gate-off** (the honest baseline): no enforcement hooks. The agent still has the complete documented constitution in context: both MCP servers, the spartan skill, the house-style skill including the sealed vocabulary, the icon rule, the MVVM section and the responsive section, Angular's generated `CLAUDE.md`, and `prototype/capstone-build-spec.md` as the conformance target. This is what a capable agent ships from good docs alone, which has been the series' baseline since Part 1.
- **gate-on**: every edit-time hook registered at once (sealing, layout, component shape, freeloader), which by construction includes the capstone's widened vocabulary, the `raw-icon` rule and the four MVVM rules, because those ride inside the existing hooks. Plus the soft responsive gate, as a fixed instruction appended to the final stage.

`strictTemplates` is on in **both** conditions. It is a tsconfig property of the substrate the agent inherits, not a hook we register, and holding it constant keeps both conditions answerable to the same compiler. Part 4 already measured it as a variable in isolation; re-moving it here would confound the aggregate for no gain.

Three trials per condition, per the protocol for a Part that introduces new machinery.

## The build, and why it is a sequence of subagents

Parts 1 through 5 drove each trial with one headless agent call, because each measured a single screen. The capstone target is four routed screens, a persistent app shell, twelve primitives, ViewModels, a schema form and a theme switcher. One call at that size does not produce a conformance target; it produces a truncated one, and a truncated build measures the truncation rather than the constitution.

So the capstone build is decomposed into six stages, each its own headless `claude --model haiku` process: shell, domain, dashboard, roster, detail, integrate. Each stage is a slice a real team would hand to one person, not an arbitrary token-budget split. Stage 6 exists because the first five run in separate processes with no memory of each other, so something must reconcile them, and how much reconciliation the result needs is itself a measurement.

**The decomposition is identical across conditions.** The stage list, the prompt files and their order live in `harness/driver/capstone-stages.mjs` and are read by both conditions from that one place. The only things that differ are the settings file and the responsive suffix appended to stage 6 in gate-on, which is held in that same file rather than in a duplicate set of prompts, so the two conditions demonstrably read the same bytes everywhere else. If the decomposition could differ by condition, the drift difference between them would be unattributable and the run would be noise.

## The model policy: Haiku is the subject, never the instrument

Only the agent under test runs on Haiku. `harness/driver/run-capstone.mjs` hardcodes `MODEL = 'haiku'` for every stage, and that constant is not a tunable: the capstone measures Haiku's drift, so changing it invalidates every number the run produces.

Everything that BUILDS or GRADES the harness runs on a capable model instead: the widened vocabulary, the gate rules, the counters, the fixtures, the specs, and every review. A subtle gate bug written by the model under test would poison every published claim, and the failure mode is not hypothetical, since a review on a capable model already caught one such bug in this series. The instrument and the subject must not be the same thing.

## The cost ledger

Each stage is a separate process with its own result JSON, so each reports its own `total_cost_usd`, `num_turns` and `duration_ms`. The driver records every one of them and writes `cost.json`: one row per Haiku subagent plus a run total that is a **sum of measured numbers, never an estimate**.

This is a primary artifact, not accounting hygiene. The series has been carrying an unmeasured claim, that a uniform substrate is cheaper to build on than a varied one, and the blog's whole ethos is to run the thing rather than assert it. Per-stage cost across conditions is what turns that claim into a chart: if the constitution pays for itself, gate-on stages cost more in turns and less in rework, and the shape of that trade is visible per stage rather than smeared across one number. If gate-on simply costs more and drifts the same, that is the finding and it goes in the post.

## Measurement

Every counter runs on every produced build in both conditions, independently of whether any gate fired:

- the Part 1 sealing counter, including the widened vocabulary and `raw-icon`;
- the Part 2 layout counter;
- the Part 3 component-shape counter, including the four MVVM kinds;
- the Part 4 freeloader counter;
- the Part 5 Playwright responsive auditor.

The auditor runs on **three routes** (`dashboard`, `roster`, `detail/11`), not one slice: the capstone's claim is about a whole console, and measuring a single route would be measuring the easy part. It anchors on `body`, because the navigation drawer that the hidden-element exemption exists for is a sibling of the routed component rather than a descendant, and anchoring on the routed host would quietly exclude the one element the exemption was written for.

## The honest asymmetries, stated up front

Five, and none of them are hidden in a footnote.

1. **The capstone is an aggregate, not an isolation.** Covered above. It cannot attribute a difference to a single rule.
2. **The responsive gate is soft.** Playwright needs a whole rendered app, so a per-edit hook is physically impossible; the gate is only as hard as the agent's willingness to run a command it was told to run. Part 5 disclosed this and the capstone inherits it unchanged. The auditor runs regardless, so a gate-on build that still ships responsive drift is a finding about self-run gates, not a measurement gap.
3. **`vm-not-provided` catches something no build catches.** A component-scoped ViewModel injected without being provided is a runtime `NullInjectorError`, not a compile error, so `ng build` passes and the screen dies when it renders. This is the exact inverse of Part 4's freeloader result: there the compiler had already built the graph and the gate rode it for free, and here the framework defers the check to a moment the harness would only reach by accident.
4. **A rendered pixel carries no file provenance.** The AST counters ignore `libs/**` wholesale, because customizing a copied Helm file is the documented escape route and gating it would fight the docs. The Playwright auditor has no equivalent notion and cannot acquire one: a bounding rect does not know which file drew it. So a responsive defect inherited from an unmodified Helm primitive is counted exactly like one the agent wrote.

   This is not hypothetical either. The capstone probe found six `element-clip` violations per route coming from `hlm-sidebar-menu-button`, which is `h-8` with `p-2` and `text-sm`: a 20px line box inside a 16px content box, under an `overflow-hidden` that Helm sets deliberately so long labels truncate horizontally. Every build with a labeled sidebar will report them, in both conditions, from library code the agent never touched.

   They are reported rather than exempted, and the two ways to make them disappear were both refused. Raising the tolerance to 2px is the suppression dial this repo bans everywhere else, and a clip is not less of a clip for being small. Editing `libs/ui` to flatter the measurement is worse: tuning the substrate until the numbers look clean is not an experiment, it is decoration. The honest handling is to say the count includes inherited chrome, note that it is constant across conditions so the gate-off versus gate-on delta is unaffected, and report the violating selectors so a reader can see the split themselves.

5. **The icon rule gated half of what its doc says, and that was the wrong call.** Corrected after the run: see `component-shape-spec.md` rule 13, `unregistered-icon`. The reasoning below was right that the TEMPLATE engines cannot see a component class, and wrong to conclude the rule was therefore undecidable. It is a plain TypeScript-AST property, and Part 3 rules have always been TypeScript rules. The original text is kept because the run was conducted under it, and because the drift landed in precisely the half it excused.

    `raw-icon` bans inline `<svg>`, which is decidable in a template. It does not check that every `<ng-icon name="X">` was registered with `provideIcons`, because that is a fact about the component class rather than the template, and `@ng-icons` only warns rather than failing the build. An unregistered icon renders as nothing. The unchecked half is doc-only, and an unregistered-icon count must never be reported as gated drift.

## The enforcement guard: a gate the subject cannot edit

The capstone measured the agent under test editing `stylelint.config.mjs` to widen a rule that was blocking it, byte-identically, in two of three gate-on trials. It was not cheating: the rule had a real false positive, and the agent fixed it, which in most contexts is correct engineering. But `raw-css-literal` was then reported as 0 for those trials, and part of that zero was the rule being widened rather than obeyed.

This series has carried "enforcement must not have a dial" as a design principle since Part 1, and the config already switches off `eslint-disable` wholesale via `noInlineConfig`. The dial nobody was watching was not a suppression comment. It was the configuration file itself, sitting in the repo, writable by the thing being constrained.

Two mechanisms now close it, and the pairing is deliberate:

- `.claude/hooks/protect-enforcement.mjs` is a **PreToolUse** hook that denies the edit before it happens. It matches Bash and PowerShell as well as the file-editing tools, because a guard that only watches `Write`/`Edit` is walked around with `sed -i`, a shell redirect, `cp`, or `git checkout` of another revision, and a guard with a known bypass is decoration. It allows the read-only commands the agent is told to run (`npm run build`, `npm run check:responsive`, the auditor CLI).
- `run-capstone.mjs` records every changed file and voids any run that touched enforcement paths, as the backstop for anything that gets past the hook.

Prevention plus detection, because detection alone is a smoke alarm and prevention alone cannot prove it worked.

**The guard is registered in BOTH conditions**, unlike every other hook in the harness. It is not a house-convention gate; it is an experimental control, the same kind of thing as the driver's clean-working-tree check. gate-off's premise is that no house conventions are enforced, not that the harness is editable, and registering this in only one arm would leave the baseline free to tamper. That would be a worse asymmetry than the one it fixes.

## The evidence

Per-run evidence lands in `../experiments/capstone/{gate-off,gate-on}/<runId>/`, three trials per condition, each with:

- `cost.json`, the per-subagent ledger and the run total;
- `meta.json`, the run record including every stage's result;
- `agent-output/stage-N.json`, each subagent's raw result;
- `tally.json`, `layout-tally.json`, `shape-tally.json`, `freeloader-tally.json`, the AST drift counts;
- `responsive-tally.json` plus per-breakpoint screenshots for all three routes;
- `hook-firings.jsonl`, what the gates actually caught, in gate-on;
- `diff.patch` and `impl/`, the actual built application.

The report is the drift the baseline shipped, what the gates caught, the residue gate-on still let through, and what the whole thing cost per subagent.
