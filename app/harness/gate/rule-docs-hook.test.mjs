import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import angular from 'angular-eslint';
import seal from './index.mjs';
import { docsPointersFor, agentGuidanceFor } from '../../.claude/hooks/rule-docs.mjs';
import {
  FORMS_RULE_IDS,
  MVVM_RULE_IDS,
  ICON_RULE_IDS,
  SUBMIT_RULE_IDS,
  SHAPE_FORMS_GUIDANCE,
  MVVM_GUIDANCE,
  ICON_GUIDANCE,
  SUBMIT_GUIDANCE,
} from '../../.claude/hooks/shape-guidance.mjs';
import {
  SHAPE_FORMS_GUIDANCE as PINNED_SHAPE_FORMS_GUIDANCE,
  MVVM_GUIDANCE as PINNED_MVVM_GUIDANCE,
  ICON_GUIDANCE as PINNED_ICON_GUIDANCE,
  SUBMIT_GUIDANCE as PINNED_SUBMIT_GUIDANCE,
} from './pinned-shape-guidance.mjs';

// shape-guidance.mjs and rule-docs.mjs are plain ESM helpers with no shebang,
// so importing them directly (as this file does) is safe; every actual hook
// entrypoint under .claude/hooks/ (check-component-shape.mjs,
// check-component-shape-guided.mjs, check-freeloader.mjs, check-layout.mjs,
// protect-enforcement.mjs, seal-templates.mjs) starts with
// `#!/usr/bin/env node` and must always be exercised via spawnSync instead,
// never imported, because that shebang silently makes vitest load zero tests
// from the file while `node --check` still passes on it - see the
// seal-templates subprocess test at the bottom of this file for the pattern
// to copy.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = [{
  files: ['**/*.html'],
  plugins: { seal },
  languageOptions: { parser: angular.templateParser },
  linterOptions: { noInlineConfig: true },
  rules: { 'seal/no-raw-control': 'error', 'seal/no-style-attribute': 'error' },
}];

// An independent reading of a doc's '## Agent guidance' section, built by
// line-splitting rather than the regex agentGuidanceFor itself uses. Used to
// prove the extraction is correct, not merely that it matches a substring
// that also happens to appear in the doc's "Accepted form" example.
function independentAgentGuidance(mdPath) {
  const raw = readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const start = lines.indexOf('## Agent guidance');
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) break;
    body.push(lines[i]);
  }
  while (body.length && body[0] === '') body.shift();
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}

describe('the hooks can reach a rule doc from a lint result', () => {
  it('recovers a docs pointer that no message field carries', async () => {
    const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: true, overrideConfig: config });
    const results = await eslint.lintFiles([
      join(repoRoot, 'harness', 'counter', 'fixtures', 'dirty.html'),
    ]);

    // The premise: the message itself has no url.
    expect(results[0].messages[0]).not.toHaveProperty('url');

    const pointers = docsPointersFor(eslint, results);
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.map((p) => p.url)).toContain('harness/rules/no-raw-control.md');
  });

  it('reads the agent guidance out of the markdown, matching an independent extraction', async () => {
    const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: true, overrideConfig: config });
    const results = await eslint.lintFiles([
      join(repoRoot, 'harness', 'counter', 'fixtures', 'dirty.html'),
    ]);
    const pointers = docsPointersFor(eslint, results);
    const blocks = agentGuidanceFor(pointers);
    expect(blocks.length).toBeGreaterThan(0);

    // Independent, line-split extraction of the same docs, deduplicated the
    // same way (by body), must equal agentGuidanceFor's own output exactly -
    // not merely "contains a word that also appears in the accepted form".
    const seen = new Set();
    const expected = [];
    for (const p of pointers) {
      const body = independentAgentGuidance(join(repoRoot, p.url));
      if (!body || seen.has(body)) continue;
      seen.add(body);
      expected.push(body);
    }
    expect(blocks).toEqual(expected);
    expect(new Set(blocks).size).toBe(blocks.length);
  });

  // Each of the four *_RULE_IDS sets in shape-guidance.mjs names several rules
  // whose docs currently carry an identical '## Agent guidance' body, so
  // agentGuidanceFor's dedup-by-body collapses every set down to a single
  // block. shape-guidance.mjs's guidanceFor() relies on that collapse: it
  // joins whatever blocks come back, and joining a one-element array is
  // byte-identical to taking element [0]. If a doc in any set is ever edited
  // independently, the collapse below stops holding for that set and this
  // assertion is what catches it - not a passing test elsewhere.
  const toPointers = (ruleIds) =>
    [...ruleIds].map((ruleId) => ({ ruleId, url: `harness/rules/${ruleId.split('/').pop()}.md` }));

  it('collapses the four forms rules that share one identical worked example into a single block', () => {
    const pointers = toPointers(FORMS_RULE_IDS);
    expect(pointers.length).toBe(4);
    expect(agentGuidanceFor(pointers).length).toBe(1);
  });

  it('collapses the four MVVM rules that share one identical worked example into a single block', () => {
    const pointers = toPointers(MVVM_RULE_IDS);
    expect(pointers.length).toBe(4);
    expect(agentGuidanceFor(pointers).length).toBe(1);
  });

  it('collapses the two icon rules that share one identical worked example into a single block', () => {
    const pointers = toPointers(ICON_RULE_IDS);
    expect(pointers.length).toBe(2);
    expect(agentGuidanceFor(pointers).length).toBe(1);
  });

  it('has exactly one rule in SUBMIT_RULE_IDS, so its "collapse" is trivial by construction', () => {
    // Documented for symmetry with the other three sets: there is nothing to
    // collapse here today, but if a second submit-shaped rule is ever added
    // to this set, this test starts exercising the same collapse the other
    // three already check, rather than silently staying a single-block case.
    const pointers = toPointers(SUBMIT_RULE_IDS);
    expect(pointers.length).toBe(1);
    expect(agentGuidanceFor(pointers).length).toBe(1);
  });

  it('tolerates CRLF line endings in the doc file (a fresh checkout under core.autocrlf)', () => {
    const lfBlocks = agentGuidanceFor([{ ruleId: 'x', url: 'harness/rules/no-reactive-form.md' }]);
    expect(lfBlocks.length).toBe(1);
    expect(lfBlocks[0].length).toBeGreaterThan(0);

    const lfContent = readFileSync(join(repoRoot, 'harness', 'rules', 'no-reactive-form.md'), 'utf8');
    const crlfContent = lfContent.replace(/\n/g, '\r\n');
    const tmpRelUrl = 'harness/gate/.tmp-crlf-doc.md';
    const tmpAbsPath = join(repoRoot, tmpRelUrl);
    writeFileSync(tmpAbsPath, crlfContent);
    try {
      const crlfBlocks = agentGuidanceFor([{ ruleId: 'x', url: tmpRelUrl }]);
      expect(crlfBlocks.length).toBe(1);
      expect(crlfBlocks[0]).toBe(lfBlocks[0]);
    } finally {
      rmSync(tmpAbsPath, { force: true });
    }
  });
});

