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
const rows = (): PreviewSettingRow[] => settingRows(previewFixture(bare, []).settings, 'workbench');
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
});
