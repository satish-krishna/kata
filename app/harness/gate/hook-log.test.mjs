import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logFiring, DEFAULT_LOG_PATH } from '../../.claude/hooks/_hook-log.mjs';

describe('logFiring', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'firing-')); });
  afterEach(() => { delete process.env.HOOK_LOG; rmSync(dir, { recursive: true, force: true }); });

  it('keeps the verbose per-run record when HOOK_LOG is set, for the driver', () => {
    const p = join(dir, 'run.jsonl');
    process.env.HOOK_LOG = p;
    logFiring('seal-templates', 'src/a.html', ['a.html:1:1  bad'], ['seal/no-raw-control']);
    const row = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(row.count).toBe(1);
    expect(row.messages).toEqual(['a.html:1:1  bad']);
  });

  it('writes a LEAN record to the default path when HOOK_LOG is unset', () => {
    const p = join(dir, 'default.jsonl');
    logFiring('seal-templates', 'src/a.html', ['a.html:1:1  bad'], ['seal/no-raw-control'], p);
    const row = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(row.count).toBe(1);
    expect(row.rules).toEqual(['seal/no-raw-control']);
    expect(row).not.toHaveProperty('messages');
  });

  it('never throws into the gate when the path is unwritable', () => {
    expect(() => logFiring('h', 'f', ['m'], ['r'], join(dir, 'no', 'such', 'x.jsonl'))).not.toThrow();
  });

  it('names a default path inside .claude', () => {
    expect(DEFAULT_LOG_PATH).toMatch(/\.claude[/\\]hook-firings\.jsonl$/);
  });
});
