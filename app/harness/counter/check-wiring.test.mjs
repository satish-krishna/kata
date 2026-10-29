import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-wiring.mjs');

let root;

function run() {
  const result = spawnSync(process.execPath, [script, '--root', root, 'src', '--json'], { encoding: 'utf8' });
  return JSON.parse(result.stdout);
}

describe('check-wiring: members read by a sibling ViewModel', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'check-wiring-'));
    const dir = join(root, 'src', 'feature');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'a.view-model.ts'),
      `export class AViewModel {\n  readonly thing = 1;\n  readonly orphan = 2;\n}\n`,
    );
    writeFileSync(
      join(dir, 'b.view-model.ts'),
      `import { AViewModel } from './a.view-model';\n` +
        `export class BViewModel {\n  private readonly a = new AViewModel();\n  private read() {\n    return this.a.thing;\n  }\n}\n`,
    );
    writeFileSync(
      join(dir, 'host.component.ts'),
      `import { Component } from '@angular/core';\n` +
        `@Component({ selector: 'app-host', providers: [AViewModel], template: '<p>hello</p>' })\n` +
        `export class HostComponent {}\n`,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not report a member another ViewModel reads off this one', () => {
    const details = run().violations.map((v) => v.detail);
    expect(details.some((d) => d.startsWith('AViewModel.thing '))).toBe(false);
  });

  it('still reports a member nothing references', () => {
    const details = run().violations.map((v) => v.detail);
    expect(details.some((d) => d.startsWith('AViewModel.orphan '))).toBe(true);
  });
});
