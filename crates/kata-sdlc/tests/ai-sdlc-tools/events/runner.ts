// Runs one event: its step's preconditions, the before hooks in order, the step's own work, then the after hooks,
// and records the result in the ledger. A check-only run stops after the preconditions and records nothing. A failed
// blocking before hook skips the step and the after hooks. A failed after hook is reported and changes nothing.
import { hooksFor, readHookConfig, type Hook, type HookConfig, type OnFailure } from './config.ts';
import type { EventContext } from './context.ts';
import { appendRun, emptyLedger, latest, ledgerFolder, readLedger, writeLedger, type EventRecord, type HookRecord, type Outcome } from './ledger.ts';
import { runProcess } from './process.ts';
import { exportScripts, type ScriptFolders } from './scripts.ts';
import { STEPS } from './steps/index.ts';

export type EventOutcome = {
  event: string;
  system: string;
  change: string;
  repo: string;
  key: string;
  subject: string | null;
  outcome: Outcome;
  /** True when a run that passed at the same key was reused rather than run again. */
  reused: boolean;
  problems: string[];
  hooks: HookRecord[];
  /** The blocking hook that failed, what it asks for, and its output. */
  failed: { id: string; onFailure: OnFailure; output: string } | null;
  details: Record<string, unknown>;
};

/** Called for each hook as it starts and ends, for `run --stream`. */
export type Progress = (event: { type: 'hook-start' | 'hook-end'; id: string; when: Hook['when']; outcome?: HookRecord['outcome'] }) => void;

/** `${hooks}`, `${repo}` and `${master}` in a hook's arguments. */
function expand(arg: string, hook: Hook, ctx: EventContext, scripts: ScriptFolders): string {
  return arg.replaceAll('${hooks}', scripts.folderOf(hook.layer)).replaceAll('${repo}', ctx.repoPath).replaceAll('${master}', ctx.master);
}

function environment(ctx: EventContext, hook: Hook): Record<string, string> {
  return {
    AI_SDLC_HOOKS_VERSION: '1',
    AI_SDLC_EVENT: ctx.event,
    AI_SDLC_WHEN: hook.when,
    AI_SDLC_HOOK: hook.id,
    AI_SDLC_SYSTEM: ctx.system,
    AI_SDLC_CHANGE: ctx.change,
    AI_SDLC_REPO: ctx.repo,
    AI_SDLC_REPO_PATH: ctx.repoPath,
    AI_SDLC_MASTER: ctx.master,
    AI_SDLC_BRANCH: ctx.branch ?? '',
    AI_SDLC_BASE: ctx.base ?? '',
    AI_SDLC_HEAD: ctx.head ?? '',
  };
}

async function runHooks(hooks: Hook[], ctx: EventContext, scripts: ScriptFolders, details: Record<string, unknown>, progress?: Progress): Promise<{ records: HookRecord[]; stoppedBy: Hook | null }> {
  const records: HookRecord[] = [];
  for (const hook of hooks) {
    progress?.({ type: 'hook-start', id: hook.id, when: hook.when });
    const input = JSON.stringify({ ...environment(ctx, hook), details });
    const r = await runProcess(hook.run.map((a) => expand(a, hook, ctx, scripts)), { cwd: ctx.repoPath, env: environment(ctx, hook), input, timeoutSeconds: hook.timeout });
    const record: HookRecord = { id: hook.id, when: hook.when, outcome: r.outcome, exitCode: r.exitCode, output: r.output };
    records.push(record);
    progress?.({ type: 'hook-end', id: hook.id, when: hook.when, outcome: r.outcome });
    if (r.outcome !== 'passed' && hook.blocking) return { records, stoppedBy: hook };
  }
  return { records, stoppedBy: null };
}

/** `checkOnly` checks the step's preconditions and the hook configuration, then stops: no hook, no step, no ledger entry. */
export type RunOptions = { again?: boolean; checkOnly?: boolean; progress?: Progress; config?: HookConfig };

