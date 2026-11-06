# The ai-sdlc program

Every ai-sdlc skill, and every tool that drives them such as Kata, runs this program for the decisions that must not depend on how a model reads prose: where the workspace and the master repository are, whether a document has the right layout, what a fix's state is, which names a team's naming gives.

```
node <plugin>/tools/ai-sdlc.ts <command> [arguments]
```

It is TypeScript, and the files here are what runs: Node.js 22.18 or later runs TypeScript as it is, so there is no build step and no compiled copy. Run it with no command to print every command's usage.

## Where to start reading

| Path | What it holds |
|---|---|
| `ai-sdlc.ts` | The entry point. It only picks the command and prints errors. |
| `commands/` | One file per command. Each starts with its usage and what it prints, then parses its arguments and calls the code below. |
| `documents/` | One reader per document kind (`spec.ts`, `plan.ts`, `build-log.ts`, `review.ts`), and what they share: `doc.ts` splits Markdown, `front-matter.ts` reads the front matter, `records.ts` reads YAML records, `read.ts` picks the reader. |
| `changes/` | Whole-change logic: `cross-check.ts` checks one change's documents against each other, `fix-state.ts` says where a light-track fix stands, `state.ts` says where every change of a system stands, each task's commits, and whether each skill may work on it (`state`), `list.ts` lists a system's changes with title, track and whether each is finished, from the intents alone (`list`), `place.ts` finds the changes of a system and the repository that holds each, for `state` and `list`, `finished.ts` says whether a change is rejected, merged or open, for both, `system-read.ts` reads one repository's documents in a fixed number of git processes, `progress.ts` says which of a plan's tasks have a build log entry, `record.ts` reads and writes `change.yml`, `scope.ts` holds the commit scope and commit rules, `commit.ts` makes every commit a skill asks for (`commit`: the kinds, headers, trailers, paths and the check first), `rename.ts` and `remove.ts` rename a change's branch and clean up after it, or drop a change nothing was done in. |
| `workspace/` | The workspace around the documents: `marker.ts` reads `.ai-sdlc.json`, `resolve.ts` finds the workspace and master, `naming.ts` holds the naming and scope rules, `branches.ts` says whether a branch name is free, `stale.ts` says whether each repository's context file is behind its repository (`stale`), `own-files.ts` names ai-sdlc's own files in the master and a repository's uncommitted files without them, `instructions.ts` generates the workspace instructions and keeps their copy in the workspace `CLAUDE.md`. |
| `events/` | Lifecycle events and their hooks: `config.ts` reads and layers the hook configuration from the base branch, `runner.ts` runs an event, `process.ts` runs one hook, `scripts.ts` exports hook scripts from the base branch, `ledger.ts` records results, `context.ts` works out what an event runs on. |
| `events/steps/` | Each event's built-in step, one file per event: what the plugin itself does between the before and after hooks. |
| `commands/gate.ts`, `commands/guard.ts` | The Claude Code hooks the skills declare: the Stop gate that holds a build to its checks, and the guard on tool calls. |
| `baseline/` | The baseline of a repository's checks on its base commit: `store.ts` keeps it per base commit and check signature, `take.ts` takes it in the repository (in place, or on a detached checkout of the base), `approvals.ts` holds the engineer's approvals and the problem that asks for one. `build.start` and `build.finish` use it, and `commands/baseline.ts` shows, retakes and approves. |
| `git/` | `git.ts` and `gh.ts`, the only files that start git (branches, commits through one helper, `commitPaths`, that waits for a held `index.lock`, pushes, the hook configuration) or the GitHub command-line tool (sign-in, pull requests). |
| `common/` | Types, exit codes and problem printing that everything uses. |
| `schema/` | JSON schemas for the records inside documents, and for what `read --json` prints. |
| `GRAMMAR.md` | Every document layout and every command's output, in prose. |
| `examples/` | Documents with their expected output; the tests read them, and so may a tool that drives the build. |
| `vendor/` | The third-party libraries the program uses, generated (see below). |
| `test/` | The tests, which run the program the way the skills do. |

Every command exits 0 when it passed, 1 when it found problems (printed on standard output), and 2 when it could not run (the reason on standard error).

## Third-party code

An installed plugin has no `node_modules`, so the libraries the program uses (`yaml`, `ajv`, `@cucumber/gherkin`, `mdast-util-from-markdown`) are bundled into `vendor/`, one file per library, each starting with the packages and versions it holds. Their licenses are in `vendor/THIRD_PARTY_LICENSES.txt`. Nothing else is generated: the plugin's own code never imports a package except through `vendor/`, and a test checks that.

## Working on it

```
npm install          # the type checker, esbuild and the libraries, for development only
npm run typecheck    # tsc: strict, and refuses syntax Node cannot run as it is
npm test             # node --test
npm run vendor       # after changing a library's version in package.json; commit vendor/
```

Write only TypeScript that Node can run by removing the types: no `enum`, `namespace`, or constructor parameter properties, `import type` for types, and a `.ts` extension on every relative import. `npm run typecheck` refuses anything else. `../format/check.mjs` is the program's old path; it only forwards here, so tools that still call it keep working until 2.0.
