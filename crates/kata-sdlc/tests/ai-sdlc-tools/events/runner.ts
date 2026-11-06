// Runs one event: its step's preconditions, the before hooks in order, the step's own work, then the after hooks,
// and records the result in the ledger. A check-only run stops after the preconditions and records nothing. A failed
// blocking before hook skips the step and the after hooks. A failed after hook is reported and changes nothing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooksFor, readHookConfig, type Hook, type HookConfig, type OnFailure } from './config.ts';
import type { EventContext } from './context.ts';
import { appendRun, emptyLedger, latest, ledgerFolder, readLedger, writeLedger, type EventRecord, type HookRecord, type Outcome } from './ledger.ts';
import { runProcess } from './process.ts';
import { exportScripts, type ScriptFolders } from './scripts.ts';
import { STEPS } from './steps/index.ts';
import type { Judge } from './steps/step.ts';

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

/**
 * Runs one hook and returns its record. Each run gets its own empty folder for the file AI_SDLC_FAILURES names, so
 * no two hooks, or two runs of one hook, ever read each other's IDs. `extraEnv` adds variables, such as
 * AI_SDLC_BASELINE for a baseline run.
 */
export async function runHook(hook: Hook, ctx: EventContext, scripts: ScriptFolders, details: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<HookRecord> {
  const folder = mkdtempSync(join(tmpdir(), 'ai-sdlc-ids-'));
  try {
    const failuresFile = join(folder, 'failures.txt');
    const env = { ...environment(ctx, hook), AI_SDLC_FAILURES: failuresFile, ...extraEnv };
    const input = JSON.stringify({ ...env, details });
    const r = await runProcess(hook.run.map((a) => expand(a, hook, ctx, scripts)), { cwd: ctx.repoPath, env, input, timeoutSeconds: hook.timeout, failuresFile });
    return { id: hook.id, when: hook.when, outcome: r.outcome, exitCode: r.exitCode, output: r.output, ids: r.ids };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

type Stopped = { hook: Hook; problem: string | null; onFailure: OnFailure };

/** Runs hooks in order; a blocking hook's failure stops the rest, unless the judge allows it. */
async function runHooks(hooks: Hook[], ctx: EventContext, scripts: ScriptFolders, details: Record<string, unknown>, progress?: Progress, judge?: Judge): Promise<{ records: HookRecord[]; stoppedBy: Stopped | null }> {
  const records: HookRecord[] = [];
  for (const hook of hooks) {
    progress?.({ type: 'hook-start', id: hook.id, when: hook.when });
    const record = await runHook(hook, ctx, scripts, details);
    records.push(record);
    progress?.({ type: 'hook-end', id: hook.id, when: hook.when, outcome: record.outcome });
    if (!hook.blocking) continue;
    const verdict = judge?.(hook, record) ?? { allow: record.outcome === 'passed' };
    if (record.outcome !== 'passed' && !verdict.allow) return { records, stoppedBy: { hook, problem: verdict.problem ?? null, onFailure: verdict.onFailure ?? hook.onFailure } };
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
    const prepared = (await step.prepare?.(ctx, config)) ?? { problems: [] };
    Object.assign(details, prepared.details ?? {});
    if (prepared.problems.length > 0) return record(result(prepared.outcome ?? 'failed', { problems: prepared.problems, details, failed: prepared.failed ?? null }));
    const before = await runHooks(hooksFor(config, ctx.event, 'before', ctx.repo), ctx, scripts, details, options.progress, prepared.judge);
    if (before.stoppedBy) {
      const failure = before.records[before.records.length - 1] as HookRecord;
      const outcome: Outcome = failure.outcome === 'could-not-run' ? 'could-not-run' : 'failed';
      const problem = before.stoppedBy.problem ?? `hook ${failure.id} ${failure.outcome === 'failed' ? `failed with exit code ${failure.exitCode}` : 'could not run'}`;
      return record(result(outcome, { hooks: before.records, details, failed: { id: failure.id, onFailure: before.stoppedBy.onFailure, output: failure.output }, problems: [problem] }));
    }
    const acted = (await step.act?.(ctx)) ?? { problems: [] };
    Object.assign(details, acted.details ?? {});
    if (acted.problems.length > 0) return record(result('failed', { hooks: before.records, problems: acted.problems, details }));
    const after = await runHooks(hooksFor(config, ctx.event, 'after', ctx.repo), ctx, scripts, details, options.progress);
    const warnings = after.records.filter((h) => h.outcome !== 'passed').map((h) => `after hook ${h.id} ${h.outcome === 'failed' ? `failed with exit code ${h.exitCode}` : 'could not run'}; nothing was undone`);
    const hooks = [...before.records, ...after.records];
    const finished = (await step.finish?.(ctx, config)) ?? { problems: [] };
    Object.assign(details, finished.details ?? {});
    if (finished.problems.length > 0) return record(result(finished.outcome ?? 'failed', { hooks, problems: [...finished.problems, ...warnings], details, failed: finished.failed ?? null }));
    return record(result('passed', { hooks, problems: warnings, details }));
  } finally {
    scripts.remove();
  }

  function record(outcome: EventOutcome): EventOutcome {
    const failed = outcome.failed ? { id: outcome.failed.id, onFailure: outcome.failed.onFailure } : null;
    const details = Object.keys(outcome.details).length > 0 ? { details: outcome.details } : {};
    const entry: EventRecord = { event: ctx.event, repo: ctx.repo, key, subject, outcome: outcome.outcome, at: new Date().toISOString(), hooks: outcome.hooks, problems: outcome.problems, failed, ...details };
    const fresh = readLedger(folder, ctx.repo) ?? ledger;
    writeLedger(folder, appendRun({ ...fresh, path: ctx.repoPath }, entry));
    return outcome;
  }
}
