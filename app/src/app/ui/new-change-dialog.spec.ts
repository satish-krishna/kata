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
const radio = (label: string) =>
  Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((b) => b.textContent!.trim() === label)!;
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
    expect(got).toEqual([{ system: 'claims', idea: 'flag suspected fraud', track: 'full' }]);
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

  describe('track', () => {
    it('opens on letting the workflow decide', async () => {
      const { fixture } = await render(NewChangeDialog, { open: true, systems: ['claims'], lightTrack: true });
      await settle();
      expect(radio('Let the workflow decide').getAttribute('aria-checked')).toBe('true');
      expect(radio('Full pipeline').getAttribute('aria-checked')).toBe('false');
      const got: { track: string }[] = [];
      fixture.componentInstance.start.subscribe((v) => got.push(v));
      await type('an idea');
      button('Start').click();
      expect(got[0].track).toBe('decide');
    });

    it('starts the full pipeline when it is chosen', async () => {
      const { fixture } = await render(NewChangeDialog, { open: true, systems: ['claims'], lightTrack: true });
      await settle();
      radio('Full pipeline').click();
      await settle();
      const got: { track: string }[] = [];
      fixture.componentInstance.start.subscribe((v) => got.push(v));
      await type('an idea');
      button('Start').click();
      expect(got[0].track).toBe('full');
    });

    it('offers only the full pipeline, with the reason, when the plugin cannot triage', async () => {
      const { fixture } = await render(NewChangeDialog, { open: true, systems: ['claims'], lightTrack: false });
      await settle();
      expect(radio('Let the workflow decide').disabled).toBe(true);
      expect(radio('Full pipeline').getAttribute('aria-checked')).toBe('true');
      expect(dialog()!.textContent).toContain('Needs ai-sdlc 0.13.0 or later.');
      const got: { track: string }[] = [];
      fixture.componentInstance.start.subscribe((v) => got.push(v));
      await type('an idea');
      button('Start').click();
      expect(got[0].track).toBe('full');
    });

    it('hides the Track field and starts on the given track when the track is fixed', async () => {
      const { fixture } = await render(NewChangeDialog, { open: true, systems: ['claims'], lightTrack: true, initialTrack: 'full', trackFixed: true });
      await settle();
      expect(dialog()!.querySelector('[role="radio"]')).toBeNull();
      expect(dialog()!.textContent).not.toContain('Let the workflow decide');
      const got: { track: string }[] = [];
      fixture.componentInstance.start.subscribe((v) => got.push(v));
      await type('an idea');
      button('Start').click();
      expect(got[0].track).toBe('full');
    });

    it('opens on the track it was given', async () => {
      await render(NewChangeDialog, { open: true, systems: ['claims'], lightTrack: true, initialTrack: 'full' });
      await settle();
      expect(radio('Full pipeline').getAttribute('aria-checked')).toBe('true');
    });
  });

  it('labels the description field Description', async () => {
    await render(NewChangeDialog, { open: true, systems: ['claims'] });
    await settle();
    expect(idea().getAttribute('aria-label')).toBe('Description');
  });

  it('opens with the description it was given', async () => {
    await render(NewChangeDialog, { open: true, systems: ['claims'], lightTrack: true, initialIdea: 'flag suspected fraud' });
    await settle();
    expect(idea().value).toBe('flag suspected fraud');
    expect((button('Start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows its note above the description', async () => {
    await render(NewChangeDialog, { open: true, systems: ['claims'], note: 'Describe it again.' });
    await settle();
    const text = dialog()!.textContent!;
    expect(text).toContain('Describe it again.');
    expect(text.indexOf('Describe it again.')).toBeLessThan(text.indexOf('Description'));
  });
});
