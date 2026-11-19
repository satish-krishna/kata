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

## Review 2

```yaml
review: 2
reviewed_at: 2026-11-19
commits: { kata: "a132ed8" }
```

### F1

```yaml
id: F1
severity: medium
repo: kata
concern: spec
file: intent/kata/2026-11-16-build-checks-workbench/build/kata.md
line: 217
```

Review 1's F4 still stands: T13's red is not observed. The red record was refused because a production commit (b81cca0) came before the test commit, and no stored red output exists. Nothing on record shows that T13's test failed before its code.

### F2

```yaml
id: F2
severity: medium
repo: kata
concern: convention
rule: CONTRIBUTING.md:122
file: CONTRIBUTING.md
line: 122
```

The subjects of commits 4d8ea24 (`test(kata): test(kata): test that accept is off while the build is being prepared`) and 88a297a (`fix(kata): fix(kata): keep the failure panel…`) carry the Conventional Commits prefix twice. So the summary starts with `fix(kata):` or `test(kata):` instead of an imperative verb, against the commit rules (Conventional Commits are mandatory, CONTRIBUTING.md:97, and the summary is in imperative mood, CONTRIBUTING.md:122). Rewording them rewrites the branch's history from 4d8ea24 on.

### F3

```yaml
id: F3
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/change/change-page.view-model.spec.ts
line: 2316
```

R8.2's last step says the page shows the build under way, started outside this Workbench. After the F1 fix of review 1 (28c9923), `elsewhere` is true only while a check on the base is running. A build started from Claude Code that is under way has finished its checks on the base, so the backend answers `underWay` with `elsewhere: false`, and the page shows no checks list and nothing saying the build was started outside this Workbench (the prototype's "Moved on since" screen shows "started 14:54 outside this Workbench"). Commit a132ed8 kept the R8.2 test passing by changing its data to `underWay` with a running check and `elsewhere: true`, which is not the state R8.2's Given describes, so the scenario's last step is no longer exercised. R8.2 decides it.

### F4

```yaml
id: F4
severity: low
repo: kata
concern: bug
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 971
```

`preparing()` is true for every step `isStep(…, 'preparing')` matches, which includes a review's preparation and, since review 1's F3 fix (5693203), `rerunningFinishChecks`. Whenever `preparing()` is true, `baseChecks` lists `from.checks` when no live check is read. For a finished or finish-failure repository, `from.checks` is the last run on the base. So during "Run checks again" at finish, or while the review is prepared, the page shows "Checks on the base", "n of n done", without a base commit: a stale list that has nothing to do with the step that runs. The mock's finish fixture has `checks: []`, so no test sees it. The code comes from T14 and T16, and the F3 fix makes it easier to reach.

### F5

```yaml
id: F5
severity: low
repo: kata
concern: convention
rule: .claude/skills/kata-architecture/SKILL.md:13
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 976
```

Review 1's F5, in part: the backend now decides whether checks run in another session (`StartChecks.elsewhere`), but which repository's checks the page lists (the first with `elsewhere` or a cut-off check) is still decided in the TypeScript view-model. That is a spec rule (R2.4, R2.5), and the architecture rule says every rule a spec states is computed in Rust.

### F6

```yaml
id: F6
severity: low
repo: kata
concern: convention
rule: .claude/skills/kata-architecture/SKILL.md:13
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 1841
```

Review 1's F8 fix (88a297a) computes in TypeScript whether accepting is off, through `acceptOff` matching the step kinds `preparingBuild`, `checkingBase` and `preparationHook`, and restates the backend's refusal as `BUILD_BEING_PREPARED` (line 216). The same decision is already made in `accept_base_check_in` (`app/src-tauri/src/lib.rs:2149-2167`). What blocks an action is a rule that belongs in Rust, and a preview and its action use the same Rust call (`.claude/skills/kata-architecture/SKILL.md:28`). The fix logged this as a departure; it still breaks the rule.

### F7

```yaml
id: F7
severity: low
repo: kata
concern: convention
rule: app/CLAUDE.md:72
file: app/src/app/ui/build-failure-panel.html
line: 41
```

The disabled Accept button points `aria-describedby` at `'accept-off-' + $index`, and the span on line 42 takes that same id. The build page renders one failure panel per repository (`build-page.html:5`), so when two repositories show base failures during a preparation, both panels hold an element with the id `accept-off-0`. That duplicate id, referenced by ARIA, fails axe's `duplicate-id-aria` rule, and app/CLAUDE.md:72 requires every AXE check to pass.

### F8

```yaml
id: F8
severity: low
repo: kata
concern: spec
file: app/src/app/lib/progress-steps.ts
line: 150
```

Review 1's F6 still stands: the plan makes `StepKind::words` (T8) the one owner of the step wording, and T8's Change says the frontend's "Checking the base" wording in `progress-steps.ts` goes, but it stayed. The rerun at finish's starting label is also TypeScript wording, now `PROGRESS_NAMES['running-checks']` (`build-page.view-model.ts:1901`). The shared decision "Which words name each preparation step and the checks on the base" decides it.

