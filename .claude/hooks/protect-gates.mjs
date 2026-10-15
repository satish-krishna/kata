// PreToolUse guard: deny agent edits to the few files whose weakening nothing
// else would catch. Scope follows the guard-only-what-has-no-other-backstop
// pattern: ask of each candidate "if someone weakened this, what would go red?"
//
// Guarded (nothing goes red if they are loosened):
//   - app/eslint.config.mjs, app/stylelint.config.mjs: which rules run at all.
//   - app/harness/gate/rules/primitive-vocabulary.ts and no-raw-control.ts: the
//     sealed primitive vocabulary and accepted button attributes; adding a name
//     silently widens what the gate allows.
//   - this guard and its test: changing what is protected is a policy change,
//     and it goes through the owner, not an agent editing its own leash.
// Not guarded, on purpose:
//   - the rest of harness/ (rule logic): `npm run test:harness` runs in CI and
//     turns red if a rule is gutted, and guarding it would block rule bugfixes.
//   - package.json, tsconfig*.json, .mcp.json, .claude/settings.json: the diff
//     and CI show any change; guarding them taxes every legitimate edit.
// Limit, stated: deletion is not a Write/Edit, so `rm` passes this guard. A
// deleted lint config fails `npm run lint` / stylelint in CI from a clean checkout.
//
// Exact resolved paths, never substring matches, and never command text.
// Fails closed: an unparseable payload, or a write tool without a path, is denied.
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARDED = [
  'app/eslint.config.mjs',
  'app/stylelint.config.mjs',
  'app/harness/gate/rules/primitive-vocabulary.ts',
  'app/harness/gate/rules/no-raw-control.ts',
  '.claude/hooks/protect-gates.mjs',
  '.claude/hooks/protect-gates.test.mjs',
];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const norm = (p) => {
  const abs = resolve(p).split(sep).join('/');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
};
const guarded = new Set(GUARDED.map((rel) => norm(resolve(REPO, rel))));

function deny(reason) {
  process.stderr.write(`protect-gates: ${reason}\n`);
  process.exit(2);
}

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  deny('could not parse the hook payload, so the edit is denied (fail closed).');
}

if (!WRITE_TOOLS.has(payload?.tool_name)) process.exit(0);

const target = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
if (typeof target !== 'string' || target === '') {
  deny(`${payload.tool_name} carried no file path, so the edit is denied (fail closed).`);
}

if (guarded.has(norm(target))) {
  deny(
    `${target} is enforcement configuration and is not editable by an agent.\n` +
      'If a rule is blocking you, change the code so it passes, not the rule. ' +
      'If you believe the rule itself is wrong, say so in your final response and stop; the owner edits this file.',
  );
}
process.exit(0);
