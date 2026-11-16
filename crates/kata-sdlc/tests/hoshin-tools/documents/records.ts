// Reads the YAML record blocks inside a document and checks them against a JSON schema from schema/.
import type { ErrorObject, ValidateFunction } from '../vendor/ajv.mjs';
import { parse } from '../vendor/yaml.mjs';
import { schemaMessages, type Block } from './doc.ts';
import type { Problem } from '../common/types.ts';

export type Fields = {
  /** The fields as YAML reads them: an all-digit commit hash is a number here. */
  values: Record<string, unknown>;
  /** The same fields with every scalar kept as the text written, so a hash keeps its digits. */
  text: Record<string, unknown>;
};

/**
 * Parses a `yaml` block into a set of fields, or reports why it is not one. `who` names the block's owner in
 * messages, for example `entry T7`.
 */
export function parseFields(block: Block, who: string, file: string, problems: Problem[]): Fields | null {
  let values: unknown;
  let text: unknown;
  try {
    values = parse(block.text);
    text = parse(block.text, { schema: 'failsafe' });
  } catch (e) {
    problems.push({ file, line: block.open + 1, message: `${who} fields are not valid YAML: ${(e as Error).message.split('\n')[0]}` });
    return null;
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values) || text === null || typeof text !== 'object') {
    problems.push({ file, line: block.open + 1, message: `${who} fields are not a set of fields` });
    return null;
  }
  return { values: values as Record<string, unknown>, text: text as Record<string, unknown> };
}

/**
 * Checks fields against a schema and reports each error at the block, leaving out the errors `skip` recognizes
 * because the caller reports them in its own words. Returns whether the fields passed the schema in full.
 */
export function checkFields(
  validate: ValidateFunction,
  fields: Record<string, unknown>,
  who: string,
  block: Block,
  file: string,
  problems: Problem[],
  skip: (e: ErrorObject) => boolean,
): boolean {
  if (validate(fields)) return true;
  const rest = (validate.errors ?? []).filter((e) => !skip(e));
  for (const message of schemaMessages(rest, who, true)) problems.push({ file, line: block.open + 1, message });
  return false;
}

/** A list of strings, or an empty list when the value is not a list. */
export function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** True for the error of a required field that is missing. */
export function isMissing(e: ErrorObject, field: string): boolean {
  return e.keyword === 'required' && e.params['missingProperty'] === field;
}