### F9

```yaml
id: F9
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 992
```

Review 1's F10 still stands: during a preparation the page calls `transport.steps()` every second (the `followLiveChecks` effect, lines 981 to 998). The spec's Design says the build host's check read is the only timed read, and the page reads where the change stands only on opening, after actions and on focus (D7, R8.3).

### F10

```yaml
id: F10
severity: low
repo: kata
concern: convention
rule: docs/adding-a-feature.md:81
file: app/package.json
line: 16
```

Review 1's F11 still stands: the new screen states `?demo=checks-finish` (T16) and `?demo=checks-base-moved` (T15) are missing from the `--route` lists of `check:boot` (line 16) and `check:interaction` (line 19), which the rule requires for a new screen state.

## Review 3

```yaml
review: 3
reviewed_at: 2026-11-19
commits: { kata: "ac2e515" }
```

### F1

```yaml
id: F1
severity: medium
repo: kata
concern: spec
file: intent/kata/2026-11-16-build-checks-workbench/build/kata.md
line: 217
```

Still stands from review 1 (F4) and review 2 (F1): T13's red is not observed. The red record was refused because a production commit (b81cca0) came before the test commit, and no stored red output exists, so nothing on record shows that T13's test failed before its code.

### F2

```yaml
id: F2
severity: medium
repo: kata
concern: convention
rule: CONTRIBUTING.md:122
file: CONTRIBUTING.md
line: 122
```

Still stands from review 2 (F2): the subjects of 4d8ea24 and 88a297a carry the Conventional Commits prefix twice (`test(kata): test(kata): …`, `fix(kata): fix(kata): …`), so the summary does not start with an imperative verb. Rewording them rewrites the branch's history from 4d8ea24 on.

### F3

```yaml
id: F3
severity: low
repo: kata
concern: bug
file: crates/kata-sdlc/src/checks_view.rs
line: 639
```

`outside` is set whenever the build is under way and `!live.known_here()`. `known_here` rests on `ran_here`, which the build host keeps in memory only (`app/src-tauri/src/build_host.rs:540`). After the Workbench restarts, a build this Workbench started and left under way therefore reads "Started outside this Workbench" (`STARTED_OUTSIDE`, line 394). The spec's risk 3 accepts this inference for R9 only with "may" wording; this text states it as a fact.

### F4

```yaml
id: F4
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 978
```

While this Workbench prepares the build, `baseChecks` passes `base: ''`, so the "Checks on the base" heading no longer shows the base commit the spec's Design asks for (`spec.md:429`). The R8.2 words render in the build page bar (`build-page.html:30`) as "<repo> Started outside this Workbench HH:mm", where the prototype's "Moved on since" screen (`spec.md:409`) puts "started 14:54 outside this Workbench" on the Build strip's progress line. Both were reported to the engineer as departures of the fix in 2c60b7f, but no change document records them. The spec's Design and the prototype decide it.

### F5

```yaml
id: F5
severity: low
repo: kata
concern: convention
rule: .claude/skills/kata-architecture/SKILL.md:13
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 1851
```

Still stands from review 2 (F6): `acceptOff` decides in TypeScript that accepting is off by matching the step kinds `preparingBuild`, `checkingBase` and `preparationHook` (lines 1851 to 1855), and restates the backend's refusal as `BUILD_BEING_PREPARED` (line 216). The same decision is made in `accept_base_check_in` (`app/src-tauri/src/lib.rs`). What blocks an action is a rule that belongs in Rust, and a preview and its action use the same Rust call.

### F6

```yaml
id: F6
severity: low
repo: kata
concern: spec
file: app/src/app/lib/progress-steps.ts
line: 150
```

Still stands from review 2 (F8): the plan makes `StepKind::words` (T8) the one owner of the step wording, and T8's Change says the frontend's "Checking the base" wording in `progress-steps.ts` goes, but it stayed. The rerun at finish's starting label is also TypeScript wording, `PROGRESS_NAMES['running-checks']` (`build-page.view-model.ts:1911`). The shared decision "Which words name each preparation step and the checks on the base" decides it.

### F7

```yaml
id: F7
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 1000
```

Still stands from review 2 (F9): during a preparation the page calls `transport.steps()` every second (the `followLiveChecks` effect, lines 988 to 1006). The spec's Design says the build host's check read is the only timed read, and the page reads where the change stands only on opening, after actions and on focus (D7, R8.3).

### F8

```yaml
id: F8
severity: low
repo: kata
concern: convention
rule: docs/adding-a-feature.md:81
file: app/package.json
line: 16
```

Still stands from review 2 (F10): the new screen states `?demo=checks-finish` (T16) and `?demo=checks-base-moved` (T15) are missing from the `--route` lists of `check:boot` (line 16) and `check:interaction` (line 19), which the rule requires for a new screen state.

