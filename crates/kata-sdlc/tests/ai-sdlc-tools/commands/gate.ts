// gate
// The Stop hook of the build, review, fix and done skills. Claude Code runs it whenever the agent is about to end its
// turn, with the hook input (JSON with `cwd`) on standard input. It finds the build the session's repository is in
// from the record build.start left in the repository's git folder, never from anything the agent says, and asks
// the ledger:
//
//   - every task for the repository has a build log entry, but build.finish has not run at the current head: the
//     agent may not stop; it is told to run build.finish.
//   - build.finish failed at the current head on a hook that asks to be fixed (`onFailure: fix`), and the gate has
//     sent the agent back fewer than `gateRetries` times for that hook at that head: the agent may not stop; it is
//     given the event's problems (for a check that already failed on the base, only its new failures), the
//     hook's output, and told to fix the fault, commit, and run build.finish again.
//
// In every other case, a build still in progress (a stopped task, a question for the engineer), a passed check, a
// hook that asks to stop, a machine fault, or no build at all, the agent may stop. To block, it prints
// `{ "decision": "block", "reason": ... }`; once the retries are used up it prints a `systemMessage` saying so.
// It exits 0 whatever happens, and lets the agent stop when anything goes wrong, so it never traps a session.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { printJson, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';
import { unloggedTasks } from '../changes/progress.ts';
import { branchOf } from '../changes/record.ts';
import { readHookConfig } from '../events/config.ts';
import { latest, ledgerFolder, readLedger, writeLedger } from '../events/ledger.ts';
import { activeBuildFile, type ActiveBuild } from '../events/steps/build-start.ts';
import { commitOf, currentBranch, topLevel } from '../git/git.ts';

const TAIL_LINES = 60;

function readInput(): { cwd?: string } {
  try {
    const raw: unknown = JSON.parse(readFileSync(0, 'utf8'));
    return raw !== null && typeof raw === 'object' ? (raw as { cwd?: string }) : {};
  } catch {
    return {};
  }
}

/** What the gate decides: null lets the agent stop. */
export function decide(cwd: string): { block: string } | { note: string } | null {
  const top = topLevel(cwd);
  if (top === null) return null;
  const file = activeBuildFile(top);
  if (!existsSync(file)) return null;
  const active = JSON.parse(readFileSync(file, 'utf8')) as ActiveBuild;
  const folder = join(active.master, 'intent', active.system, active.change);
  if (!existsSync(folder) || currentBranch(top) !== branchOf(folder)) return null;
  const missing = unloggedTasks(folder, active.repo);
  if (missing === null || missing.length > 0) return null;
  const head = commitOf(top, 'HEAD');
  if (head === null) return null;
  const run = `node "${process.argv[1]}" run build.finish --json --change ${active.change} --repo ${active.repo} --master "${active.master}"`;
  const ledgers = ledgerFolder(active.master, active.system, active.change);
  const ledger = readLedger(ledgers, active.repo);
  const finish = latest(ledger, 'build.finish', head);
  if (finish === null) {
    return { block: `Every task for ${active.repo} has a build log entry, but its build.finish event has not run at ${head.slice(0, 7)}, so its checks have not run on this work. Run it and act on its outcome (references/workspace.md, section 11):\n${run}` };
  }
  if (finish.outcome !== 'failed' || finish.failed?.onFailure !== 'fix' || ledger === null) return null;
  const blocks = `${finish.failed.id}@${head}`;
  const count = ledger.gateBlocks[blocks] ?? 0;
  const { gateRetries } = readHookConfig(active.master, active.system);
  if (count >= gateRetries) {
    return { note: `ai-sdlc: hook ${finish.failed.id} still fails on ${active.repo} after ${count} attempts to fix it; the build stops here and the engineer decides what happens next.` };
  }
  writeLedger(ledgers, { ...ledger, gateBlocks: { ...ledger.gateBlocks, [blocks]: count + 1 } });
  const output = (finish.hooks.find((h) => h.id === finish.failed?.id)?.output ?? '').split('\n').slice(-TAIL_LINES).join('\n');
  // The event's problems say what to fix when the output alone would mislead: for a check that already failed on the
  // base, they name only the failures that are new, while its output lists the old ones too.
  const problems = finish.problems.length > 0 ? `\n\nWhat failed:\n${finish.problems.join('\n')}` : '';
  return {
    block: `The check ${finish.failed.id} failed on ${active.repo} at ${head.slice(0, 7)} (attempt ${count + 1} of ${gateRetries}). Find and fix the fault it reports in the repository, commit the fix following the commit rules, then run build.finish again:\n${run}${problems}\n\nThe end of its output:\n${output}`,
  };
}

export const gate: Command = {
  usage: 'gate   (a Claude Code Stop hook: reads the hook input on standard input)',
  run() {
    try {
      const input = readInput();
      const decision = decide(input.cwd ?? process.cwd());
      if (decision && 'block' in decision) printJson({ decision: 'block', reason: decision.block });
      else if (decision) printJson({ systemMessage: decision.note });
    } catch (e) {
      process.stderr.write(`ai-sdlc gate: ${(e as Error).message}\n`);
    }
    return EXIT.PASS;
  },
};
