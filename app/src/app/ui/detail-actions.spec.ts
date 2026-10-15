import { render } from '../../testing/render';
import { DetailActions } from './detail-actions';

const button = (c: HTMLElement, name: RegExp) =>
  Array.from(c.querySelectorAll('button')).find((b) => name.test(b.textContent!))!;

describe('DetailActions', () => {
  it('disables every action and explains why on the hoverable container when the kata is unsaved', async () => {
    const { container } = await render(DetailActions, { kataSaved: false });
    for (const name of [/re-run/i, /open in compose/i, /export bundle/i]) {
      expect(button(container, name).disabled).toBe(true);
    }
    // The hint sits on the container (disabled buttons don't fire hover events).
    expect(container.querySelector('.wb-detail__actions')!.getAttribute('title')).toContain('not in the library');
  });

  it('enables actions with no tooltip when the kata is saved', async () => {
    const { container } = await render(DetailActions, { kataSaved: true });
    expect(button(container, /re-run/i).disabled).toBe(false);
    expect(container.querySelector('.wb-detail__actions')!.hasAttribute('title')).toBe(false);
  });

  it('emits the matching output on click when enabled', async () => {
    const { fixture, container } = await render(DetailActions, { kataSaved: true });
    const got: string[] = [];
    const c = fixture.componentInstance;
    c.reRun.subscribe(() => got.push('rerun'));
    c.openInCompose.subscribe(() => got.push('compose'));
    c.exportBundle.subscribe(() => got.push('export'));
    button(container, /open in compose/i).click();
    button(container, /re-run/i).click();
    button(container, /export bundle/i).click();
    expect(got).toEqual(['compose', 'rerun', 'export']);
    expect(container.querySelectorAll('.k-btn--primary').length).toBe(1);
  });
});
