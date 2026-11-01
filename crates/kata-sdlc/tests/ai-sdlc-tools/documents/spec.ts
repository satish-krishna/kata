// Reads a spec, `spec.md`: its Gherkin block, parsed into requirements and scenarios. Layout in GRAMMAR.md.
import { AstBuilder, GherkinClassicTokenMatcher, IdGenerator, Parser, type messages } from '../vendor/gherkin.mjs';
import { layoutOf, parseFrontMatter, refuseNewerLayout } from './front-matter.ts';
import type { ParsedRequirement, ParsedScenario, Problem, ReadResult } from '../common/types.ts';

/** The text of a fenced block and the number of document lines before its first line. */
type Block = { text: string; offset: number };

const LINE_END = /\r\n|\r|\n/;

/** The first fenced `gherkin` block opened exactly as a three-backtick fence (layout 1). */
function strictGherkinBlock(text: string): Block | null {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => /^\s*```gherkin\s*$/.test(l));
  if (open < 0) return null;
  let close = lines.findIndex((l, i) => i > open && /^\s*```\s*$/.test(l));
  if (close < 0) close = lines.length;
  return { text: lines.slice(open + 1, close).join('\n'), offset: open + 1 };
}

/** The first backtick or tilde fence whose info string is `gherkin` in any case (layout 2). It closes on a bare fence of the same character that is at least as long. */
function looseGherkinBlock(text: string): Block | null {
  const lines = text.split(LINE_END);
  for (let open = 0; open < lines.length; open++) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[open] as string);
    if (!m) continue;
    const fence = m[1] as string;
    const info = (m[2] as string).trim();
    if (fence.startsWith('`') && info.includes('`')) continue;
    if (info.toLowerCase() !== 'gherkin') continue;
    const closer = new RegExp(`^\\s*${fence.startsWith('`') ? '`' : '~'}{${fence.length},}\\s*$`);
    let close = lines.findIndex((l, i) => i > open && closer.test(l));
    if (close < 0) close = lines.length;
    return { text: lines.slice(open + 1, close).join('\n'), offset: open + 1 };
  }
  return null;
}

// Layout 1, as Kata's app/src/app/lib/spec-doc.ts reads it, with any of - (hyphen), en dash or em dash as the separator.
const SEP = '[-\\u2013\\u2014]';
const RULE = new RegExp(`^Rule:\\s*(R\\d+)\\s*${SEP}\\s*(.*?)\\s*\\(from:\\s*(.*)\\)\\s*$`);
const RULE_PLAIN = new RegExp(`^Rule:\\s*(R\\d+)\\s*${SEP}\\s*(.*)$`);
const SCENARIO = new RegExp(`^Scenario(\\s+Outline)?:\\s*(R\\d+\\.\\d+)\\s*${SEP}\\s*(.*)$`);
const STEP = /^(Given|When|Then|And|But)\s/;

function cellsOf(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

function readLayout1(block: Block): ParsedRequirement[] {
  const out: ParsedRequirement[] = [];
  let scenario: ParsedScenario | null = null;
  let inExamples = false;
  block.text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const at = block.offset + i + 1;
    const rule = RULE.exec(line);
    const plain = rule ? null : RULE_PLAIN.exec(line);
    if (rule || plain) {
      const m = (rule ?? plain) as RegExpExecArray;
      const from = rule ? (m[3] as string).split(/\s*,\s*/).filter((s) => s !== '') : [];
      out.push({ id: m[1] as string, title: m[2] as string, from, scenarios: [], line: at });
      scenario = null;
      inExamples = false;
      return;
    }
    const head = SCENARIO.exec(line);
    if (head) {
      scenario = {
        id: head[2] as string,
        title: head[3] as string,
        outline: head[1] !== undefined,
        steps: [],
        examples: null,
        line: at,
      };
      inExamples = false;
      out.at(-1)?.scenarios.push(scenario);
      return;
    }
    if (line.startsWith('Background:')) {
      scenario = null;
      return;
    }
    if (!scenario) return;
    if (line.startsWith('Examples:')) {
      scenario.examples = [];
      inExamples = true;
    } else if (inExamples && line.startsWith('|')) {
      scenario.examples?.push(cellsOf(line));
    } else if (!inExamples && STEP.test(line)) {
      scenario.steps.push(line);
    }
  });
  // Rules without a single scenario are not a requirements list.
  return out.some((r) => r.scenarios.length > 0) ? out : [];
}