### F9

```yaml
id: F9
severity: low
repo: kata
concern: convention
rule: CONTRIBUTING.md:122
file: CONTRIBUTING.md
line: 122
```

The rule caps a commit summary at about 72 characters. The fix commits 2c60b7f (127 characters) and 9ae4410 (117) go well past it, as do earlier commits in the range: 88a297a (113), 73c3bcd (122), bd35b18 (115), 220cd9c (110), 0228f5b (110) and 9845e62 (105).

## Review 4

```yaml
review: 4
reviewed_at: 2026-11-19
commits: { kata: "9c1039f" }
```

### F1

```yaml
id: F1
severity: medium
repo: kata
concern: spec
file: intent/kata/2026-11-16-build-checks-workbench/build/kata.md
line: 217
```

Still stands from review 1 (F4), review 2 (F1) and review 3 (F1): T13's red is not observed. The red record was refused because a production commit (b81cca0) came before the test commit, and no stored red output exists, so nothing on record shows that T13's test failed before its code.

### F2

```yaml
id: F2
severity: medium
repo: kata
concern: convention
rule: CONTRIBUTING.md:122
file: CONTRIBUTING.md
line: 122
```

Still stands from review 2 (F2) and review 3 (F2): the subjects of 4d8ea24 and 88a297a carry the Conventional Commits prefix twice (`test(kata): test(kata): …`, `fix(kata): fix(kata): …`), so the summary does not start with an imperative verb. Rewording them rewrites the branch's history from 4d8ea24 on.

### F3

```yaml
id: F3
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 978
```

Still stands from review 3 (F4): while this Workbench prepares the build, `baseChecks` passes `base: ''`, so the "Checks on the base" heading no longer shows the base commit the spec's Design asks for (`spec.md:429`). The R8.2 words render in the build page bar (`build-page.html:30`) as "<repo> May have been started outside this Workbench HH:mm" (the words review 3 F3 changed), where the prototype's "Moved on since" screen (`spec.md:409`) puts "started 14:54 outside this Workbench" on the Build strip's progress line. Both were reported to the engineer as departures of the fix in 2c60b7f, but no change document records them. The spec's Design and the prototype decide it.

### F4

```yaml
id: F4
severity: low
repo: kata
concern: convention
rule: .claude/skills/kata-architecture/SKILL.md:13
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 1851
```

Still stands from review 2 (F6) and review 3 (F5): `acceptOff` decides in TypeScript that accepting is off by matching the step kinds `preparingBuild`, `checkingBase` and `preparationHook` (lines 1851 to 1855), and restates the backend's refusal as `BUILD_BEING_PREPARED` (line 216). The same decision is made in `accept_base_check_in` (`app/src-tauri/src/lib.rs`). What blocks an action is a rule that belongs in Rust, and a preview and its action use the same Rust call.

### F5

```yaml
id: F5
severity: low
repo: kata
concern: spec
file: app/src/app/lib/progress-steps.ts
line: 150
```

Still stands from review 2 (F8) and review 3 (F6): the plan makes `StepKind::words` (T8) the one owner of the step wording, and T8's Change says the frontend's "Checking the base" wording in `progress-steps.ts` goes, but it stayed. The rerun at finish's starting label is also TypeScript wording, `PROGRESS_NAMES['running-checks']` (`build-page.view-model.ts:1911`). The shared decision "Which words name each preparation step and the checks on the base" decides it.

### F6

```yaml
id: F6
severity: low
repo: kata
concern: spec
file: app/src/app/sdlc/build/build-page.view-model.ts
line: 1000
```

Still stands from review 2 (F9) and review 3 (F7): during a preparation the page calls `transport.steps()` every second (the `followLiveChecks` effect, lines 988 to 1006). The spec's Design says the build host's check read is the only timed read, and the page reads where the change stands only on opening, after actions and on focus (D7, R8.3).

### F7

```yaml
id: F7
severity: low
repo: kata
concern: convention
rule: docs/adding-a-feature.md:81
file: app/package.json
line: 16
```

Still stands from review 2 (F10) and review 3 (F8): the new screen states `?demo=checks-finish` (T16) and `?demo=checks-base-moved` (T15) are missing from the `--route` lists of `check:boot` (line 16) and `check:interaction` (line 19), which the rule requires for a new screen state.

### F8

```yaml
id: F8
severity: low
repo: kata
concern: convention
rule: CONTRIBUTING.md:122
file: CONTRIBUTING.md
line: 122
```

Still stands from review 3 (F9): the rule caps a commit summary at about 72 characters. The fix commits 2c60b7f (127 characters) and 9ae4410 (117) go well past it, as do earlier commits in the range: 88a297a (113), 73c3bcd (122), bd35b18 (115), 220cd9c (110), 0228f5b (110) and 9845e62 (105). The two commits since review 3 (4553f67, 9c1039f) are within it.
