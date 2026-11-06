# Layout 2 grammar

This file states the part of layout 2 that JSON Schema cannot: the tags of a spec. Every other layout 2 shape is a schema in `schema/`.

A document's layout version is the `layout` field of its front matter, as an integer. A document without the field is layout 1. The program reads layouts 1 and 2 and refuses a newer one.

## Spec tags

A layout 2 spec holds its requirements in one fenced `gherkin` block. IDs and sources are Gherkin tags, and titles are free text.

```gherkin
  @R7 @from:outcome-4 @from:D2
  Rule: The engineer sees, per repository, exactly what the change did

    @R7.1
    Scenario: What changed after a build
```

- A `Rule` carries exactly one `@R<n>` tag, where `<n>` is a whole number, and at least one `@from:<source>` tag. A source is any text without spaces.
- A `Scenario` or `Scenario Outline` carries exactly one `@R<n>.<m>` tag, and `<n>` is the ID number of the rule it sits under.
- An ID is used once in a spec.
- A rule holds at least one scenario.
- Every `<parameter>` of an outline appears in its `Examples` table.
- The requirements block is the first fenced block, with backticks or tildes, whose info string is `gherkin` in any case. A layout 2 spec with no such block is a problem, and so is a tagged scenario that sits under no `Rule`.
- Scan every raw line of the spec, ignoring markdown, for `@R<n>` and `@R<n>.<m>`. A tag whose ID the reader did not read from the requirements block is a problem (`requirement R3 is not part of the requirements the reader found`), so a second block of new requirements, or rules after a Gherkin doc string closed with a bare fence, cannot be dropped silently. A tag that names an ID the reader did read is fine anywhere, so a document may quote an existing requirement.

## Other documents

| Document | Shape | Definition |
|---|---|---|
| Front matter of every document | `---` fenced YAML at the top | `schema/front-matter.schema.json` |
| Plan task | heading `### T<n>: <name>`, then a fenced `yaml` block | `schema/plan-task.schema.json` |
| Plan shared decisions | a fenced `yaml` list under `## Shared decisions` | `schema/shared-decision.schema.json` |
| Build log entry | heading `### T<n>`, then a fenced `yaml` block | `schema/build-log-entry.schema.json` |
| Review header | heading `## Review <n>`, then a fenced `yaml` block | `schema/review-header.schema.json` |
| Review finding | heading `### F<n>`, then a fenced `yaml` block, then prose | `schema/finding.schema.json` |

A finding may name its `repo`, its `concern` (`spec`, `bug` or `convention`) and, for a convention finding, the `rule` it breaks. All three are optional so that findings written before they existed still read, but a finding whose `concern` is `convention` and that has no `rule` is a problem: a convention finding stands on a written rule of its repository, and one without it is not read. A `repo` must be one of the repositories in its review's `commits`.

A heading outside a fenced block is record-shaped when it is at any level from `#` to `######` (`Review` from `##`, since `# Review findings` is the document title) and its text starts with `T<digits>`, `F<digits>` or `Review` at a word boundary, so `T2`, `T12` and `F12` count and `T2a` does not. A record-shaped heading that does not match the shape above is a problem: `### T2 - second` and `#### Review history` are reported, while `### Testing strategy` is an ordinary heading. Independently of any heading, a `yaml` block that no record claims and that parses to a mapping holding the record key (`id` for a task or finding, `task` for an entry, `review` for a review header) is a problem wherever it sits, so a heading the rule does not anticipate, such as `### T2a` or `### Task T2`, cannot hide its record; a `yaml` example without that key is ordinary content.

Fenced blocks follow CommonMark: a fence closes only on a bare fence of the same character that is at least as long as the opener, so a four-backtick block can quote a three-backtick `yaml` block and a record, and none of it counts. A fields block is any fenced block whose info string is `yaml` or `yml` in any case; one that no record claims is reported when it holds the record key, even if it does not parse (a raw line starting with `id:`, `task:` or `review:` is enough). A fenced block that runs to the end of the document without a closing fence is a problem naming its opening line, because everything after it would be read as code.

Line endings are normalized before anything is read: CRLF and a lone CR both count as one line end, so reported line numbers match what an editor shows for the original file.

One rule does not depend on how markdown is read. Scan the raw text line by line, ignoring fences, HTML, quotes and every other construct: a line that looks like a record's key, with optional leading whitespace, must be the key line of a record the program read. The keys are `id: T<digits>` in a plan, `task: T<digits>` in a build log, and `id: F<digits>` or `review: <digits>` in a review. Any other such line is a problem (`<key line> is not part of any record the reader found`), wherever it sits, so no markdown construct, an unclosed HTML comment included, can hide a record. A record key line may therefore appear only in the record itself. An example that quotes a record must change the key: `id: T0` is still reported, so write `id: <task id>`.

## What the program prints

`node ai-sdlc.ts read --json <file>` prints one `ReadResult`, defined by `schema/read-result.schema.json`. `node ai-sdlc.ts check <file>...` prints one problem per line as `<file>:<line>: <message>`, sorted by file and then line. Exit code 0 means the documents pass, 1 means there are problems, and 2 means the program could not run (an unreadable file, an unknown kind of document, or a layout newer than the program reads).

The document kind comes from the file name: `spec.md`, `plan.md`, `build/<repo>.md` or `build/review.md`.

Documents of one change given together are checked against each other: a layout 2 plan's tasks against the spec (every scenario covered by a task, every `covers` and `supports` ID in the spec) and against themselves (`depends_on`, `uses`, task IDs), and each build log's entries against the plan's tasks. A plan whose front matter `status` is `superseded` is not checked against the spec, so a reopened spec with scenarios the old plan does not cover can still be accepted; its own references and the build logs against it are still checked.

## Where a fix stands

`node ai-sdlc.ts fix-state --json <change folder>...` prints where a fix stands: the row of the fix-state table below, and the facts it was decided on. It is the only place the row is computed; anything that acts on a fix reads the row from here rather than working it out again. It runs git in the repository that holds each folder (`git rev-parse --show-toplevel`), with every path relative to that repository's top level.

### The fix-state table

Rows in order, first match wins. The words are the fields in the table under "The facts" below.