const RULE_TAG = /^@R\d+$/;
const SCENARIO_TAG = /^@R(\d+)\.\d+$/;
const FROM_TAG = /^@from:(.+)$/;

function placeholdersOf(steps: readonly messages.Step[]): string[] {
  const found: string[] = [];
  for (const s of steps) {
    for (const m of s.text.matchAll(/<([^<>\s][^<>]*)>/g)) {
      if (!found.includes(m[1] as string)) found.push(m[1] as string);
    }
  }
  return found;
}

/** The requirements read from a layout 2 block, and the IDs of tags the reader reported another way. */
type Layout2 = { requirements: ParsedRequirement[]; reported: Set<string>; parsed: boolean };

function readLayout2(block: Block, file: string, problems: Problem[]): Layout2 {
  const at = (line: number): number => block.offset + line;
  const problem = (line: number, message: string): void => {
    problems.push({ file, line, message });
  };
  let feature: messages.Feature | undefined;
  try {
    const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher());
    feature = parser.parse(block.text).feature;
  } catch (e) {
    const errors = (e as { errors?: { message: string }[] }).errors ?? [e as Error];
    for (const err of errors) {
      const m = /^\((\d+):\d+\):\s*([\s\S]*)$/.exec(err.message);
      problem(m ? at(Number(m[1])) : at(1), `gherkin: ${m ? (m[2] as string) : err.message}`);
    }
    return { requirements: [], reported: new Set(), parsed: false };
  }
  const out: ParsedRequirement[] = [];
  const reported = new Set<string>();
  const seenRequirements = new Set<string>();
  const seenScenarios = new Set<string>();
  for (const child of feature?.children ?? []) {
    const rule = child.rule;
    if (!rule) {
      // A tagged scenario outside any Rule is no requirement's scenario, so it would be dropped silently.
      const sc = child.scenario;
      const tags = sc?.tags.map((t) => t.name).filter((n) => RULE_TAG.test(n) || SCENARIO_TAG.test(n)) ?? [];
      if (sc && tags.length > 0) {
        for (const n of tags) reported.add(n.slice(1));
        const named = tags.find((n) => SCENARIO_TAG.test(n)) ?? (tags[0] as string);
        problem(at(sc.location.line), `scenario ${named.slice(1)} sits under no requirement`);
      }
      continue;
    }
    const names = rule.tags.map((t) => t.name);
    const ids = names.filter((n) => RULE_TAG.test(n)).map((n) => n.slice(1));
    const id = ids[0] ?? '';
    const req: ParsedRequirement = {
      id,
      title: rule.name,
      from: names.flatMap((n) => FROM_TAG.exec(n)?.[1] ?? []),
      scenarios: [],
      line: at(rule.location.line),
    };
    out.push(req);
    if (ids.length === 0) {
      problem(req.line, 'requirement has no ID');
    } else {
      if (ids.length > 1) problem(req.line, `requirement carries more than one ID: ${ids.join(', ')}`);
      if (seenRequirements.has(id)) problem(req.line, `requirement ID ${id} is used twice`);
      seenRequirements.add(id);
    }
    for (const sub of rule.children) {
      const sc = sub.scenario;
      if (!sc) continue;
      const scIds = sc.tags.map((t) => t.name).filter((n) => SCENARIO_TAG.test(n)).map((n) => n.slice(1));
      const scId = scIds[0] ?? '';
      const first = sc.examples[0];
      const examples = first?.tableHeader
        ? [
            first.tableHeader.cells.map((c) => c.value),
            ...sc.examples.flatMap((ex) => ex.tableBody.map((r) => r.cells.map((c) => c.value))),
          ]
        : null;
      const parsed: ParsedScenario = {
        id: scId,
        title: sc.name,
        outline: sc.keyword.trim() === 'Scenario Outline',
        steps: sc.steps.map((s) => `${s.keyword.trim()} ${s.text}`),
        examples,
        line: at(sc.location.line),
      };
      req.scenarios.push(parsed);
      if (scIds.length === 0) {
        problem(parsed.line, 'scenario has no ID');
        continue;
      }
      if (scIds.length > 1) problem(parsed.line, `scenario carries more than one ID: ${scIds.join(', ')}`);
      const owner = SCENARIO_TAG.exec(`@${scId}`)?.[1];
      if (ids.length > 0 && `R${owner}` !== id) problem(parsed.line, `scenario ${scId} sits under requirement ${id}`);
      if (seenScenarios.has(scId)) problem(parsed.line, `scenario ID ${scId} is used twice`);
      seenScenarios.add(scId);
      if (parsed.outline) {
        const listed = examples?.[0] ?? [];
        for (const p of placeholdersOf(sc.steps)) {
          if (!listed.includes(p)) problem(parsed.line, `scenario ${scId} uses <${p}> but its examples lack it`);
        }
      }
    }
    if (req.scenarios.length === 0 && ids.length > 0) problem(req.line, `requirement ${id} has no scenario`);
  }
  return { requirements: out, reported, parsed: true };
}

