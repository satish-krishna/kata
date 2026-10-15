// npm run firings [-- --since 2026-09-01] [--all]
// Reads the ordinary-session firing log and prints counts by hook and by rule.
//
// WHY THIS WAS REWRITTEN. The previous version reported one number -- total
// rows -- and that number is wrong in three separate ways, each of which
// inflates it. On the Hero Ops Console branch it printed "92 firing(s)". The
// defensible figure was 6.
//
//   -15  rows written on an earlier day. The log is append-only and never
//        rotated, so a total is a lifetime count presented as a session count.
//
//   -29  rows whose file path contains `.tmp-hook-probe`. Those are the gate's
//        OWN test fixtures, written by harness/gate/*.test.mjs during
//        `npm run test:harness` -- which every task runs as part of its
//        verification bar. Counting them means counting the constitution
//        unit-testing itself as drift it caught in real work.
//
//   -21  protect-enforcement denials. Those are the guard refusing a shell
//        command or an edit to a protected path. Real and worth counting, but
//        they are not drift in the application, and folding them into one
//        headline hides that most of them were the operator fumbling the
//        read-only allowlist.
//
// That leaves 39 gate firings on real source files -- and the sharpest cut is
// the last one. THIRTY-THREE of those 39 logged `rules: []` with `count: 1`,
// arriving in clusters of three or four at the same second on the same file.
// Four independent engines do not agree on exactly one violation each; they
// agree on a PARSE ERROR. `docsPointersFor` returns no pointer for those
// because a parse-error message carries `ruleId: null`.
//
// A parse rejection is not nothing -- the gate did stop a broken write. But it
// is a different claim from "the constitution caught house-style drift", since
// `ng build` would have caught a syntax error anyway. The rules that only the
// constitution can catch fired 6 times, and one of those was a false positive
// the gate itself manufactured.
//
// So this version reports the cut, not the total. A single headline number
// over this log will be over-claimed by roughly a factor of six.

import { readFileSync, existsSync } from 'node:fs';
import { DEFAULT_LOG_PATH } from '../../.claude/hooks/_hook-log.mjs';

const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
const includeFixtures = args.includes('--all');

if (!existsSync(DEFAULT_LOG_PATH)) {
  process.stdout.write(`No firings recorded yet (${DEFAULT_LOG_PATH} does not exist).\n`);
  process.exit(0);
}

const all = readFileSync(DEFAULT_LOG_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => !since || r.ts >= since);

// The gate's own test fixtures. Written by the harness suite, not by work.
const isFixture = (r) => String(r.file ?? '').includes('.tmp-hook-probe');
const isGuard = (r) => r.hook === 'protect-enforcement';
// A firing that named no rule. Overwhelmingly a parse error: exactly one
// message, no ruleId, several hooks reporting the same file in the same second.
const isUnattributed = (r) => !(r.rules ?? []).length;

const fixtures = all.filter(isFixture);
const rows = includeFixtures ? all : all.filter((r) => !isFixture(r));
const guard = rows.filter(isGuard);
const gate = rows.filter((r) => !isGuard(r));
const attributed = gate.filter((r) => !isUnattributed(r));
const unattributed = gate.filter(isUnattributed);

const byHook = {};
const byRule = {};
for (const r of gate) byHook[r.hook] = (byHook[r.hook] ?? 0) + 1;
for (const r of attributed) for (const rule of r.rules ?? []) byRule[rule] = (byRule[rule] ?? 0) + 1;

const table = (title, obj) => {
  process.stdout.write(`\n${title}\n`);
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { process.stdout.write('  (none)\n'); return; }
  for (const [k, n] of entries) process.stdout.write(`  ${String(n).padStart(5)}  ${k}\n`);
};

const line = (n, label) => process.stdout.write(`  ${String(n).padStart(5)}  ${label}\n`);

process.stdout.write(`Firing log${since ? ` since ${since}` : ''}: ${all.length} row(s) total\n\n`);
process.stdout.write('Excluded from the counts below\n');
line(fixtures.length, ".tmp-hook-probe rows (the gate's own test fixtures, written by test:harness)");

process.stdout.write('\nCounted\n');
line(guard.length, 'protect-enforcement denials (guard refusals, not application drift)');
line(gate.length, 'gate firings on real files');
line(unattributed.length, '  of which named NO rule (count:1, clustered -- almost certainly parse errors)');
line(attributed.length, '  of which named a rule -- the drift only the constitution catches');

table('Gate firings by hook', byHook);
table('Rules actually cited', byRule);

process.stdout.write(
  `\nThe defensible headline is ${attributed.length}, not ${all.length}. ` +
    `Verify any cited rule against the code before quoting it: this project has ` +
    `shipped at least one firing that was the gate rejecting correct markup.\n\n`,
);
