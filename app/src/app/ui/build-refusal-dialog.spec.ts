import { render } from '../../testing/render';
import { BuildRefusalDialog } from './build-refusal-dialog';

const alert = () => document.body.querySelector('[role="alertdialog"]');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;

describe('BuildRefusalDialog', () => {
  it('renders nothing without a reason', async () => {
    await render(BuildRefusalDialog, { reason: null });
    expect(alert()).toBeNull();
  });

  it('the refusal dialog names the repository and the reason (R3.1)', async () => {
    await render(BuildRefusalDialog, { reason: 'claims-core has uncommitted files: a.txt' });
    const text = alert()!.textContent!.replace(/\s+/g, ' ');
    const title = alert()!.querySelector('[data-slot="alert-dialog-title"]')!;
    expect(title.textContent).toContain('The build did not start');
    expect(alert()!.getAttribute('aria-labelledby')).toBe(title.id);
    expect(text).toContain('claims-core has uncommitted files: a.txt');
    expect(text).toContain('Nothing was created or switched in any repository.');
  });

  it('shows the reason in the crimson banner', async () => {
    await render(BuildRefusalDialog, { reason: 'Update the ai-sdlc plugin to 0.8.0 or later, then start the build again.' });
    const banner = alert()!.querySelector('[data-slot="alert"]')!;
    expect(banner.textContent).toContain('Update the ai-sdlc plugin');
    expect(banner.className).toContain('wb-banner--error');
  });

  it('lists the problems the check found, one line each (R8.1)', async () => {
    await render(BuildRefusalDialog, {
      reason: 'The plan does not pass the check',
      problems: [
        { file: 'plan.md', line: 18, message: 'task T1 has no Tests section' },
        { file: 'plan.md', line: 30, message: 'task T2 has no Done when section' },
      ],
    });
    const items = Array.from(alert()!.querySelectorAll('ul[aria-label="Problems"] li')).map((li) => li.textContent!.trim());
    expect(items).toEqual(['plan.md:18 task T1 has no Tests section', 'plan.md:30 task T2 has no Done when section']);
  });

  it('shows no list when the reason says it all', async () => {
    await render(BuildRefusalDialog, { reason: 'This plan needs a newer Workbench' });
    expect(alert()!.querySelector('ul')).toBeNull();
  });

  it('has Close only, and emits close from it', async () => {
    const { fixture } = await render(BuildRefusalDialog, { reason: 'x' });
    expect(Array.from(alert()!.querySelectorAll('button')).map((b) => b.textContent!.trim())).toEqual(['Close']);
    let closed = 0;
    fixture.componentInstance.close.subscribe(() => closed++);
    button('Close').click();
    expect(closed).toBe(1);
  });
});
