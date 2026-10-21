import type { ParsedRequirement } from '@bindings/ParsedRequirement';
import type { ParsedTask } from '@bindings/ParsedTask';
import type { ReadResult } from '@bindings/ReadResult';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { TaskStatus } from '@bindings/TaskStatus';

/* A change whose documents the format program has already read: the numbers of the spec's R6.1 scenario (20
 * requirements, 76 scenarios, 30 tasks, 30 build log entries, 6 review findings). Parsed documents, never text. */

export const NUMBERS = { requirements: 20, scenarios: 76, tasks: 30, buildRecords: 30, findings: 6 } as const;

const REPOS = ['claims-core', 'customer-portal'];

/** 16 requirements of 4 scenarios and 4 of 3: 76 scenarios in 20 requirements. */
function requirements(): ParsedRequirement[] {
  return Array.from({ length: NUMBERS.requirements }, (_, i) => {
    const n = i + 1;
    const count = n <= 16 ? 4 : 3;
    return {
      id: `R${n}`,
      title: `Requirement ${n}`,
      from: [`Proposed outcome ${n}`],
      line: 10 + i * 20,
      scenarios: Array.from({ length: count }, (_, j) => ({
        id: `R${n}.${j + 1}`,
        title: `Scenario ${n}.${j + 1}`,
        outline: false,
        steps: [`Given a state ${n}.${j + 1}`, 'When it happens', 'Then it is shown'],
        examples: null,
        line: 12 + i * 20 + j * 4,
      })),
    };
  });
}

export function parsedSpec(): ReadResult {
  return { kind: 'spec', layout: 2, document: { requirements: requirements() }, problems: [] };
}

function tasks(): ParsedTask[] {
  return Array.from({ length: NUMBERS.tasks }, (_, i) => {
    const n = i + 1;
    return {
      id: `T${n}`,
      name: `Task ${n}`,
      repo: REPOS[i % 2],
      depends_on: n === 1 ? [] : [`T${n - 1}`],
      uses: [],
      files: [],
      covers: [`R${Math.min(n, NUMBERS.requirements)}.1`],
      supports: [],
      sections: [
        { title: 'Change', body: `Change for task ${n}.` },
        { title: 'Tests', body: `Tests for task ${n}.` },
      ],
      text: `### T${n}: Task ${n} (\`${REPOS[i % 2]}\`)`,
      line: 20 + i * 8,
    };
  });
}

export function parsedPlan(): ReadResult {
  return { kind: 'plan', layout: 2, document: { tasks: tasks(), shared_decisions: [] }, problems: [] };
}

/** The same 30 tasks as the build status reads them, every one with its build log entry. */
export function builtTasks(): TaskStatus[] {
  return tasks().map((t) => ({
    id: t.id,
    name: t.name,
    repo: t.repo,
    dependsOn: t.depends_on,
    text: t.text,
    row: { task: t.id, repo: t.repo, commits: [`${t.id.toLowerCase()}c0ffee`], departure: null },
  }));
}

/** A review document with one review of 6 findings against the given repository heads. */
export function reviewOfSix(commits: Record<string, string>): ReviewRecord {
  return {
    layout: 2,
    problems: [],
    master_moved: [],
    reviews: [
      {
        number: 1,
        reviewed_at: '2026-10-22',
        commits,
        findings: Array.from({ length: NUMBERS.findings }, (_, i) => ({
          id: `F${i + 1}`,
          severity: i < 2 ? ('high' as const) : i < 4 ? ('medium' as const) : ('low' as const),
          file: `src/file${i + 1}.ts`,
          line: i + 1,
          text: `Finding ${i + 1}.`,
        })),
      },
    ],
  };
}
