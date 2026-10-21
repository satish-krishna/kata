/* The spec's requirements, read from the fenced `gherkin` block of a spec.md. The block is a Gherkin 6 feature whose
 * `Rule: R<n> — <title> (from: <sources>)` lines are the requirements and whose `Scenario:` and `Scenario Outline:`
 * `R<n>.<m> — <title>` blocks are their scenarios. */

export type Scenario = {
  id: string;
  title: string;
  /** A Scenario Outline: its steps carry `<placeholders>` filled from `examples`. */
  outline: boolean;
  /** Each step with its keyword (`Given`, `When`, `Then`, `And`, `But`), in order. */
  steps: string[];
  /** The Examples table, the header row first; null when the scenario has none. */
  examples: string[][] | null;
};

export type Requirement = { id: string; title: string; from: string; scenarios: Scenario[] };

const RULE = /^Rule:\s*(R\d+)\s*—\s*(.*?)\s*\(from:\s*(.*)\)\s*$/;
const RULE_PLAIN = /^Rule:\s*(R\d+)\s*—\s*(.*)$/;
const SCENARIO = /^Scenario(\s+Outline)?:\s*(R\d+\.\d+)\s*—\s*(.*)$/;
const STEP = /^(Given|When|Then|And|But)\s/;

function cellsOf(line: string): string[] {
  return line.split('|').slice(1, -1).map((c) => c.trim());
}

export function requirements(md: string): Requirement[] {
  const block = /```gherkin\r?\n([\s\S]*?)\r?\n\s*```/.exec(md);
  if (!block) return [];
  const out: Requirement[] = [];
  let scenario: Scenario | null = null;
  let inExamples = false;
  for (const raw of block[1].split(/\r?\n/)) {
    const line = raw.trim();
    const rule = RULE.exec(line);
    const plain = rule ? null : RULE_PLAIN.exec(line);
    if (rule || plain) {
      const m = rule ?? plain!;
      out.push({ id: m[1], title: m[2], from: rule ? m[3] : '', scenarios: [] });
      scenario = null;
      inExamples = false;
      continue;
    }
    const head = SCENARIO.exec(line);
    if (head) {
      scenario = { id: head[2], title: head[3], outline: head[1] !== undefined, steps: [], examples: null };
      inExamples = false;
      out.at(-1)?.scenarios.push(scenario);
      continue;
    }
    if (line.startsWith('Background:')) {
      scenario = null;
      continue;
    }
    if (!scenario) continue;
    if (line.startsWith('Examples:')) {
      scenario.examples = [];
      inExamples = true;
    } else if (inExamples && line.startsWith('|')) {
      scenario.examples!.push(cellsOf(line));
    } else if (!inExamples && STEP.test(line)) {
      scenario.steps.push(line);
    }
  }
  return out;
}

/** A step split into its keyword (`Given`, `When`, ...) and the rest of the line. */
export function splitStep(step: string): [string, string] {
  const space = step.indexOf(' ');
  return space < 0 ? [step, ''] : [step.slice(0, space), step.slice(space + 1)];
}
