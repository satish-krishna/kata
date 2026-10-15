#!/usr/bin/env node
// PostToolUse sealing gate. When the agent edits a template-bearing file under
// src/, run the sealing eslint config on it; on any violation, exit 2 and hand
// the agent a corrective message so it self-corrects. eslint-disable does not
// work (the config sets noInlineConfig), so there is no escape.
//
// This script is inert until registered as a PostToolUse hook. It is NOT wired
// into the committed .claude/settings.json, because doing so would make the gate
// always on and destroy the gate-off baseline. The run driver registers it (via
// `claude -p --settings harness/gate/gate-on.settings.json`) in the gate-on
// condition only. Present-but-unregistered in gate-off, registered in gate-on:
// that is the single variable the experiment moves.
//
// Fails closed: a payload it cannot parse exits 2 rather than waving an edit
// through, matching the repo's hook convention.

import { ESLint } from 'eslint';
import { logFiring } from './_hook-log.mjs';
import { docsPointersFor, formatDocPointerBlock } from './rule-docs.mjs';

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

const raw = await readStdin();

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.stderr.write('seal-templates: could not parse hook payload; failing closed.\n');
  process.exit(2);
}

const input = payload.tool_input ?? {};
const file = input.file_path ?? input.filePath ?? null;

// Not a file-editing tool, or no path: nothing to gate.
if (!file) process.exit(0);

const normalized = String(file).replaceAll('\\', '/');

// Only gate the application the agent builds: template-bearing files under src/.
if (!/\.(html|ts)$/.test(normalized)) process.exit(0);
if (!/(^|\/)src\//.test(normalized)) process.exit(0);

// Claude Code runs PostToolUse hooks from the project root, so process.cwd()
// locates eslint.config.mjs and resolves the edited path reliably.
const cwd = process.cwd();

let eslint;
let results;
try {
  eslint = new ESLint({ cwd });
  results = await eslint.lintFiles([file]);
} catch (err) {
  process.stderr.write(`seal-templates: eslint failed to run (${err?.message ?? err}).\n`);
  process.exit(2);
}

const errors = results
  .flatMap((r) => r.messages.map((m) => ({ ...m, filePath: r.filePath })))
  .filter((m) => m.severity === 2);

if (errors.length === 0) process.exit(0);

const lines = errors.map((m) => `  ${normalized}:${m.line}:${m.column}  ${m.message}`);

// A missing or unreadable doc must never turn this into a soft failure: on any
// error, drop the pointer block and still block the edit with the rest of the
// corrective message.
let pointers = [];
try {
  pointers = docsPointersFor(eslint, results);
} catch {
  pointers = [];
}
const docLines = pointers.map((p) => `  ${p.ruleId}  ->  ${p.url}`);

logFiring('seal-templates', normalized, lines, pointers.map((p) => p.ruleId));

process.stderr.write(
  `Sealing gate blocked this edit: ${errors.length} violation(s).\n` +
    `${lines.join('\n')}\n` +
    formatDocPointerBlock(docLines) +
    `The primitive vocabulary is sealed (see harness/sealing-spec.md). Compose from spartan ` +
    `primitives, and change a primitive's look with its variant/size inputs or its Helm file in ` +
    `libs/ui, never a class at the call site. Icons are <ng-icon>, never inline SVG. Every hlm* ` +
    `name must match the installed vocabulary in that exact form (attribute vs. element), and an ` +
    `overlay needs its title part. The documented shape:\n` +
    `  Good: <button hlmBtn variant="ghost">Save</button>   <input hlmInput />   ` +
    `<button hlmSidebarMenuButton>Roster</button>   <select> -> <hlm-select>   ` +
    `<ng-icon name="lucideTrash2" />   <hlm-avatar>...</hlm-avatar>   ` +
    `<hlm-dialog-content><h2 hlmDialogTitle>Retire hero?</h2>...</hlm-dialog-content>\n` +
    `  Bad:  <button>Save</button>   <button hlmBtn class="bg-blue-600">   <div style="padding:8px">   ` +
    `<div hlmAvatar>...</div> (hlmAvatar is the element <hlm-avatar>, not an attribute)   ` +
    `<hlm-dialog-content><h2 class="font-semibold">Retire hero?</h2>...</hlm-dialog-content> ` +
    `(no hlmDialogTitle)   ` +
    `<select>   <svg viewBox="0 0 24 24">...</svg>\n` +
    `Fix the above before continuing. eslint-disable has no effect here.\n`,
);
process.exit(2);
