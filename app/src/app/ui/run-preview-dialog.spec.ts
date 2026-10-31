import type { ItemKind } from '@bindings/ItemKind';
import type { Source } from '@bindings/Source';
import { groupRows, presetRows, type PresetFrom } from '../lib/given';
import { previewFixture, seedSpec } from '../lib/mock';
import { settingRows } from '../core/given/run-preview.view-model';
import { render } from '../../testing/render';
import { RunPreviewDialog, type PreviewSettingRow } from './run-preview-dialog';

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
const region = () => dialog().querySelector('[data-region="settings"]')!;
const button = (label: string) => Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label) as HTMLButtonElement;
// A run-spec that names no model and sets no turn cap, so those two settings fall back.
const bare = { ...seedSpec(), model: { ...seedSpec().model, id: null }, leash: { ...seedSpec().leash, max_turns: null } };
const rows = (): PreviewSettingRow[] => settingRows(previewFixture(bare).settings, 'workbench');
const base = { open: true, title: 'Run preview', settings: rows() };

describe('RunPreviewDialog', () => {
  it.each([
    'Model',
    'Effort level',
    'Permission posture',
    'Empty room',
    'Answer deadline',
    'Time limit',
    'Turn cap',
    'Spending ceiling',
  ])('each run setting is shown read-only with its source: %s', async (label) => {
    await render(RunPreviewDialog, base);
    const row = rows().find((r) => r.label === label)!;
    expect(row).toBeDefined();
    const el = Array.from(region().querySelectorAll('[data-setting]')).find((e) => e.getAttribute('data-setting') === label)!;
    expect(el).toBeDefined();
    expect(text(el)).toContain(row.value);
    expect(text(el)).toContain(row.source);
    expect(region().querySelectorAll('input, select, textarea, button, hlm-switch, [role="switch"]')).toHaveLength(0);
  });

  it('a limit nobody set reads none', async () => {
    await render(RunPreviewDialog, base);
    const turns = region().querySelector('[data-setting="Turn cap"]')!;
    expect(text(turns)).toContain('none');
  });

  it("a model nobody chose shows as Claude's default", async () => {
    await render(RunPreviewDialog, base);
    const model = region().querySelector('[data-setting="Model"]')!;
    expect(text(model)).toContain("Claude's default");
  });

  it("shows the build's safety rules when it has them and names the key variable", async () => {
    await render(RunPreviewDialog, {
      ...base,
      safetyRules: ['Edit(//d/ws/.git/**)'],
      env: [{ name: 'ANTHROPIC_API_KEY', source: 'personal setup', apiKey: true }],
    });
    expect(text(dialog())).toContain('Edit(//d/ws/.git/**)');
    expect(text(dialog())).toContain('ANTHROPIC_API_KEY');
    expect(text(dialog())).toContain('API key');
  });

  it('shows warnings at the top as a notice', async () => {
    await render(RunPreviewDialog, { ...base, warnings: ['The job switches off `x`'] });
    const notice = dialog().querySelector('[data-region="warnings"]')!;
    expect(text(notice)).toContain('The job switches off `x`');
  });

  it('starts and cancels from its buttons, and busy disables start', async () => {
    const { fixture } = await render(RunPreviewDialog, base);
    const got: string[] = [];
    fixture.componentInstance.start.subscribe(() => got.push('start'));
    fixture.componentInstance.cancel.subscribe(() => got.push('cancel'));
    button('Start run').click();
    button('Cancel').click();
    expect(got).toEqual(['start', 'cancel']);
    fixture.componentRef.setInput('busy', true);
    await fixture.whenStable();
    expect(button('Start run').disabled).toBe(true);
  });

  it("the start button's text is the startLabel input", async () => {
    const { fixture } = await render(RunPreviewDialog, base);
    expect(button('Start run')).toBeDefined();
    fixture.componentRef.setInput('startLabel', 'Start 2 agents');
    await fixture.whenStable();
    expect(button('Start 2 agents')).toBeDefined();
    expect(button('Start run')).toBeUndefined();
  });

  it('cancel emits on Escape', async () => {
    const { fixture } = await render(RunPreviewDialog, base);
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(n).toBe(1);
  });

  it('renders nothing while closed', async () => {
    await render(RunPreviewDialog, { ...base, open: false });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  describe('the empty room', () => {
    const FROM: PresetFrom = { workdir: seedSpec().workdir, session: new Set(), job: null, build: null };
    const withRoom = (on: boolean) => ({ ...seedSpec(), auth: { bare: on, token_env: null } });
    const listing = (on: boolean) => presetRows(previewFixture(withRoom(on)), FROM).rows;
    const NOTICE = "The empty room is on: the run is given only what Kata passes. Your setup's hooks, skills, plugins, standing instructions and tool servers are left out.";
    const notice = () => dialog().querySelector('[data-region="empty-room"]');
    const open = async (rows = listing(true), on = true) => render(RunPreviewDialog, { ...base, groups: groupRows(rows), emptyRoom: on });

    it.each<[Source, ItemKind]>([
      ['personal', 'hook'],
      ['project', 'hook'],
      ['personal', 'skill'],
      ['project', 'skill'],
      ['personal', 'plugin'],
      ['personal', 'instruction'],
      ['project', 'instruction'],
      ['personal', 'tool-server'],
      ['project', 'tool-server'],
    ])('in the empty room the setup items are not listed and the notice shows: %s %s', async (source, kind) => {
      // Given the setup has that item: outside the empty room it is listed.
      const setup = listing(false).filter((r) => r.item.source === source && r.item.kind === kind && r.item.id !== 'personal:instruction:output-style');
      expect(setup.length).toBeGreaterThan(0);
      await open();
      for (const r of setup) expect(dialog().querySelector(`[data-row="${r.key}"]`)).toBeNull();
      expect(notice()).not.toBeNull();
      expect(text(notice()!)).toContain(NOTICE);
    });

    it('outside the empty room there is no notice', async () => {
      await open(listing(false), false);
      expect(notice()).toBeNull();
    });

    it.each([
      ["Kata's question tool", 'kata:tool-server:kata-ask', 'Kata itself', true],
      ["Kata's standing note on how to ask", 'kata:instruction:standing-note', 'Kata itself', true],
      ['a skill picked for the job', 'run-spec:skill:doc-writer', 'run-spec', false],
      ['a plugin picked for the job', 'run-spec:plugin:github-tools', 'run-spec', false],
      ["the job's own standing instruction", 'run-spec:instruction:identity', 'run-spec', false],
      ['an output style set in the setup', 'personal:instruction:output-style', 'personal setup', false],
    ])('in the empty room what Kata passes is listed and switchable: %s', async (_label, id, source, locked) => {
      await open();
      expect(notice()).not.toBeNull();
      const row = dialog().querySelector(`[data-row="${id}"]`)!;
      expect(row).not.toBeNull();
      expect(row.querySelector('[data-source-tag]')!.textContent!.trim()).toBe(source);
      expect(row.querySelector('hlm-switch') === null).toBe(locked);
    });
  });
});
