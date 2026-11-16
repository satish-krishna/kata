// Reads a review document, `build/review.md`: one section per review, with its findings. Layout in GRAMMAR.md.
import Ajv from '../vendor/ajv.mjs';
import findingSchema from '../schema/finding.schema.json' with { type: 'json' };
import reviewHeaderSchema from '../schema/review-header.schema.json' with { type: 'json' };
import { keyLine, nextHeading, recordPrefix, reportUnread, splitDoc, yamlBlock, type Doc } from './doc.ts';
import { layoutOf, parseFrontMatter, refuseNewerLayout } from './front-matter.ts';
import { checkFields, isMissing, parseFields } from './records.ts';
import type { ParsedFinding, ParsedReviewSection, Problem, ReadResult } from '../common/types.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateHeader = ajv.compile(reviewHeaderSchema);
const validateFinding = ajv.compile(findingSchema);

const REVIEW_HEADING = /^## Review (\d+)\s*$/;
const FINDING_HEADING = /^### (F\d+)\s*$/;

function readFinding(
  doc: Doc,
  index: number,
  id: string,
  end: number,
  file: string,
  problems: Problem[],
  claimed: Set<number>,
  section: ParsedReviewSection,
): ParsedFinding | null {
  const line = index + 1;
  const who = `finding ${id}`;
  const block = yamlBlock(doc, index + 1, end);
  if (!block) {
    problems.push({ file, line, message: `${who} has no fields block` });
    return null;
  }
  claimed.add(block.open);
  const fields = parseFields(block, who, file, problems);
  if (!fields) return null;
  const f = fields.values;
  // A missing severity is reported in the finding's own words, below.
  const ok = checkFields(validateFinding, f, `${who} fields`, block, file, problems, (e) => isMissing(e, 'severity'));
  if (f['severity'] === undefined) problems.push({ file, line, message: `${who} has no severity` });
  if (typeof f['id'] === 'string' && f['id'] !== id) {
    problems.push({ file, line: keyLine(doc, block, 'id'), message: `heading says ${id}, fields say ${f['id']}` });
  }
  // A convention finding stands on a written rule; without one it is a reviewer's taste, which is not a finding.
  const unruled = f['concern'] === 'convention' && f['rule'] === undefined;
  if (unruled) {
    problems.push({ file, line, message: `${who} is a convention finding with no rule; cite the written rule it breaks as <file>:<line>` });
  }
  // A finding belongs to a repository the review looked at; a header that did not read has no list to hold it to.
  const reviewed = Object.keys(section.commits);
  const stray = typeof f['repo'] === 'string' && reviewed.length > 0 && !reviewed.includes(f['repo']);
  if (stray) {
    problems.push({
      file,
      line: keyLine(doc, block, 'repo'),
      message: `${who} names repo ${f['repo']}, which review ${section.number} does not list in its commits`,
    });
  }
  // A finding that fails its schema cannot be shown with a severity, a file and a line; the problem says why.
  if (!ok || unruled || stray) return null;
  return {
    id,
    severity: f['severity'] as ParsedFinding['severity'],
    ...(f['repo'] === undefined ? {} : { repo: f['repo'] as string }),
    ...(f['concern'] === undefined ? {} : { concern: f['concern'] as NonNullable<ParsedFinding['concern']> }),
    ...(f['rule'] === undefined ? {} : { rule: f['rule'] as string }),
    file: f['file'] as string,
    line: f['line'] as number,
    text: doc.lines.slice(block.last + 2, end).join('\n').trim(),
  };
}

function readSection(
  doc: Doc,
  index: number,
  number: number,
  end: number,
  file: string,
  problems: Problem[],
  claimed: Set<number>,
): ParsedReviewSection {
  const section: ParsedReviewSection = { number, reviewed_at: '', commits: {}, findings: [] };
  const who = `review ${number}`;
  const firstFinding = nextHeading(doc, index + 1, end, /^### F\d+\s*$/);
  const block = yamlBlock(doc, index + 1, firstFinding);
  if (!block) {
    problems.push({ file, line: index + 1, message: `${who} has no header block` });
  } else {
    claimed.add(block.open);
    const fields = parseFields(block, who, file, problems);
    if (fields) {
      checkFields(validateHeader, fields.values, `${who} header`, block, file, problems, () => false);
      if (typeof fields.values['review'] === 'number' && fields.values['review'] !== number) {
        problems.push({ file, line: keyLine(doc, block, 'review'), message: `heading says review ${number}, fields say review ${fields.values['review']}` });
      }
      if (typeof fields.text['reviewed_at'] === 'string') section.reviewed_at = fields.text['reviewed_at'];
      const commits = fields.text['commits'];
      if (commits !== null && typeof commits === 'object' && !Array.isArray(commits)) {
        for (const [repo, hash] of Object.entries(commits)) if (typeof hash === 'string') section.commits[repo] = hash;
      }
    }
  }
  const heads: { index: number; id: string }[] = [];
  for (let i = firstFinding; i < end; i++) {
    const m = doc.heading[i] ? FINDING_HEADING.exec(doc.lines[i] as string) : null;
    if (m) heads.push({ index: i, id: m[1] as string });
  }
  const seen = new Map<string, number>();
  heads.forEach((h, n) => {
    const first = seen.get(h.id);
    if (first === undefined) seen.set(h.id, h.index + 1);
    else problems.push({ file, line: h.index + 1, message: `finding ${h.id} is recorded twice, first on line ${first}` });
    const limit = nextHeading(doc, h.index + 1, heads[n + 1]?.index ?? end, /^#{1,3} /);
    const finding = readFinding(doc, h.index, h.id, limit, file, problems, claimed, section);
    if (finding) section.findings.push(finding);
  });
  return section;
}

/** Reads a review document: one `## Review <n>` section per review, each with a header block and its findings. */
export function readReview(text: string, file: string): ReadResult {
  const { data } = parseFrontMatter(text, file);
  const layout = layoutOf(data);
  refuseNewerLayout(layout, file);
  const problems: Problem[] = [];
  // There is no layout 1 review document, so a review without its layout version always lacks it.
  if (data['layout'] === undefined) problems.push({ file, line: 1, message: 'no layout version' });
  const doc = splitDoc(text);
  const heads: { index: number; number: number }[] = [];
  doc.lines.forEach((line, index) => {
    const m = doc.heading[index] ? REVIEW_HEADING.exec(line) : null;
    if (m) heads.push({ index, number: Number(m[1]) });
  });
  const claimed = new Set<number>();
  if (heads.length === 0) problems.push({ file, line: 1, message: 'review document has no review section' });
  const reviews = heads.map((h, n) => {
    if (h.number !== n + 1) {
      problems.push({ file, line: h.index + 1, message: `review ${h.number} is out of order, expected review ${n + 1}` });
    }
    const end = nextHeading(doc, h.index + 1, doc.lines.length, /^#{1,2} /);
    return readSection(doc, h.index, h.number, end, file, problems, claimed);
  });
  reportUnread(
    doc,
    file,
    problems,
    [
      { prefix: recordPrefix('Review', 2), strict: REVIEW_HEADING, what: 'a review heading' },
      { prefix: recordPrefix('F\\d+'), strict: FINDING_HEADING, what: 'a finding heading' },
    ],
    ['review', 'id'],
    /^\s*(id\s*:\s*["']?F\d+|review\s*:\s*["']?\d+)/,
    claimed,
  );
  return { kind: 'review', layout, document: { reviews }, problems };
}