describe('shape-guidance.mjs generates its four constants from the docs', () => {
  it('SHAPE_FORMS_GUIDANCE is non-empty and names the house forms pattern', () => {
    expect(SHAPE_FORMS_GUIDANCE.length).toBeGreaterThan(0);
    expect(SHAPE_FORMS_GUIDANCE).toMatch(/validateStandardSchema/);
  });

  it('MVVM_GUIDANCE is non-empty and names the component-scoped ViewModel pattern', () => {
    expect(MVVM_GUIDANCE.length).toBeGreaterThan(0);
    expect(MVVM_GUIDANCE).toMatch(/HeroDetailViewModel/);
  });

  it('ICON_GUIDANCE is non-empty and names provideIcons', () => {
    expect(ICON_GUIDANCE.length).toBeGreaterThan(0);
    expect(ICON_GUIDANCE).toMatch(/provideIcons/);
  });

  it('SUBMIT_GUIDANCE is non-empty and names the one submit path', () => {
    expect(SUBMIT_GUIDANCE.length).toBeGreaterThan(0);
    expect(SUBMIT_GUIDANCE).toMatch(/submit\(this\.form/);
  });
});

describe('the four guidance constants match the pinned experiment stimulus, byte for byte', () => {
  // The regex checks above pass through any rewording, rewrapping, or
  // re-fencing of harness/rules/*.md's '## Agent guidance' sections.
  // check-component-shape-guided.mjs (the frozen arm of a published A/B
  // experiment) reads SHAPE_FORMS_GUIDANCE at module load, so a change to
  // that text is a change to the stimulus behind a measured result, not a
  // cosmetic doc edit. These four assertions are full-string equality
  // against harness/gate/pinned-shape-guidance.mjs, a committed snapshot of
  // the values as they stood before this branch made the constants derived
  // from markdown. A failure here means a rule doc's '## Agent guidance'
  // body changed - see pinned-shape-guidance.mjs's header for what to do
  // about that (never "regenerate the fixture" without reading it first).
  it('SHAPE_FORMS_GUIDANCE is byte-identical to the pinned value', () => {
    expect(SHAPE_FORMS_GUIDANCE).toBe(PINNED_SHAPE_FORMS_GUIDANCE);
  });

  it('MVVM_GUIDANCE is byte-identical to the pinned value', () => {
    expect(MVVM_GUIDANCE).toBe(PINNED_MVVM_GUIDANCE);
  });

  it('ICON_GUIDANCE is byte-identical to the pinned value', () => {
    expect(ICON_GUIDANCE).toBe(PINNED_ICON_GUIDANCE);
  });

  it('SUBMIT_GUIDANCE is byte-identical to the pinned value', () => {
    expect(SUBMIT_GUIDANCE).toBe(PINNED_SUBMIT_GUIDANCE);
  });
});

describe('a hook actually writes the docs pointer to stderr, not just computes it', () => {
  it('seal-templates prints a harness/rules/*.md pointer on a real violation', () => {
    // A real subprocess run of the hook itself: a hook that computed docLines
    // and forgot to write them would pass every unit test above and still
    // fail here. The probe lives under harness/gate/, inside an ad hoc "src"
    // directory that only exists to satisfy the hook's own src/-path guard -
    // never under the project's actual src/ - and is removed in `finally`
    // regardless of test outcome.
    const probeDir = join(repoRoot, 'harness', 'gate', '.tmp-hook-probe', 'src');
    const probeRelPath = 'harness/gate/.tmp-hook-probe/src/dirty.html';
    mkdirSync(probeDir, { recursive: true });
    try {
      cpSync(join(repoRoot, 'harness', 'counter', 'fixtures', 'dirty.html'), join(probeDir, 'dirty.html'));
      const result = spawnSync(
        process.execPath,
        [join(repoRoot, '.claude', 'hooks', 'seal-templates.mjs')],
        {
          cwd: repoRoot,
          input: JSON.stringify({ tool_input: { file_path: probeRelPath } }),
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/harness\/rules\/no-raw-control\.md/);
    } finally {
      rmSync(join(repoRoot, 'harness', 'gate', '.tmp-hook-probe'), { recursive: true, force: true });
    }
  });
});
