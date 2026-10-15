import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where an ordinary session records firings. Git-ignored; telemetry, not evidence. */
export const DEFAULT_LOG_PATH = join(ROOT, '.claude', 'hook-firings.jsonl');

/**
 * Two records, deliberately, because the two readers want different things.
 *
 * HOOK_LOG set (the run driver, per trial): the VERBOSE record, with the full
 * message text. Every file under experiments/ is in this shape and
 * harness/driver/analyze-streaks.mjs parses it. Changing it would silently
 * invalidate the batching analysis and every future re-run of it, so it does
 * not change.
 *
 * HOOK_LOG unset (an ordinary interactive session): the LEAN record - which
 * hook, which file, how many, which rules. That answers "how often is the
 * machinery catching drift, and what drift" and nothing else, which is the
 * whole brief. The message text is deliberately absent: a permanent log
 * running on every session for months would otherwise accumulate source
 * fragments nobody reads.
 *
 * Logging never throws into the gate. A gate that dies because its telemetry
 * could not write is worse than a gate with no telemetry.
 */
export function logFiring(hook, file, messages, rules = [], pathOverride = null) {
  const runPath = process.env.HOOK_LOG;
  const ts = new Date().toISOString();
  const path = pathOverride ?? runPath ?? DEFAULT_LOG_PATH;
  const record =
    runPath && !pathOverride
      ? { hook, file, count: messages.length, messages, ts }
      : { hook, file, count: messages.length, rules: [...new Set(rules)], ts };
  try {
    appendFileSync(path, JSON.stringify(record) + '\n');
  } catch {
    // Never let logging break a gate.
  }
}
