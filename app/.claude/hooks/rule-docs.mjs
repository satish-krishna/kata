// A lint MESSAGE has no url field - only ruleId, severity, message, line,
// column, messageId, endLine, endColumn. The docs url lives on the rule's
// META, reachable only through eslint.getRulesMetaForResults(). So the hooks
// have to fetch it and splice it in by hand; nothing surfaces it for free.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Unique `ruleId -> docs path` pairs for the rules that actually fired. */
export function docsPointersFor(eslint, results) {
  const meta = eslint.getRulesMetaForResults(results);
  const fired = new Set(
    results.flatMap((r) => r.messages).filter((m) => m.severity === 2).map((m) => m.ruleId),
  );
  const out = [];
  for (const ruleId of fired) {
    const url = meta[ruleId]?.docs?.url;
    if (url) out.push({ ruleId, url });
  }
  return out;
}

/**
 * The `## Agent guidance` section of each fired rule's doc, deduplicated by
 * body so four rules sharing one worked example print it once. The MARKDOWN is
 * the single source of truth: the hook text is generated from the doc rather
 * than kept alongside it, so the two cannot drift and the doc cannot rot
 * unnoticed - if it rots, the agent's corrective message rots with it.
 */
export function agentGuidanceFor(pointers) {
  const seen = new Set();
  const blocks = [];
  for (const { url } of pointers) {
    const path = join(ROOT, url);
    if (!existsSync(path)) continue;
    // Normalize CRLF -> LF before matching. core.autocrlf, a checkout with no
    // .gitattributes, or any tool that rewrites line endings can hand this
    // file back with \r\n; the regex below is anchored on a literal \n, so
    // without this the match silently fails and the guidance block silently
    // vanishes - the gate still exits 2, so nothing else would ever notice.
    const md = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const m = md.match(/\n## Agent guidance\n([\s\S]*?)(?=\n## |\s*$)/);
    if (!m) continue;
    const body = m[1].trim();
    if (!body || seen.has(body)) continue;
    seen.add(body);
    blocks.push(body);
  }
  return blocks;
}

/**
 * Renders the "which doc explains this violation" block every hook splices
 * between its violation list and its own corrective prose. Shared so the four
 * hooks cannot drift into four different ways of handling the same case: when
 * no pointer resolves (see check-layout.mjs, where a pure-stylelint violation
 * carries no rule metadata at all), this returns a single blank line rather
 * than a section header with nothing under it.
 */
export function formatDocPointerBlock(docLines) {
  if (docLines.length === 0) return '\n';
  return (
    `\nThe rule behind each violation, and the doc that argues it:\n` +
    `${docLines.join('\n')}\n` +
    `Open the doc for the full case, the accepted form, and the rule's known blind spots.\n\n`
  );
}
