---
layout: 2
---

# Review findings

## Review 1

```yaml
review: 1
reviewed_at: 2026-11-18
commits: { kata: "077f13b" }
```

### F1

```yaml
id: F1
severity: high
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 973
```

The page sets `elsewhere: shown.shown.kind === 'underWay'` and shows the checks list whenever a repository is `underWay`. In the backend, `UnderWay` means the build start passed and no finish is recorded yet, which is the normal state of every build this Workbench runs once its first task launches. So during the engineer's own builds the page says the checks on the base are "running in another session, as last read" until the build finishes. The real R2.5 case is checks on the base running now in another session: no `build.start` has passed yet, so the backend answers `Startable` with checks in the running state, and the page never shows that state. The R2.5 test (`build-checks-list.spec.ts:74`) feeds `elsewhere: true` straight into the component, so no test covers the page's decision. R2.5 decides it: the list shows as last read only when the checks run in another session, never during this Workbench's own build.

### F2

```yaml
id: F2
severity: medium
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 1791
```

R10.2 says that after a stop during the checks the page says the copy may stay on the base commit, that the work is safe on the change's branch and that the next start puts it back first. The backend sends that sentence in `StartOutcome::Stopped.note` (T12), but `stoppedMessage(outcome.prepared)` ignores `note`, and so does the toast at line 1716, so the sentence never reaches the engineer. Only the backend test `steps::tests::stopped_note_says_where_the_copy_was_left_r10_2` covers it. R10.2 decides it: the page shows the note.

### F3

```yaml
id: F3
severity: medium
repo: kata
concern: spec
file: app/src/app/lib/sdlc-steps.ts
line: 26
```

R7.2 says a rerun of the checks at finish names the running check, as R2 does. The backend reports the rerun step as `rerunningFinishChecks`, but `isStep(…, 'preparing')` here matches only `preparingBuild` and `preparingReview`, so the rerun step's progress lines never reach the page (see also `build-page.view-model.ts:1886`). The progress line stays on the literal "Running the checks again" and never names a check. The only R7.2 test is a backend one. R7.2 decides it.

### F4

```yaml
id: F4
severity: medium
repo: kata
concern: spec
file: intent/kata/2026-11-16-build-checks-workbench/build/kata.md
line: 217
```

T13's red is not observed: red record refused, a production commit (b81cca0) came before the test commit. Nothing on record shows that T13's test failed before its code.

### F5

```yaml
id: F5
severity: low
repo: kata
concern: convention
rule: .claude/skills/kata-architecture/SKILL.md:13
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 963
```

Which repository's checks the page lists, and whether they count as running in another session, is a spec rule (R2.4, R2.5). It is computed in the TypeScript view-model (lines 963 to 975) instead of reaching the page as data in `StartChecks`. The architecture rule says every rule a spec states is computed in Rust (see also line 65 of the same skill). It is also where F1's wrong answer lives.

### F6

```yaml
id: F6
severity: low
repo: kata
concern: spec
file: app/src/app/lib/progress-steps.ts
line: 150
```

The plan makes `StepKind::words` (T8) the one owner of the step wording, and T8's Change says the frontend's "Checking the base" wording in `progress-steps.ts` goes. It stayed, and T8's entry does not log that as a departure; the view-model also words "Running the checks again" itself (`build-page.view-model.ts:1886`, T16's logged departure). The shared decision "Which words name each preparation step and the checks on the base" decides it.

### F7

```yaml
id: F7
severity: low
repo: kata
concern: spec
file: app/src-tauri/src/steps.rs
line: 120
```

While a repository's `build.start` runs, the `(PreparingBuild, Some(repo))` branch of the progress line wins, so the strip reads "Preparing <repo>" during the whole check of the base, and the planned `CheckingBase` and `PreparationHook` words never show in that phase. The spec's Design names "Checking the base" as the step's one wording, and R2.2 asks for a preparation step named as itself.

### F8

```yaml
id: F8
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 1835
```

R11.1 row 3 says that while the build of this change is being prepared, the accept action is off and says the build is being prepared. Instead the whole failure panel is hidden while preparing (`if (this.preparing()) return []`), so nothing says why there is no accept. The R11.1 test is backend-only (T9). R11.1 decides it.

### F9

```yaml
id: F9
severity: low
repo: kata
concern: spec
file: app/src/app/ui/running-strip.html
line: 23
```

D10 says the list of active changes is never called "running" as a whole. The group's accessible name is still "Running changes", which a screen reader reads even when the list holds only finished changes. T3 recorded it as a note, not a departure.

### F10

```yaml
id: F10
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 981
```

During a preparation the page calls `transport.steps()` every second (lines 981 to 995). The spec's Design says the build host's check read is the only timed read and the page reads where the change stands only on opening, after actions and on focus (D7, R8.3). T8 and T14 recorded the poll as a note, not a departure.

### F11

```yaml
id: F11
severity: low
repo: kata
concern: convention
rule: docs/adding-a-feature.md:81
file: app/package.json
line: 16
```

The new screen states `?demo=checks-finish` (T16) and `?demo=checks-base-moved` (T15) are missing from the `--route` lists of `check:boot` (line 16) and `check:interaction` (line 19), which the rule requires for a new screen state.
