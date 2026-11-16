// run <event> --json --change <change> [--system <s>] [--repo <r>]... [--document <file>] [--task T<n>] [--again]
//     [--check] [--stream] [--master <path>] [--workspace <path>]
// Runs one lifecycle event of a change: its preconditions, its before hooks, its built-in step, then its after hooks,
// and records the result in the ledger. Prints one line of JSON: the event, the outcome (`passed`, `failed`,
// `refused` or `could-not-run`), its problems, every hook's result, and the blocking hook that failed with what it
// asks for (`onFailure`: `fix` or `stop`). With --stream, one JSON line per hook as it starts and ends comes first.
// A run that passed at the same commit is reused unless --again is given. Exit 0 passed, 1 failed or refused,
// 2 could not run. With --check, only the event's own preconditions and the hook configuration are checked, in every
// repository named (--repo may repeat, for build.start, task.done and build.finish): no hook runs, nothing changes
// and nothing is recorded. It prints `{ event, system, change, check: true, outcome, problems, refusing, repos }`,
// passing only when every repository passes, `refusing` naming each that would refuse and `repos` each one's
// `{ repo, outcome, problems }`. A tool that runs build.start in several repositories checks them all first, so a
// refusal in one leaves every one as it was. change.start runs through `change start`, which creates what it runs on.
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { CouldNotRun, EXIT } from '../common/types.ts';
import { EVENTS, PER_REPOSITORY, type EventName } from '../events/config.ts';
import { eventContext, type ContextArgs } from '../events/context.ts';
import { runEvent } from '../events/runner.ts';
import type { Outcome } from '../events/ledger.ts';

type Checked = { repo: string; outcome: Outcome; problems: string[] };

/** --check: the event's preconditions in each repository named, one result each; nothing changes anywhere. */
async function checkAll(base: Omit<ContextArgs, 'repo'>, repos: (string | undefined)[]): Promise<number> {
  const results: Checked[] = [];
  let system: string | null = null;
  for (const repo of repos) {
    try {
      const ctx = eventContext(process.cwd(), { ...base, ...(repo ? { repo } : {}) });
      system ??= ctx.system;
      const out = await runEvent(ctx, { checkOnly: true });
      results.push({ repo: ctx.repo, outcome: out.outcome, problems: out.problems });
    } catch (e) {
      if (!(e instanceof CouldNotRun)) throw e;
      results.push({ repo: repo ?? '', outcome: 'could-not-run', problems: [e.message] });
    }
  }
  const outcome: Outcome = results.some((r) => r.outcome === 'could-not-run') ? 'could-not-run' : results.some((r) => r.outcome !== 'passed') ? 'refused' : 'passed';
  printJson({ event: base.event, system, change: base.change, check: true, outcome, problems: results.flatMap((r) => r.problems), refusing: results.filter((r) => r.outcome === 'refused').map((r) => r.repo), repos: results });
  if (outcome === 'passed') return EXIT.PASS;
  return outcome === 'could-not-run' ? EXIT.COULD_NOT_RUN : EXIT.PROBLEMS;
}

export const run: Command = {
  usage: 'run <event> --json --change <change> [--system s] [--repo r]... [--document f] [--task T<n>] [--again] [--check] [--stream] [--master p] [--workspace p]',
  async run(args) {
    // --repo may repeat, with --check only; every other option is parsed once.
    const repos: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--repo') rest.push(args[i] as string);
      else {
        const value = args[++i];
        if (value === undefined) throw new UsageError();
        repos.push(value);
      }
    }
    const o = parseOptions(rest, { values: ['change', 'system', 'document', 'task', 'master', 'workspace'], flags: ['json', 'again', 'check', 'stream'] });
    const [event] = o.positional;
    if (o.positional.length !== 1 || !o.flags.has('json') || !o.values.change) throw new UsageError();
    if (!(EVENTS as readonly string[]).includes(event as string) || event === 'change.start') throw new UsageError();
    if (repos.length > 1 && (!o.flags.has('check') || !PER_REPOSITORY.includes(event as EventName))) throw new UsageError();
    const extra: Record<string, string> = {};
    if (o.values.document) extra.document = o.values.document;
    if (o.values.task) extra.task = o.values.task;
    const base = {
      event: event as EventName,
      change: o.values.change,
      ...(o.values.system ? { system: o.values.system } : {}),
      options: { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) },
      extra,
    };
    if (o.flags.has('check')) return checkAll(base, repos.length > 0 ? repos : [undefined]);
    const ctx = eventContext(process.cwd(), { ...base, ...(repos[0] ? { repo: repos[0] } : {}) });
    const outcome = await runEvent(ctx, { again: o.flags.has('again'), ...(o.flags.has('stream') ? { progress: (p) => printJson(p) } : {}) });
    printJson(o.flags.has('stream') ? { type: 'outcome', ...outcome } : outcome);
    if (outcome.outcome === 'passed') return EXIT.PASS;
    return outcome.outcome === 'could-not-run' ? EXIT.COULD_NOT_RUN : EXIT.PROBLEMS;
  },
};