| Row | Where the fix stands | Condition |
|---|---|---|
| 1 | Closed | The intent's `HEAD` status is `rejected`. |
| 2 | Statuses not settled | A document in `HEAD` has a `HEAD` status other than `draft` or `accepted` (including none, or front matter that cannot be read); or `accepted` is `other`; or some document is accepted in `HEAD` while another is not in `HEAD`. |
| 3 | Changes not recorded | `unrecorded` is not empty. |
| 4 | An acceptance stopped before its commit | `ownLinesOnly`. |
| 5 | An acceptance stopped between documents | `accepted` is `leading` and `acceptanceLast`. |
| 6 | Awaiting acceptance, never accepted or built | `accepted` is `none` and not `built`. |
| 7 | Awaiting acceptance again | `accepted` is not `all`: none accepted with something built, or a leading run with something other than an acceptance commit last. |
| 8 | Accepted | All three accepted in `HEAD` and nothing uncommitted; the build then goes on as for any change. |

Rows 1 and 2 are decided before the plan and the build logs are read, so a plan or build log that cannot be read never hides a closed or unsettled fix; on those rows `built` is `false` without being read. On the later rows, a plan or build log the reader cannot read (front matter that does not parse, a layout newer than this program reads) counts as not built.

### Output

Given one folder, it prints one JSON object on one line:

```json
{"row":4,"facts":{"intent":{"inHead":true,"headStatus":"draft","workingStatus":"accepted"},"spec":{"inHead":true,"headStatus":"draft","workingStatus":"draft"},"plan":{"inHead":true,"headStatus":"draft","workingStatus":"draft"},"unrecorded":[],"ownLinesOnly":true,"accepted":"none","acceptanceLast":false,"built":false}}
```

Given several folders, it prints one JSON array on one line, one entry per folder in the order given, each with the folder exactly as it was given and either its `result` (the object above) or the `error` that stopped it, so a scan of many fixes costs one process (the facts shortened here):

```json
[{"folder":"intent/demo/2026-10-01-fix-typo","result":{"row":6,"facts":{}}},{"folder":"intent/demo/2026-10-02-not-a-fix","error":"…: not a fix (its track is \"full\", expected fix)"}]
```

### The facts

| Field | Meaning |
|---|---|
| `row` | 1 to 8, the row of the fix-state table. |
| `intent`, `spec`, `plan` | Per document: `inHead`, whether its file is in `HEAD` (`git ls-tree`); `headStatus`, the `status` of the `HEAD` copy (`git show HEAD:<path>`), null when `HEAD` does not hold it or its front matter names none; `workingStatus`, the `status` of the working copy, null when there is none. |
| `unrecorded` | The documents with unrecorded changes, in document order (`intent`, `spec`, `plan`): a document not in `HEAD`, whether or not it has a working copy, and a document `git status --porcelain=v1` reports that is not own lines. |
| `ownLinesOnly` | Some document differs from `HEAD` (see below) and every one that does is own lines. Own lines: only the first document not accepted in `HEAD` may carry them; its working `status` reads `accepted`, and in `git diff HEAD --no-color --unified=0 -- <path>` every removed and added line is a `status`, `source_intent_commit`, `source_spec_commit` or `accepted_in_advance` line of the front matter, the added `status` line reads `accepted`, and no "No newline at end of file" marker appears. The lines come from git's own diff, run with external diff tools and text conversion turned off, after its own line-ending conversion. The front matter is found the way the reader finds it, and an added line must end as the `HEAD` line it replaces does, so a line ending git would record (a CRLF conversion under `core.autocrlf=false`, say) or a changed final newline is not own lines. |
| `accepted` | Which documents are accepted in `HEAD`: `none`; `leading` (the intent, or the intent and the spec); `all`; or `other`, any other set, which row 2 catches. |
| `acceptanceLast` | The subject of the latest commit touching any of the three documents (`git log -1 --format=%s -- <the three>`) ends in `accept intent <change>`, `accept spec <change>` or `accept plan <change>`, where `<change>` is the folder's name. |
| `built` | Some task of the plan in `HEAD` has an entry in a build log in `HEAD` (`build/<repo>.md`; `build/review.md` is never a build log). Uncommitted build logs do not count. `false` on rows 1 and 2, and when the plan or the build log cannot be read. |

A document counts as unrecorded when `git status` reports it and `git diff --quiet HEAD` confirms a difference git would record, so a line-ending conversion git applies on checkout or rewrite (`core.autocrlf`) is never one, while a changed final newline, or a line ending git would record, is. A document in `HEAD` that is missing from the working tree is a difference. Every `git diff` runs with external diff tools and text conversion turned off, so the user's diff settings never change what is read. On rows 1 and 2, which are decided before any diff is run, `unrecorded` lists the documents not in `HEAD` and every document `git status` reports, and `ownLinesOnly` is `false`.

The intent's `track` is read from the working `intent.md`, or from its `HEAD` copy when the working copy is missing, names no `track`, or has front matter that cannot be read, so a deleted or edited working intent reads as row 3.

Exit code 0 means the output was printed. Given one folder, exit 2 means the program could not read it: the folder does not exist, holds no `intent.md` in the working tree or in `HEAD`, the intent's `track` is not `fix`, or git failed (the folder is not in a git repository, say). Given several folders, exit 0 means the array was printed: every folder that could not be read, whatever the reason, is its own `{ folder, error }` entry and never fails the others. Exit 2 means the arguments themselves are wrong (no folder, or no `--json`).

## Where a change stands

`node ai-sdlc.ts state --json [--system <s>] [--change <c> | --open] [--master <path>] [--workspace <path>]` prints where every change of a system stands, and per skill whether that skill may work on it. It is the only place a skill's gate is computed: no skill reads a document's `status`, scans change folders, runs `git status`, `git show HEAD:` or `git diff` on a document, or checks a source pin by hand. It only reads: git runs with `--no-optional-locks`, takes no lock and runs no hook, and nothing is written. `changes/state.ts` holds the rules.

`--open` prints only the changes whose `finished` is null, each exactly as without it, and reads only those, so `problems` then covers only the changes reported; with `--change` it exits 2.

The workspace and the master are resolved as `resolve` does, with the same options. The system is `--system` when given (one the marker does not list: exit 2); else, with `--change`, the system that holds the change; else the marker's only system; else exit 2, asking for `--system`.

The changes are every folder `intent/<system>/<change>/` holding `intent.md`, in the working tree or in `HEAD`, of the resolved master and of every change copy in `<workspace>/.ai-sdlc/copies/*/` that is a worktree of the same repository (shares its git common directory). A change is reported from the repository that holds it, in this order, first match wins: the change's own copy (`copies/<change>/`), then the resolved master, then any other copy. `findChange`, which `run`, `change` and `status` use, decides by the same order (the copy, then the master), so they never disagree. With `--change`, only that change is reported; one that no repository holds exits 2.

