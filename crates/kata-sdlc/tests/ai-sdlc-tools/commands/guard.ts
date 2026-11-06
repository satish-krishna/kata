// guard
// The PreToolUse hook of the build, review, fix and done skills, for Bash, Edit, Write, MultiEdit and NotebookEdit.
// It reads Claude Code's hook input (`tool_name`, `tool_input`) on standard input and refuses:
//
//   - editing the hook configuration and the records the gates read: `.ai-sdlc.json`, `intent/hooks/`,
//     `intent/<system>/hooks.json` and `intent/<system>/hooks/`, a change's `change.yml`, and the ledger and build
//     records in a git folder's `ai-sdlc/`, whether by an edit tool or by a shell command that writes to them;
//   - pushing, and the GitHub commands that change something (opening, merging or editing a pull request, an API
//     call that writes), because those happen only in the change.done event, after its gates;
//   - skipping a repository's own git hooks (`--no-verify`, `commit -n`, `core.hooksPath`).
//   - approving a check that already fails on the base, or retaking a baseline (`baseline approve|retake`), which
//     only the engineer does.
//
// To refuse it prints `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
// "permissionDecisionReason": ... } }`; otherwise it prints nothing. It exits 0 whatever happens. It is a speed bump
// for mistakes, not a sandbox: the base-branch rule is what makes editing a hook pointless.
import { readFileSync } from 'node:fs';
import { printJson, type Command } from '../common/command.ts';
import { EXIT } from '../common/types.ts';

const PROTECTED: { pattern: RegExp; what: string }[] = [
  { pattern: /(^|[\\/\s'"=])\.ai-sdlc\.json\b/, what: 'the marker, .ai-sdlc.json, which holds the hooks for every system' },
  { pattern: /(^|[\\/\s'"=])intent[\\/]hooks([\\/]|\b)/, what: 'the global hook scripts in intent/hooks/' },
  { pattern: /(^|[\\/\s'"=])intent[\\/][^\\/\s'"]+[\\/]hooks(\.json\b|[\\/])/, what: "a system's hooks (intent/<system>/hooks.json or hooks/)" },
  { pattern: /(^|[\\/\s'"=])intent[\\/][^\\/\s'"]+[\\/][^\\/\s'"]+[\\/]change\.yml\b/, what: "a change's record, change.yml, which only the ai-sdlc program writes" },
  { pattern: /[\\/]ai-sdlc[\\/][^\s'"]*\.json\b/, what: 'the ai-sdlc ledger and build records in the git folder' },
];

const WRITES = /(^|[^<>&0-9])>{1,2}(?!&)|\btee\b|\bsed\b[^|;&\n]*\s-i|\bperl\b[^|;&\n]*\s-i|\b(rm|mv|cp|truncate|touch|install|ln)\s|\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*(add|rm|mv|checkout|restore|commit|apply|stash)\b|writeFileSync|\bOut-File\b|\bSet-Content\b/;

/** git, then its own options (`-C <dir>`, `-c <key=value>`, `--flag`), then the subcommand. */
const GIT = String.raw`\bgit\s+(?:(?:-C|-c)\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*`;

const RULES: { pattern: RegExp; why: string }[] = [
  { pattern: new RegExp(GIT + String.raw`push\b`), why: 'Pushing happens only in the change.done event, after its checks: run the ai-sdlc done skill.' },
  { pattern: /\bgh\s+pr\s+(create|merge|edit|close|reopen|ready|review|comment)\b/, why: 'Pull requests are opened only by the change.done event, after its checks: run the ai-sdlc done skill.' },
  { pattern: /\bgh\s+api\b[^|;&\n]*(-X|--method)\s*['"]?(POST|PUT|PATCH|DELETE)\b/i, why: 'GitHub is changed only by the change.done event: run the ai-sdlc done skill.' },
  { pattern: new RegExp(String.raw`\bgit\b[^|;&\n]*\s--no-verify\b|` + GIT + String.raw`(?:commit|merge|am)\b(?:\s+-[a-zA-Z]+)*\s+-[a-zA-Z]*n\b|core\.hooksPath`), why: "A repository's own git hooks always run: commit without --no-verify, and fix what they report." },
  { pattern: /\bbaseline\s+(approve|retake)\b/, why: 'Only the engineer approves a check that already fails on the base, or retakes a baseline: show them the command and stop.' },
];

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Why a tool call is refused, or null when it may go ahead. */
export function refusal(tool: string, input: Record<string, unknown>): string | null {
  if (EDIT_TOOLS.includes(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? '');
    const hit = PROTECTED.find((p) => p.pattern.test(path));
    return hit ? `${path} is ${hit.what}. It is not edited during a build, a review or a fix; the setup skill changes hooks, through a pull request.` : null;
  }
  if (tool !== 'Bash') return null;
  const command = String(input.command ?? '');
  const rule = RULES.find((r) => r.pattern.test(command));
  if (rule) return rule.why;
  const named = PROTECTED.find((p) => p.pattern.test(command));
  if (named && WRITES.test(command)) return `This command would change ${named.what}. It is not changed during a build, a review or a fix; the setup skill changes hooks, through a pull request.`;
  return null;
}

export const guard: Command = {
  usage: 'guard  (a Claude Code PreToolUse hook: reads the hook input on standard input)',
  run() {
    try {
      const raw = JSON.parse(readFileSync(0, 'utf8')) as { tool_name?: string; tool_input?: Record<string, unknown> };
      const why = refusal(raw.tool_name ?? '', raw.tool_input ?? {});
      if (why) printJson({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `ai-sdlc: ${why}` } });
    } catch (e) {
      process.stderr.write(`ai-sdlc guard: ${(e as Error).message}\n`);
    }
    return EXIT.PASS;
  },
};
