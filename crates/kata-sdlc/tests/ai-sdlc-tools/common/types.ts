// The output shape of `ai-sdlc.ts read --json`. Published as schema/read-result.schema.json;
// keep the two in step.

export type DocKind = 'spec' | 'plan' | 'build-log' | 'review';

/** The layout versions this program reads. */
export const READS_LAYOUTS: readonly number[] = [1, 2];

/** One thing wrong with a document: where it is and what it is. */
export type Problem = { file: string; line: number; message: string };

export type ParsedScenario = {
  id: string;
  title: string;
  outline: boolean;
  steps: string[];
  examples: string[][] | null;
  line: number;
};

export type ParsedRequirement = {
  id: string;
  title: string;
  from: string[];
  scenarios: ParsedScenario[];
  line: number;
};

export type ParsedSpec = { requirements: ParsedRequirement[] };

export type ParsedTask = {
  id: string;
  name: string;
  repo: string;
  depends_on: string[];
  uses: string[];
  files: string[];
  covers: string[];
  supports: string[];
  sections: { title: string; body: string }[];
  text: string;
  line: number;
};

export type ParsedSharedDecision = { question: string; owner: string; function: string };

export type ParsedPlan = { tasks: ParsedTask[]; shared_decisions: ParsedSharedDecision[] };

export type ParsedBuildEntry = {
  task: string;
  commits: string[];
  departure: string | null;
  line: number;
};

export type ParsedBuildLog = { repo: string; entries: ParsedBuildEntry[] };

export type ParsedFinding = {
  id: string;
  severity: 'high' | 'medium' | 'low';
  /** Absent in findings written before reviews recorded them. */
  repo?: string;
  concern?: 'spec' | 'bug' | 'convention';
  rule?: string;
  file: string;
  line: number;
  text: string;
};

export type ParsedReviewSection = {
  number: number;
  reviewed_at: string;
  commits: Record<string, string>;
  findings: ParsedFinding[];
};

export type ParsedReview = { reviews: ParsedReviewSection[] };

export type ReadResult =
  | { kind: 'spec'; layout: number; document: ParsedSpec; problems: Problem[] }
  | { kind: 'plan'; layout: number; document: ParsedPlan; problems: Problem[] }
  | { kind: 'build-log'; layout: number; document: ParsedBuildLog; problems: Problem[] }
  | { kind: 'review'; layout: number; document: ParsedReview; problems: Problem[] };

/** The program's exit codes. */
export const EXIT = { PASS: 0, PROBLEMS: 1, COULD_NOT_RUN: 2 } as const;

/** Thrown when the program cannot run on a file at all; the CLI maps it to exit 2. */
export class CouldNotRun extends Error {}