### Output

One JSON object on one line: `{ "system": "demo", "changes": [ ... ], "problems": [] }`. `changes` is sorted by change name. `problems` lists, as `<change>: <reason>`, each fix-track change whose `fix-state` result could not be read (its `fix` is null then). Each change:

```json
{"change":"2026-11-01-greeting","master":"/ws/.ai-sdlc/copies/2026-11-01-greeting","folder":"/ws/.ai-sdlc/copies/2026-11-01-greeting/intent/demo/2026-11-01-greeting","inCopy":true,"title":"Greeting","track":"full",
 "documents":{"intent":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false},"spec":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false,"pin":"holds"},"plan":{"exists":true,"inHead":true,"headStatus":"accepted","workingStatus":"accepted","uncommitted":false,"pin":"holds"}},
 "scenarios":2,"tasks":{"app":{"all":["T1","T2"],"logged":["T1"],"unlogged":["T2"],"commits":{"T1":["4f1c2a9e0b7d3c5a8e6f1b2d4c7a9e0f3b5d8c1a"],"T2":[]},"untasked":[],"uncommitted":["src/greet.ts"]}},"buildLogs":{"app":"clean"},"review":{"committed":0,"draft":"none"},"fix":null,
 "ready":{"spec":{"candidate":false,"stop":null,"accept":["intent.md"]},"plan":{"candidate":false,"stop":null,"accept":["intent.md","spec.md"]},"build":{"candidate":true,"stop":null,"accept":["intent.md","spec.md","plan.md"]},"review":{"candidate":false,"stop":"These tasks have no build log entry yet: `app`: T2.","accept":["intent.md","spec.md","plan.md"]},"done":{"candidate":false,"stop":null,"accept":[]}},
 "finished":null}
```

