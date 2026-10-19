import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import { NewChangeDialog } from './new-change-dialog';

const dialog = () => document.body.querySelector('[role="dialog"]');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label)!;
const idea = () => dialog()!.querySelector<HTMLTextAreaElement>('textarea')!;
const type = async (value: string) => {
  idea().value = value;
  idea().dispatchEvent(new Event('input'));
  await settle();
};
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};

describe('NewChangeDialog', () => {
  it('renders nothing while closed', async () => {
    await render(NewChangeDialog, { open: false, systems: ['claims'] });
    expect(dialog()).toBeNull();
  });

  it('asks only for the idea when there is one system', async () => {
    await render(NewChangeDialog, { open: true, systems: ['claims'] });
    await settle();
    expect(dialog()!.querySelector('hlm-select')).toBeNull();
    expect(idea()).not.toBeNull();
  });

  it('asks for the system when there is more than one', async () => {
    await render(NewChangeDialog, { open: true, systems: ['claims', 'billing'] });
    await settle();
    expect(dialog()!.querySelector('hlm-select')).not.toBeNull();
  });

  it('cannot start without an idea', async () => {
    await render(NewChangeDialog, { open: true, systems: ['claims'] });
    await settle();
    expect((button('Start') as HTMLButtonElement).disabled).toBe(true);
    await type('   ');
    expect((button('Start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts with the only system and the trimmed idea', async () => {
    const { fixture } = await render(NewChangeDialog, { open: true, systems: ['claims'] });
    await settle();
    const got: unknown[] = [];
    fixture.componentInstance.start.subscribe((v) => got.push(v));
    await type('  flag suspected fraud  ');
    button('Start').click();
    expect(got).toEqual([{ system: 'claims', idea: 'flag suspected fraud' }]);
  });

  it('defaults to the first system when several exist', async () => {
    const { fixture } = await render(NewChangeDialog, { open: true, systems: ['claims', 'billing'] });
    await settle();
    const got: { system: string }[] = [];
    fixture.componentInstance.start.subscribe((v) => got.push(v));
    await type('an idea');
    button('Start').click();
    expect(got[0].system).toBe('claims');
  });

  it('emits cancel from Cancel', async () => {
    const { fixture } = await render(NewChangeDialog, { open: true, systems: ['claims'] });
    await settle();
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    button('Cancel').click();
    expect(n).toBe(1);
  });
});