export async function runEvent(ctx: EventContext, options: RunOptions = {}): Promise<EventOutcome> {
  const step = STEPS[ctx.event];
  const key = step.key?.(ctx) ?? ctx.head ?? '';
  const subject = step.subject?.(ctx) ?? null;
  const base = { event: ctx.event, system: ctx.system, change: ctx.change, repo: ctx.repo, key, subject };
  const folder = ledgerFolder(ctx.master, ctx.system, ctx.change);
  const ledger = readLedger(folder, ctx.repo) ?? emptyLedger(ctx.system, ctx.change, ctx.repo, ctx.repoPath);
  const result = (outcome: Outcome, rest: Partial<EventOutcome> = {}): EventOutcome => ({ ...base, outcome, reused: false, problems: [], hooks: [], failed: null, details: {}, ...rest });

  const preconditions = (await step.check?.(ctx)) ?? [];
  if (options.checkOnly) {
    if (preconditions.length > 0) return result('refused', { problems: preconditions });
    const config = options.config ?? readHookConfig(ctx.master, ctx.system);
    if (config.problems.length > 0) return result('could-not-run', { problems: config.problems.map((p) => `the hook configuration on the base branch: ${p}`) });
    return result('passed', { details: { checkOnly: true } });
  }
  if (preconditions.length > 0) return record(result('refused', { problems: preconditions }));

  const previous = latest(ledger, ctx.event, key, subject);
  if (step.reusePassed && !options.again && previous?.outcome === 'passed') {
    return result('passed', { reused: true, hooks: previous.hooks });
  }

  const config = options.config ?? readHookConfig(ctx.master, ctx.system);
  if (config.problems.length > 0) return result('could-not-run', { problems: config.problems.map((p) => `the hook configuration on the base branch: ${p}`) });
  const scripts = exportScripts(ctx.master, config.revision, ctx.system);
  try {
    const details: Record<string, unknown> = {};
    const before = await runHooks(hooksFor(config, ctx.event, 'before', ctx.repo), ctx, scripts, details, options.progress);
    if (before.stoppedBy) {
      const failure = before.records[before.records.length - 1] as HookRecord;
      const outcome: Outcome = failure.outcome === 'could-not-run' ? 'could-not-run' : 'failed';
      return record(result(outcome, { hooks: before.records, failed: { id: failure.id, onFailure: before.stoppedBy.onFailure, output: failure.output }, problems: [`hook ${failure.id} ${failure.outcome === 'failed' ? `failed with exit code ${failure.exitCode}` : 'could not run'}`] }));
    }
    const acted = (await step.act?.(ctx)) ?? { problems: [] };
    Object.assign(details, acted.details ?? {});
    if (acted.problems.length > 0) return record(result('failed', { hooks: before.records, problems: acted.problems, details }));
    const after = await runHooks(hooksFor(config, ctx.event, 'after', ctx.repo), ctx, scripts, details, options.progress);
    const warnings = after.records.filter((h) => h.outcome !== 'passed').map((h) => `after hook ${h.id} ${h.outcome === 'failed' ? `failed with exit code ${h.exitCode}` : 'could not run'}; nothing was undone`);
    return record(result('passed', { hooks: [...before.records, ...after.records], problems: warnings, details }));
  } finally {
    scripts.remove();
  }

  function record(outcome: EventOutcome): EventOutcome {
    const failed = outcome.failed ? { id: outcome.failed.id, onFailure: outcome.failed.onFailure } : null;
    const entry: EventRecord = { event: ctx.event, repo: ctx.repo, key, subject, outcome: outcome.outcome, at: new Date().toISOString(), hooks: outcome.hooks, problems: outcome.problems, failed };
    const fresh = readLedger(folder, ctx.repo) ?? ledger;
    writeLedger(folder, appendRun({ ...fresh, path: ctx.repoPath }, entry));
    return outcome;
  }
}