| Field | Meaning |
|---|---|
| `change`, `folder` | The change's name, and the absolute path of its folder in the repository that holds it. |
| `master` | The absolute path of the master or copy that holds the change; its documents are read there. |
| `inCopy` | That repository is a change copy: any copy, or the resolved master when it is one (`resolve`'s `masterIsCopy`). |
| `title` | The intent's front matter `title` (working copy, else `HEAD`), null when it has none. |
| `track` | `fix` when the intent's `track` is `fix`, read as `fix-state` reads it (the working intent, else its `HEAD` copy); otherwise `full`. |
| `documents.<doc>` | For `intent`, `spec` and `plan`: `exists`, the file is in the working tree; `inHead`, it is in `HEAD`; `headStatus` and `workingStatus`, the front matter `status` of each copy, null when there is no such copy, it names none or its front matter cannot be read (as `fix-state` reads them); `uncommitted`, `git status` reports the file and either it is not in `HEAD` (untracked or only staged) or `git diff --quiet HEAD` confirms a difference git would record (`fix-state`'s definition: a line-ending conversion git applies is none, a deleted file is one). |
| `documents.spec.pin`, `documents.plan.pin` | The source pin of the working copy (`source_intent_commit` against `intent.md`, `source_spec_commit` against `spec.md`): null when the document does not exist; `missing` when the field is absent, empty, `pending acceptance`, or not a commit of this repository; `broken` when the upstream document's content at the pin differs from its content in `HEAD` (its file mode is not compared); else `holds`. |
| `scenarios` | The number of scenarios the spec reader finds in the working `spec.md`, over every requirement; null when there is no spec or it does not read cleanly (any problem). |
| `tasks` | Per repository the plan names, in the order it first names them: `all` the plan's task IDs, `logged` those with an entry in any build log in `HEAD` (`build/<repo>.md`; `build/review.md` never counts), `unlogged` the rest. Read from the plan and the build logs as committed in `HEAD`, so an uncommitted entry does not count. Null when the plan in `HEAD` does not read cleanly or `HEAD` has no plan. Each repository's work is read in `<workspace>/<repo>`, except the master listed as one of the system's repositories, which is read in the repository that holds the change (its copy, when it has one): `commits.<task>`, for every task in `all`, the commits from the merge base of `HEAD` with the repository's base branch (the remote's default, else `main`, else `master`; the local branch, else the remote's copy) to `HEAD`, oldest first, whose message has the trailer `Plan-Task: <task>` (the trailer `commit --kind work --task` writes); `untasked`, the commits in that range with no `Plan-Task` trailer (work on the engineer's instructions, such as after a review), oldest first; both null when the repository is not checked out, has no base branch or no `HEAD`, or shares no history with its base. `uncommitted`, the repository's uncommitted and untracked files as `git status --porcelain` names them (an untracked folder as `<folder>/`), leaving out ai-sdlc's own files (`intent`, `.ai-sdlc.json`) when the repository holds the marker, exactly as `build.start` counts them; null when the repository is not checked out. |
| `buildLogs` | Every `build/<repo>.md` in the working tree or in `HEAD`, by repository: `clean`, no uncommitted difference; `added-entries`, a new file, or one whose only differences are added lines (`git diff HEAD --unified=0` shows no removed line); `other`, anything else (a removed or changed line, a deleted file). |
| `review` | `committed`, the number of `## Review <n>` sections the review reader finds in `build/review.md` in `HEAD` (0 when it is not there). `draft`: `none` when the working file has no uncommitted difference; `next-section` when it reads cleanly and is the `HEAD` copy with exactly one `## Review <committed+1>` section appended after it (only blank lines between them), or, with no `HEAD` copy, holds exactly `## Review 1`; else `other`. |
| `fix` | For `track: fix`, the `fix-state` result for the folder, the same object `fix-state --json` prints; else null. |
| `finished` | Null when the change is open, `rejected` or `merged`; the rule is defined in "Listing a system's changes", which `list` shares. `changes/finished.ts` holds it. |
| `ready.<skill>` | For `spec`, `plan`, `build`, `review`, `done` and `reject`: `stop`, null when the skill's gate passes for this change, otherwise the first stop message below that applies; `candidate`, the gate passes and the change is waiting for that skill (what a search without a named change picks); `accept`, the documents that skill gates whose acceptance gate passed (`headStatus` and `workingStatus` both `accepted`, not `uncommitted`), in the order `intent.md`, `spec.md`, `plan.md`, for the skill to record with the `doc.accept` event. |

### The `ready` rules

A document is accepted when its `workingStatus` is `accepted`. `<status>` is its `workingStatus`, or `missing` when there is none (no file, or no `status`). An uncommitted acceptance is a gated document that is accepted and `uncommitted`; the stop names the first such, in document order: "`` `<file>` has uncommitted changes. Commit the acceptance first, so history shows what was accepted. ``". The light-track stop is "`` `<change>` is on the light track; `fix --accept <change>` finishes or revises its documents. ``".

- **spec** gates `intent.md`. Stops, in order: the light track; the intent not accepted: "This intent is `<status>`. The product owner accepts it by changing its status to `accepted` and committing; the spec runs only after that."; an uncommitted acceptance. Candidate: no spec, or a spec not accepted, or a spec pin `broken` or `missing`.
- **plan** gates `intent.md` and `spec.md`. Stops, in order: the light track; the spec not accepted (or missing): "This spec is `<status>`. The product owner accepts it by changing its status to `accepted` and committing."; the intent not accepted: "The intent was reopened (`<status>`). The spec must be regenerated and accepted again before planning."; an uncommitted acceptance; the spec pin `missing`: "This spec does not record the intent it was written from. Rerun the spec skill; the product owner accepts it again before planning."; the spec pin `broken`: "This spec was written from an earlier version of the intent. Rerun the spec skill; the product owner accepts it again before planning."; `scenarios` 0 or null: "This spec has no Gherkin scenarios. Rerun the spec skill to regenerate it; the product owner accepts it again before planning." Candidate: no plan, or a plan whose `workingStatus` is `superseded`.
- **build** gates all three, on either track. Stops, in order: the plan not accepted: "This plan is `<status>`. The engineer accepts it by changing its status to `accepted` and committing."; the intent, then the spec, not accepted: "`` `<file>` was reopened (`<status>`). Rerun the skills after it, then accept the plan again. ``"; an uncommitted acceptance; the spec pin not `holds`: "The intent changed after this spec was written. Rerun the spec skill, then the plan skill."; the plan pin not `holds`: "This plan was not written from the spec that is accepted now. Rerun the plan skill."; `tasks` null: "This plan cannot be read. Rerun the plan skill." Candidate: some task is unlogged.
- **review** stops on build's stops, then: some task unlogged: "These tasks have no build log entry yet: `` `<repo>`: T1, T2; `<repo2>`: T3 ``." (repositories in plan order; the skill adds the build command for each); then a build log that is not `clean`, the first by repository name: "The build log for `<repo>` has uncommitted changes; rerun the build for `<repo>` to commit them." Candidate: the gate passes. `review.draft` is reported, never a stop.
- **done** never stops (the `change.done` event refuses what is not ready) and accepts nothing. Candidate: `review.committed` is above 0 and every task is logged.
- **reject** (the intent and fix skills' `--reject` mode) accepts nothing and is never a candidate: a change is rejected only by name. Stops, in order: the intent's `headStatus` is `rejected`: "`` `<change>` is closed: its intent was rejected. ``"; build work, meaning any entry in `buildLogs`, `review.committed` above 0, or a `review.draft` other than `none`: "`` `<change>` has build work (a build log or a review), so it is not rejected. The engineer settles that work first. ``"; a document that is `uncommitted`, the first in document order: "`` `<file>` has uncommitted changes. Commit or discard them first, so the rejection does not carry them unread. ``"

Exit code 0 means the output was printed. Exit 2 means it could not run: no master, an unknown system, several systems and no `--system`, a `--change` no repository holds, wrong arguments, or git failing. It never exits 1.

## Listing a system's changes

`node ai-sdlc.ts list --json [--system <s>] [--master <path>] [--workspace <path>]` prints each change of a system with the few facts a list row needs, reading only the intents. It resolves the workspace, the master and the system, and finds the changes and the repository that holds each, exactly as `state` does (same options, same exit 2 cases, same holder order), and it only reads. `changes/list.ts` holds the code; it shares change discovery (`changes/place.ts`) and the finished rule (`changes/finished.ts`) with `state`, so the two never disagree.

One JSON object on one line, `changes` sorted by change name: `{ "system", "changes", "problems" }`. `problems` is always `[]` today; it is kept for the shape every command shares.

```json
{"system":"kata","changes":[{"change":"2026-11-03-end-finished-runs","title":"End finished runs","track":"full","master":"/ws/.ai-sdlc/copies/2026-11-03-end-finished-runs","inCopy":true,"finished":null}],"problems":[]}
```

| Field | Meaning |
|---|---|
| `change`, `title`, `track`, `master`, `inCopy` | As `state` defines them (see "Where a change stands"), computed by the same functions. There is no `folder`: it is `master` plus `intent/<system>/<change>`. |
| `finished` | Null (open), `rejected` or `merged`, by the rule below. |

Git processes: a fixed number per repository, plus what finding the copies costs; none per change. `list` never runs `git status`, and reads no spec, plan, build log or product repository.

### Finished

A change is finished when either:

1. its intent is rejected: the `status` of its `intent.md` in `HEAD` of the repository that holds it is `rejected` (`finished` is `rejected`); or
2. it has no change copy and `intent/<system>/<change>/intent.md` is in the tree of the master's base branch, either the local branch or the remote's copy of it (`finished` is `merged`). "No change copy" means no folder `<workspace>/.ai-sdlc/copies/<change>/` that is a change copy as `state` defines them above: a worktree of the master's repository, at its top level.

Otherwise it is open (`finished` is null). Rejected is checked first. The base branch is found as `baseBranch` finds it: the remote's default, else `main`, else `master`; with none, nothing is `merged`. A change merged on the base branch whose copy is kept is open (its copy still has to be removed). A change started before copies existed never had one, so it is finished once its documents are on the base branch. A change on a feature branch of the engineer's checkout is not on the base branch: open. `changes/finished.ts` holds the rule.

Known gap: changes are found as before, in the working tree and `HEAD` of the master and of each copy. After a change's copy is removed, until the checkout holds the merge (pulled, or on a branch that contains it), no repository holds the change and it is not listed at all. It is listed as `merged` once the checkout is pulled.

## Staleness of context

`node ai-sdlc.ts stale --json --system <s> [--repo <repo>]... [--master <path>] [--workspace <path>]` prints whether each repository's context file is behind its repository: the rule of `references/workspace.md`, section 7, which skills call this command for rather than run git themselves. It only reads. `workspace/stale.ts` holds the rules.

The workspace and the master are resolved as `resolve` does, with the same options; the context files are read from the resolved master's working tree (a change's copy, when the session is in one). The repositories are the system's (the marker's list, or every repository in the workspace except the master when it lists none), in the marker's order; `--repo`, which may be given more than once, narrows them, still in that order.

One JSON object on one line:

```json
{"system":"demo","repos":[{"repo":"app","path":"/ws/app","checkedOut":true,"context":"/ws/master/intent/demo/context/app.md","exists":true,"sourceCommit":"9c1e4b7a2d5f8e0b3c6a9d2f5e8b1c4a7d0e3f6b","behind":1,"stale":true,"reason":"behind"}],"problems":[]}
```

| Field | Meaning |
|---|---|
| `repo`, `path` | The repository's name and `<workspace>/<repo>`. |
| `checkedOut` | `<path>/.git` exists. |
| `context`, `exists` | `<master>/intent/<system>/context/<repo>.md`, and whether it is in the master's working tree. |
| `sourceCommit` | Its front matter `source_commit`, trimmed; null when the file is missing, has none (or an empty one), or its front matter cannot be read. |
| `behind` | `git -C <path> rev-list --count <sourceCommit>..HEAD -- . ":(exclude)intent" ":(exclude).ai-sdlc.json"`: commits after the context's commit that touch product files, so ai-sdlc's own commits in the master listed as a product repository never count. Null when it cannot be counted. |
| `stale`, `reason` | The first that applies: `missing`, no context file (not stale: the context skill builds it); `not-checked-out` (not stale, `behind` null); `no-source-commit` (stale); `unknown-commit`, the commit is not in the repository, as after rewritten history, or a value that is not a commit (stale); `behind`, `behind` above 0 (stale); `current`, `behind` 0 (not stale). |

`problems` is always empty. Exit code 0 means the output was printed, whatever is stale. Exit 2 means it could not run: no master, an unknown system, a `--repo` that is not one of the system's repositories, wrong arguments (`--json` and `--system` are required), or git failing. It never exits 1.

## Naming rules

Three commands hold every naming rule, so a tool driving the build and the setup skill read them rather than repeat them. All print one JSON object on one line. Exit code 0 means no problems, 1 means problems, and 2 means the program could not run (an unreadable marker, or a system the marker does not list).

- `node ai-sdlc.ts naming --json <marker> <system> [--type <t> --scope <s> --change <c> --title <t>]` prints `{ "declared", "setting", "problems", "names" }`. `declared` is false, with `setting` null, when `systems.<system>.naming` is absent. Otherwise `setting` holds the `branch` and `pullRequestTitle` strings found, and `problems` lists every reason the setting is unusable (a missing pattern, an unknown part, `{title}` in the branch pattern, a branch pattern with none of `{slug}`, `{change}` or `{scope}`, which would give every change after the first the same branch, or a sample branch name git or the tool driving the build would refuse). `names` is `{ "branch", "pullRequestTitle" }`, present only when the setting is declared, has no problems, and `--type`, `--scope` and `--change` are all given; `pullRequestTitle` is null without `--title`. The parts are `{type}`, `{scope}`, `{slug}` (the change name without its `YYYY-MM-DD-` prefix), `{change}` and `{title}`. Rendering does not check the result: check the branch with `branch-name`.
- `node ai-sdlc.ts branch-name --json <name>` prints `{ "problems": [...] }`: git's branch-name rules plus a leading `-` and the `change/pending-` prefix that the tool driving the build reserves, and the name `HEAD`.
- `node ai-sdlc.ts scope --json <value>` prints `{ "problems": [...] }`: the first rule a scope breaks (empty, over 64 characters, a space, parentheses, a first character that is not a letter or digit, a character outside letters, digits, `-`, `_` and `.`, `..`, the name `HEAD`, a trailing `.`, or a `.lock` ending; the last three cannot end a branch name).

## Workspace resolution

`node ai-sdlc.ts resolve --json [--master <path>] [--workspace <path>]`, run from the session's directory, prints `{ "workspace", "master", "masterIsCopy", "problems" }` on one line: the absolute paths of the workspace and the master repository, whether the master is a linked worktree of the master repository (a change's own copy) rather than its main checkout, and every reason the answer was refused. `master` is null whenever `problems` is not empty; `workspace` is null only when it could not be found. Exit code 0 means no problems, 1 means `problems` lists them, 2 means the program could not run (git missing, an unknown option, an option given twice or without a value). The rules are in `references/workspace.md`, section 2; every skill and the tool driving the build call this one command rather than repeat them.

## Workspace instructions

`node ai-sdlc.ts instructions --json [--write] [--allow-home] [--master <path>] [--workspace <path>]` resolves the workspace and master as `resolve` does and prints `{ "workspaceMd", "claudeMd", "markerLines", "problems" }` on one line. It owns the workspace instructions: `<master>/intent/workspace.md` is the plugin's `references/templates/workspace.md` with every `<master>` replaced by the master's folder name in the workspace (for a copy, the workspace folder that is a worktree of the same repository, never the copy's own name), and the example table row replaced by one row per system in marker order, `` | <system> | <repos> | `<master>/intent/<system>/context/` | `<master>/intent/<system>/policies.md` | ``, `<repos>` being the system's repositories joined by `, `, or `all repositories except <master>` when it lists none; every other line is the template's, with LF line endings and one newline at the end. `<workspace>/CLAUDE.md` holds a copy between the marker lines `<!-- ai-sdlc:start -->` and `<!-- ai-sdlc:end -->` (a marker line equals a marker once surrounding whitespace is trimmed): the start marker line, `<!-- generated by ai-sdlc setup from <master>/intent/workspace.md; edit outside this block -->`, the full text of `intent/workspace.md`, then the end marker line. Nothing outside the block is changed, and nothing is committed.

Without `--write` it checks. `workspaceMd` is `missing`, `current` or `stale` (the file against the generated text). `claudeMd` is `missing` (no CLAUDE.md, no marker, or no `intent/workspace.md`), `current` or `stale` (the text in the block after the generated line against `intent/workspace.md`, ignoring line endings, blank lines at either end and trailing whitespace), `bad-markers`, or `home-folder`.

With `--write` it writes `intent/workspace.md` (`written`, or `current` when it was already) and the block: `claudeMd` is `created` (no CLAUDE.md: the file holds only the block), `updated` (no marker: a blank line and the block are appended; one of each, start first: the lines between them are replaced), `current` (nothing changed), `bad-markers` or `home-folder`.

`bad-markers`: the markers are not each there once, start before end; CLAUDE.md is left untouched. `home-folder`: the workspace folder is the home folder (`os.homedir()`, `$HOME`) and `--allow-home` was not given; CLAUDE.md is left untouched, and a check does not count it as a problem. `markerLines` lists the marker lines found in CLAUDE.md, `{ "line", "text" }`, 1-based. `problems` holds complete sentences to show. Exit code 0 means everything is current (check) or written (write), 1 that a check found something not current or a write left CLAUDE.md alone, 2 that it could not run (no master repository, a marker that lists no system, an unknown option).

## Lifecycle events

`node ai-sdlc.ts run <event> --json --change <change> [--system <s>] [--repo <r>]... [--document <file>] [--task T<n>] [--again] [--check] [--stream] [--master <path>] [--workspace <path>]` runs one event and prints `{ "event", "system", "change", "repo", "key", "subject", "outcome", "reused", "problems", "hooks", "failed", "details" }`:

- `outcome` is `passed` (exit 0), `failed` or `refused` (exit 1), or `could-not-run` (exit 2). `refused` means a precondition of the event's own step failed and nothing ran.
- `key` is what the result is about: the repository's head commit, or for `doc.accept` the last commit of the document. `subject` is the document of `doc.accept` or the task of `task.done`, else null.
- `reused` is true when a run that passed at the same key and subject was returned instead of running again (`doc.accept`, `task.done`, `build.finish`, `review.finish`); `--again` runs it anyway.
- `hooks` lists each hook that ran: `{ "id", "when", "outcome", "exitCode", "output" }`, where `outcome` is `passed`, `failed` or `could-not-run` and `output` is the last 200 lines of its standard output and error.
- `failed` is the blocking hook that stopped the event, `{ "id", "onFailure", "output" }`, or null.
- With `--check`, only the event's own preconditions and the hook configuration are checked, in each repository named: `--repo` may repeat for `build.start`, `task.done` and `build.finish` (and is given once otherwise; several without `--check` are a usage error), and without it the session's repository is checked. No hook runs, nothing changes and the ledger records nothing, so a blocking before hook can still stop the real run. It prints `{ "event", "system", "change", "check": true, "outcome", "problems", "refusing", "repos" }`: `repos` holds `{ "repo", "outcome", "problems" }` for each repository in the order named; `outcome` is `passed` (exit 0) only when every one passed, `could-not-run` (exit 2) when any could not (a repository that is not the system's or not checked out, a broken hook configuration), else `refused` (exit 1); `refusing` names each repository that would refuse, and `problems` lists every repository's problems. A tool that runs `build.start` in several repositories checks them all in one call first, so a refusal in one leaves every one as it was.
- With `--stream`, one line `{ "type": "hook-start" | "hook-end", "id", "when", "outcome"? }` per hook comes first, and the last line is the outcome with `"type": "outcome"`.

`build.start`, `task.done` and `build.finish` run in one product repository, given by `--repo` or by the session's repository; the others run in the master repository. The change is found in its copy in `<workspace>/.ai-sdlc/copies/<change>/`, else in the resolved master: the copy wins when both hold it, the same order `state` uses.

`node ai-sdlc.ts hooks --json --system <s> [--event <e>]` prints `{ "revision", "gateRetries", "hooks", "problems" }`: the hooks as they will run, read from the master's base branch, each `{ "id", "event", "when", "run", "repos", "timeout", "blocking", "onFailure", "layer" }`. Exit 1 when the configuration has problems; an event refuses to run (`could-not-run`) while it has any.

`node ai-sdlc.ts status --json --change <c>` prints `{ "system", "change", "repos" }`, each repository `{ "repo", "path", "head", "runs" }`, each run as recorded with `current` true while its key is still the repository's head (or the document's last commit).

`check` also takes `.ai-sdlc.json` and `intent/<system>/hooks.json` and prints each problem of their hook configuration at line 1.

## A change's branch and copy

`node ai-sdlc.ts change start --json --system <s> --change <YYYY-MM-DD-slug> --type <t> --scope <scope> [--title <t>] [--branch <name>]` runs the `change.start` event and prints its outcome as `run` does, with `details` `{ "branch", "type", "base", "copy", "created" }`. The branch is `--branch`, else the team's naming as committed on the master's base branch, else `change/<change>`. It is refused, with nothing made, when the change name, type or scope is invalid, the master has no base branch, the name is invalid, or it is taken (section on branch names below). A second run finds the copy and its record and prints `"created": false`.

A branch name is taken when a branch on this machine, local or last fetched from the remote, in the master or any repository of the system matches it ignoring capitals, or when one of the two names is a folder of the other. The change's own branch never counts, and nothing is fetched.

`change.yml`, in the change's folder:

```yaml
version: 1
branch: "feat/PROJ-123-password-reset"
type: feat
scope: "PROJ-123"
base: "main"
pullRequests:
  - repo: "app"
    url: "https://github.com/example/app/pull/7"
    number: 7
    pushed: "3f2a9c1e4b7d"
```

`pullRequests` is left out until `change.done` writes it. A change with no `change.yml` has the branch its `branch.md` front matter names, else `change/<change>`. `check` takes `change.yml`.

`node ai-sdlc.ts change rename --json --change <c> --to <name>` prints `{ "change", "from", "to", "renamed", "problems" }`, `renamed` listing `master` and each product repository whose branch moved. `change remove --json --change <c> [--abandon]` prints `{ "change", "removed", "kept", "problems" }`. Without `--abandon` it removes the copy and each local branch git sees as merged, keeping and naming the others. With or without `--abandon`, a copy with uncommitted files (modified, staged or untracked; ignored files do not count) is refused, the problem naming them, and nothing is removed: the copy is removed with `git worktree remove`, never forced, so git checks it at the moment of removal and a file written after a caller's own check still stops it. With `--abandon` it drops a change nothing was done in: it removes the copy and deletes the change's local branch in the master and every product repository with `-D`. A change whose intent is `rejected` in the copy's `HEAD` may have documents on the master's change branch; that branch records the rejection, so it is kept and listed in `kept` as `master: <branch> (it records the rejected intent)`. It refuses, removing nothing, when `change.yml` records a pull request, when a product repository's change branch has commits beyond its base or is checked out, when the master's change branch has commits beyond its base other than the program's own `start change <change>` commit (unless the intent is rejected), or when the copy has uncommitted files. `change show --json --change <c> [--refresh]` prints `{ "change", "system", "master", "branch", "record", "repos" }`, plus `"states"` with `--refresh`: `repos` maps every repository of the system to `{ "path", "checkedOut", "branch", "base" }` (its absolute path, whether it is checked out in the workspace, its current branch, null on a detached HEAD or when it is not checked out, and its base branch, null when it has none), and `states` maps each pull request's address to `OPEN`, `MERGED`, `CLOSED`, or null when gh cannot read it.

The `build.start` event's step puts the repository on the change's branch from its base branch, from the change's branch itself, or from another change's branch with no active build. Another change's branch is the branch a change of the same system names (its `change.yml`, else `branch.md`, else `change/<change>`), in the master's checkout or any change copy; a branch no change names is never switched off. That change's build is active in the repository when the repository's `active-build.json` names it and its `build.finish` has not passed at the repository's head. Off any branch but the change's, it refuses uncommitted files. It prints `details` `{ "branch", "created", "uncommitted", "from" }`, `from` being the branch the repository was on before (null on a detached HEAD). `uncommitted` lists the repository's uncommitted files, and is empty when it is clean: on the change's branch they do not refuse it (a build in progress), while on the base branch they do, since the switch would carry them along. In the master repository listed as a product repository, `intent/` and `.ai-sdlc.json` are not counted. It writes `ai-sdlc/active-build.json` in the repository's git folder, `{ "system", "change", "repo", "master", "workspace" }`, which the Stop gate reads.

## Baseline

A repository's checks are the blocking before hooks of `build.finish` that apply to it. Their baseline is how each did on the base commit (the merge-base of the repository's head and its base branch), stored in `ai-sdlc/<system>/.baselines/<repo>.json` in the master's common git folder for that base commit and a signature of the checks (their `id`, `run` and `timeout`, and the git trees of `intent/hooks` and `intent/<system>/hooks` on the base branch). A failed hook's IDs are the trimmed, distinct, non-empty lines it wrote to the file `AI_SDLC_FAILURES` names, or `null`; every hook record carries `ids`.

`node ai-sdlc.ts baseline show|retake --json --change <c> --repo <r> [--system <s>] [--master <path>] [--workspace <path>]` prints `{ "base", "taken", "reused", "hooks": [{ "id", "outcome", "ids" }], "needsApproval", "approved", "problems" }`. `show` runs nothing; `retake` drops the stored entry and takes it again. `needsApproval` lists the checks that failed on the base without IDs and are not approved for this change at that base commit. Exit 0, 1 when a baseline cannot be taken (uncommitted files, a detached HEAD, no base branch), 2 when a check could not run on the base, in which case nothing is stored.

`node ai-sdlc.ts baseline approve --json --change <c> --repo <r> --hook <id> [...]` prints `{ "approved": { "hook", "base" } | null, "problems" }`. It refuses a check that passed on the base, that has IDs, or that is not in the baseline. The approval is kept in the change's ledger (`approvals`) and counts for that repository, check and base commit only.

`build.start` takes the baseline after its after hooks and prints `details.baseline` `{ "base", "reused", "failing": [{ "id", "ids" }], "approved" }`, or `{ "base", "deferred" }` when a resumed build has uncommitted files and no baseline yet (build.finish takes it then). It fails with `failed.onFailure` `stop` on a check that needs approval, one problem per such check, each ending with the `baseline approve` command for it. `build.finish` takes or reuses the baseline before its checks and judges each failure: a check new or green on the base blocks; one red on the base passes when its IDs are a subset of the base's (`stillFailing`), blocks naming its new IDs otherwise, blocks when it no longer says what failed, and, without IDs on the base, passes only when approved (`approved`); a check red on the base and green now is in `fixed`. It prints `details.baseline` `{ "base", "reused", "fixed", "stillFailing", "approved" }`, which the ledger keeps (`details` on a run).

## The gate and the guard

`node ai-sdlc.ts gate` and `node ai-sdlc.ts guard` are Claude Code hooks: each reads Claude Code's hook input as JSON on standard input, always exits 0, and prints nothing when it allows. The gate prints `{ "decision": "block", "reason" }` to keep the session from stopping, or `{ "systemMessage" }` when it lets the session stop after the retries are used up. The guard prints `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason" } }`.

The gate blocks only when the session's repository holds `ai-sdlc/active-build.json` (written by `build.start`), is on the change's branch, every task the plan gives it has a build log entry, and either no `build.finish` is recorded at its head, or the one recorded failed on a blocking hook with `onFailure: fix` and the gate has blocked fewer than `gateRetries` times for that hook at that head (counted in the ledger's `gateBlocks`).

`build.finish` is refused while a task the plan gives the repository has no build log entry, while the repository is not on the change's branch, or while a commit on the branch beyond its base lacks the change's scope or the `Generated-By: ai-sdlc` trailer.

## Declaring a change done

`node ai-sdlc.ts run change.done --json --change <c>` runs in the master copy the change lives in. Its preconditions, all checked before anything is pushed, refuse with every problem listed: no readable plan; the master copy off the change's branch or with uncommitted files; a repository the plan names that is not checked out, lacks the branch, has uncommitted files, or has a task without a build log entry; a commit beyond a touched repository's base that breaks the commit rules; no review, or a latest review whose `commits` do not cover a touched repository's head, or that has a finding of severity `high` (or `critical`), each listed as `F<n> (<repo>, <file>:<line>): <first line of its text>` (a finding is resolved when a later review no longer reports it); a touched repository off the branch, or whose `build.finish` (rerun when stale) does not pass at its head; a repository with no `origin`, an unreachable remote, or a branch on the remote that is neither absent nor an ancestor of the local branch; and `gh auth status` failing for a host.

A touched product repository is one the plan names whose change branch has commits beyond its local and remote base; the master is always touched. The step pushes each touched product repository's branch, opens a pull request with `gh pr create` (or reuses the open one `gh pr list --head <branch>` finds), writes `pullRequests` to `change.yml` and commits it as `docs(<scope>): record pull requests <change>`, pushes the master copy, opens the master's pull request with the others listed in its body, records it, commits again and pushes. The title is the team's `pullRequestTitle` pattern from the base branch's marker, else the intent's title. On success `details` is `{ "pushed", "pullRequests" }`; a failure is `failed` with what was pushed so far, and a second run carries on, reusing open pull requests. Every GitHub call runs `gh` from PATH, or the program and leading arguments `AI_SDLC_GH` names as a JSON list of non-empty strings (as a hook's `run`), such as `["node", "/path/fake-gh.js"]`; any other value of `AI_SDLC_GH` stops the call with a message.

## Committing

`node ai-sdlc.ts commit --json --kind <kind> [--system <s>] [--change <c>] [--repo <repo> [--task T<n>] --type <type> --subject "<text>"] [--master <path>] [--workspace <path>] -- <path>...` makes every commit an ai-sdlc skill makes. A skill names the kind and the files it wrote; the program picks the repository, the paths that go in, the documents it checks first, the header, the scope and the trailers. The commits the program makes itself (`start change`, `rename branch`, `record pull requests`) use the same commit code.

| `--kind` | Needs | Repository | Header |
|---|---|---|---|
| `setup` | `--system` | master | `chore(<system scope>): set up ai-sdlc for <system>` |
| `instructions` | | master | `chore(<system scope of the marker's first system>): refresh workspace instructions` |
| `context` | `--system` | master | `docs(<system scope>): build context for <repo>, <repo>`; `refresh` in place of `build` when every path committed is already in `HEAD`; more than three repositories: `build context for <n> repositories`, with the repositories listed in the body (`app, api, web, worker`) before the trailer |
| `intent-draft` | `--change` | change's master | `docs(<change scope>): draft intent <change>` |
| `intent-reopen` | `--change` | change's master | `docs(<change scope>): reopen intent <change>` |
| `spec` | `--change` | change's master | `docs(<change scope>): write spec <change>` |
| `spec-reopen` | `--change` | change's master | `docs(<change scope>): reopen spec <change>` |
| `plan` | `--change` | change's master | `docs(<change scope>): write plan <change>` |
| `build-log` | `--change` | change's master | `docs(<change scope>): log T<n> of <change>`; several entries: `log T3, T4 of <change>` |
| `review` | `--change` | change's master | `docs(<change scope>): record review <n> of <change>` |
| `fix-draft` | `--change` | change's master | `docs(<change scope>): draft fix <change>` |
| `fix-reopen` | `--change` | change's master | `docs(<change scope>): reopen fix <change>` |
| `accept-intent`, `accept-spec`, `accept-plan` | `--change` | change's master | `docs(<change scope>): accept intent <change>` (`spec`, `plan`) |
| `reject-intent`, `reject-fix` | `--change` | change's master | `docs(<change scope>): reject intent <change>` (`reject fix <change>`) |
| `work` | `--change --repo --type --subject`, optionally `--task` | `<workspace>/<repo>` | `<type>(<change scope>): <subject>` |

The repositories of `context` are the `<repo>` of each `intent/<system>/context/<repo>.md` path committed, in the order given. The tasks of `build-log` are the entries the build logs committed add against `HEAD`, in document order; a build log that adds none cannot be committed (exit 2). The `<n>` of `review` is the number of `## Review` sections in the working `build/review.md`. `--type` is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, and `--task` is `T<n>`.

**Trailers.** Every kind but `work` ends with the paragraph `Generated-By: ai-sdlc`. `work` with `--task` ends with one paragraph of two trailers, `Generated-By: ai-sdlc` and `Plan-Task: T<n>`; without `--task` (work on the engineer's instructions after a review, which belongs to no plan task) it ends with `Generated-By: ai-sdlc` only.

**Scope.** The system scope is `systems.<system>.commitScope` in the marker when it is lowercase kebab-case, else the system name. The change scope is the intent's `scope` front matter as typed when `scope` accepts it, else the scope `change.yml` records, else the system scope.

**Repository.** The master is resolved as `resolve` resolves it (`--master` and `--workspace` as there). With `--change`, it is the master holding the change as `state` decides it: the change's copy, `<workspace>/.ai-sdlc/copies/<change>/`, when it has one. `work` commits in `<workspace>/<repo>`, and cannot run for a repository the system does not list or that is not checked out.

**Paths.** Each path after `--`, absolute or relative to the directory the command runs in (or, when nothing is there but the repository has it, relative to the repository's root), must be inside the repository the kind commits in, or the command cannot run. Only the paths `git status --porcelain` lists go in (a folder counts when a file under it is listed); when none is left, nothing is committed and the command exits 0 with `reason` `nothing changed`. Those paths are staged (`git add -A -- <paths>`) and committed with `git commit -- <paths>`, so anything else staged stays staged and out of the commit. Nothing is committed with `-a` or `--no-verify`.

**Check.** Before committing, the change's documents that exist are checked as `check` checks them: `spec` and `spec-reopen` check `spec.md`; `plan`, `fix-draft`, `fix-reopen`, `accept-spec` and `accept-plan` check `spec.md` and `plan.md`; `build-log` checks `spec.md`, `plan.md` and every file of `build/` except `review.md`; `review` checks those and `build/review.md`; `setup` checks `.ai-sdlc.json` and `intent/<system>/hooks.json` when they are among the paths committed. Any problem: nothing is staged or committed, exit 1, `reason` `check failed`, and `problems` lists them as `check` prints them, `<file>:<line>: <message>` with the file's absolute path.

**Header.** The header must match `^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\s]+\))?!?: \S.*$`; one that does not (a `--subject` starting with a space or holding a line break) cannot run.

**Git.** A detached `HEAD`, a hook that refuses, or a missing identity: exit 1, `reason` `git refused`, `problems` holding git's error as it printed it (for a detached `HEAD`, the program's own sentence), the files left as written. When another process holds `index.lock`, the command waits two seconds and tries again, up to five times; then git's error is reported the same way.

### Output

One JSON line:

```json
{ "committed": true, "repository": "/w/.ai-sdlc/copies/2026-10-21-greeting", "sha": "<full sha>", "header": "docs(demo): write spec 2026-10-21-greeting", "paths": ["intent/demo/2026-10-21-greeting/spec.md"], "reason": null, "problems": [] }
```

`repository` is the absolute path committed in, `paths` the paths that went in (or would have), relative to it. With `committed: false`, `sha` is null and `reason` is `nothing changed` (exit 0; `header` null, `paths` empty), `check failed` (exit 1; `header` null) or `git refused` (exit 1). Exit 2, with the reason on standard error: an unknown kind, a missing or invalid option, a path outside the repository, no master, a change or system that is not there, or a header the self-check refuses.