const TAG_IN_LINE = /(?<![\w@])@R(\d+(?:\.\d+)?)(?!\w)/g;

/** Reports every `@R<n>` or `@R<n>.<m>` on any raw line whose ID the reader did not read from the requirements block. */
function reportUnreadTags(text: string, file: string, read: Layout2, problems: Problem[]): void {
  const known = new Set<string>(read.reported);
  for (const r of read.requirements) {
    known.add(r.id);
    for (const s of r.scenarios) known.add(s.id);
  }
  text.split(LINE_END).forEach((line, i) => {
    const seen = new Set<string>();
    for (const m of line.matchAll(TAG_IN_LINE)) {
      const id = `R${m[1]}`;
      if (known.has(id) || seen.has(id)) continue;
      seen.add(id);
      const what = id.includes('.') ? 'scenario' : 'requirement';
      problems.push({ file, line: i + 1, message: `${what} ${id} is not part of the requirements the reader found` });
    }
  });
}

/** Reads a spec. Layout 2 holds IDs and sources in Gherkin tags; layout 1 holds them in the titles. */
export function readSpec(text: string, file: string): ReadResult {
  const { data } = parseFrontMatter(text, file);
  const layout = layoutOf(data);
  refuseNewerLayout(layout, file);
  const problems: Problem[] = [];
  const block = layout >= 2 ? looseGherkinBlock(text) : strictGherkinBlock(text);
  let requirements: ParsedRequirement[] = [];
  if (!block && layout >= 2) problems.push({ file, line: 1, message: 'no gherkin requirements block found' });
  if (block) {
    // A document with no layout field is layout 1; one written with tags and no layout field lacks its version.
    const missingVersion = data['layout'] === undefined && /^\s*@R\d/m.test(block.text);
    if (missingVersion) problems.push({ file, line: 1, message: 'no layout version' });
    if (layout >= 2 || missingVersion) {
      const read = readLayout2(block, file, problems);
      requirements = read.requirements;
      if (read.parsed) reportUnreadTags(text, file, read, problems);
    } else {
      requirements = readLayout1(block);
    }
  }
  return { kind: 'spec', layout, document: { requirements }, problems };
}
