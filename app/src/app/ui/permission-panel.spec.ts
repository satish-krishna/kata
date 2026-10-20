import { render } from '../../testing/render';
import type { PermissionRecord } from '../lib/events';
import { PermissionPanel } from './permission-panel';

const PENDING: PermissionRecord = { id: 'p1', tool: 'Bash', input_summary: 'rm -rf build/', decided: null, at: 0 };

async function mount(record: PermissionRecord) {
  const r = await render(PermissionPanel, { record });
  const decide = vi.fn();
  r.fixture.componentInstance.decide.subscribe(decide);
  const root = r.container;
  const btn = (name: string) =>
    Array.from(root.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === name)!;
  const click = async (el: HTMLElement) => {
    el.click();
    await r.fixture.whenStable();
  };
  const textbox = () => root.querySelector('textarea') as HTMLTextAreaElement | null;
  const type = async (value: string) => {
    const t = textbox()!;
    t.value = value;
    t.dispatchEvent(new Event('input', { bubbles: true }));
    await r.fixture.whenStable();
  };
  return { ...r, decide, btn, click, textbox, type };
}

describe('PermissionPanel - pending', () => {
  it('shows the tool, the input, and both verdict buttons', async () => {
    const m = await mount(PENDING);
    const text = m.container.textContent!;
    expect(text).toContain('Bash');
    expect(text).toContain('rm -rf build/');
    expect(text).toContain('awaiting your decision');
    expect(m.btn('Deny').disabled).toBe(false);
    expect(m.btn('Allow · resume').disabled).toBe(false);
  });

  it('sends (id, true, null) on allow', async () => {
    const m = await mount(PENDING);
    await m.click(m.btn('Allow · resume'));
    expect(m.decide).toHaveBeenCalledWith({ id: 'p1', allow: true, message: null });
  });

  it('sends the trimmed reason on deny', async () => {
    const m = await mount(PENDING);
    await m.type('  not on main  ');
    await m.click(m.btn('Deny'));
    expect(m.decide).toHaveBeenCalledWith({ id: 'p1', allow: false, message: 'not on main' });
  });

  it('sends null rather than an empty reason on deny', async () => {
    const m = await mount(PENDING);
    await m.type('   ');
    await m.click(m.btn('Deny'));
    expect(m.decide).toHaveBeenCalledWith({ id: 'p1', allow: false, message: null });
  });

  it('renders an empty-input placeholder when there is no input summary', async () => {
    const m = await mount({ ...PENDING, input_summary: '' });
    expect(m.container.textContent).toContain('(no input)');
  });

  it('marks the primary action for the parity script', async () => {
    const m = await mount(PENDING);
    expect(m.container.querySelector('.k-ask__foot button.k-btn--primary')).not.toBeNull();
  });

  it('groups Deny and Allow into one right-aligned pair, after the hint', async () => {
    const m = await mount(PENDING);
    const foot = m.container.querySelector('.k-ask__foot')!;
    const pair = foot.querySelector(':scope > .k-ask__actions')!;
    expect(Array.from(pair.querySelectorAll('button')).map((b) => b.textContent!.trim())).toEqual([
      'Deny',
      'Allow · resume',
    ]);
    expect(foot.querySelector(':scope > [hlmBtn]')).toBeNull();
    expect(foot.lastElementChild).toBe(pair);
  });
});

describe('PermissionPanel - settled', () => {
  it('marks the taken verdict, disables both buttons, and drops the textarea', async () => {
    const m = await mount({ ...PENDING, decided: { allow: true, message: null } });
    const allow = m.btn('Allow');
    const deny = m.btn('Deny');
    expect(allow.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    expect(allow.classList.contains('k-ask__confirm-btn--selected')).toBe(true);
    expect(deny.classList.contains('k-ask__confirm-btn--selected')).toBe(false);
    expect(m.textbox()).toBeNull();
  });

  it('renders the denial message and marks deny as taken', async () => {
    const m = await mount({ ...PENDING, decided: { allow: false, message: 'not on this branch' } });
    expect(m.container.textContent).toContain('not on this branch');
    expect(m.container.textContent).toContain('denied · run resumed');
    expect(m.btn('Deny').classList.contains('k-ask__confirm-btn--selected')).toBe(true);
  });

  it('labels the settled state as resumed', async () => {
    const m = await mount({ ...PENDING, decided: { allow: true, message: null } });
    expect(m.container.textContent).toContain('allowed · run resumed');
  });
});

describe('PermissionPanel - run ended undecided', () => {
  it('drops the reason box and verdict buttons and says the run ended', async () => {
    const { container } = await render(PermissionPanel, { record: PENDING, ended: true });
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain('not decided · run ended');
    expect(container.textContent).toContain('rm -rf build/');
  });
});
