import type { FilePair } from '@bindings/FilePair';
import { render } from '../../../testing/render';
import { DiffEditor } from './diff-editor';
import { monaco, type MonacoApi } from './monaco.loader';

type FakeModel = { text: string; disposed: boolean; setValue: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };

/** A Monaco that records what the component asks of it. jsdom cannot run the real editor. */
function fakeMonaco(changes: { modifiedStartLineNumber: number; modifiedEndLineNumber: number }[] = []) {
  const events: string[] = [];
  const models: FakeModel[] = [];
  const modifiedEditor = {
    getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
    setPosition: vi.fn(),
    revealLineInCenter: vi.fn(),
    focus: vi.fn(),
    addCommand: vi.fn(),
    addAction: vi.fn(),
  };
  const editor = {
    setModel: vi.fn((m: unknown) => events.push(m ? 'setModel' : 'clearModel')),
    updateOptions: vi.fn(),
    getLineChanges: vi.fn(() => changes),
    getModifiedEditor: vi.fn(() => modifiedEditor),
    layout: vi.fn(),
    dispose: vi.fn(),
    addCommand: vi.fn(),
  };
  const api = {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      createDiffEditor: vi.fn((_host: unknown, _options: unknown) => editor),
      createModel: vi.fn((text: string) => {
        const model: FakeModel = {
          text,
          disposed: false,
          setValue: vi.fn((v: string) => (model.text = v)),
          dispose: vi.fn(() => {
            model.disposed = true;
            events.push(`dispose:${model.text}`);
          }),
        };
        models.push(model);
        return model;
      }),
    },
  };
  return { api: api as unknown as MonacoApi, raw: api, editor, modifiedEditor, models, events };
}

const pair = (original: string, modified: string, binary = false): FilePair => ({
  original,
  modified,
  languageHint: 'plaintext',
  binary,
});

async function mount(fake: ReturnType<typeof fakeMonaco>, inputs: Record<string, unknown>) {
  vi.spyOn(monaco, 'load').mockResolvedValue(fake.api);
  const view = await render(DiffEditor, inputs);
  await vi.waitFor(() => expect(fake.raw.editor.createDiffEditor).toHaveBeenCalled());
  view.fixture.detectChanges();
  return view;
}

afterEach(() => vi.restoreAllMocks());

describe('DiffEditor', () => {
  it('diff editor folds unchanged regions and steps between changes (R7.8)', async () => {
    const fake = fakeMonaco([
      { modifiedStartLineNumber: 5, modifiedEndLineNumber: 6 },
      { modifiedStartLineNumber: 30, modifiedEndLineNumber: 31 },
    ]);
    const { fixture } = await mount(fake, { pair: pair('a', 'b'), sideBySide: true });

    const options = fake.raw.editor.createDiffEditor.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(options['hideUnchangedRegions']).toEqual({ enabled: true });
    expect(options['readOnly']).toBe(true);
    expect(options['originalEditable']).toBe(false);
    expect(options['renderSideBySide']).toBe(true);
    expect(options['mouseWheelZoom']).toBe(false);
    expect(options['automaticLayout']).toBe(true);
    expect(options['minimap']).toEqual({ enabled: false });
    expect(String(options['fontFamily'])).toContain('IBM Plex Mono');

    fixture.componentInstance.nextChange();
    expect(fake.modifiedEditor.setPosition).toHaveBeenCalledWith({ lineNumber: 5, column: 1 });
    expect(fake.modifiedEditor.revealLineInCenter).toHaveBeenCalledWith(5);

    fixture.componentRef.setInput('sideBySide', false);
    await fixture.whenStable();
    expect(fake.editor.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: false });
  });

  it('binds no keybinding of its own, so the window zoom keys pass through', async () => {
    const fake = fakeMonaco();
    await mount(fake, { pair: pair('a', 'b') });
    expect(fake.editor.addCommand).not.toHaveBeenCalled();
    expect(fake.modifiedEditor.addCommand).not.toHaveBeenCalled();
    expect(fake.modifiedEditor.addAction).not.toHaveBeenCalled();
  });

  it('swapping files disposes the previous models', async () => {
    const fake = fakeMonaco();
    const { fixture } = await mount(fake, { pair: pair('old-a', 'new-a') });
    expect(fake.models.map((m) => m.text)).toEqual(['old-a', 'new-a']);

    fixture.componentRef.setInput('pair', pair('old-b', 'new-b'));
    await fixture.whenStable();

    expect(fake.models.map((m) => m.text)).toEqual(['old-a', 'new-a', 'old-b', 'new-b']);
    expect(fake.models.map((m) => m.disposed)).toEqual([true, true, false, false]);
    // The editor lets go of the old pair first; only then is it disposed.
    expect(fake.events).toEqual(['setModel', 'setModel', 'dispose:old-a', 'dispose:new-a']);

    fixture.destroy();
    expect(fake.models.every((m) => m.disposed)).toBe(true);
    expect(fake.editor.dispose).toHaveBeenCalled();
  });

  it('updateModified keeps the view state', async () => {
    const fake = fakeMonaco();
    const { fixture } = await mount(fake, { pair: pair('same', 'before') });
    const [original, modified] = fake.models;

    fixture.componentInstance.updateModified('after');

    expect(modified.setValue).toHaveBeenCalledWith('after');
    expect(original.setValue).not.toHaveBeenCalled();
    expect(fake.raw.editor.createModel).toHaveBeenCalledTimes(2);
    expect(fake.editor.setModel).toHaveBeenCalledTimes(1);
    expect(fake.models.some((m) => m.disposed)).toBe(false);
  });

  it('the modifiedText input refreshes the new side in place', async () => {
    const fake = fakeMonaco();
    const { fixture } = await mount(fake, { pair: pair('same', 'before') });

    fixture.componentRef.setInput('modifiedText', 'refreshed');
    await fixture.whenStable();

    expect(fake.models[1].setValue).toHaveBeenCalledWith('refreshed');
    expect(fake.editor.setModel).toHaveBeenCalledTimes(1);
  });

  it('a window resize lays the editor out again', async () => {
    const fake = fakeMonaco();
    await mount(fake, { pair: pair('a', 'b') });
    window.dispatchEvent(new Event('resize'));
    expect(fake.editor.layout).toHaveBeenCalled();
  });

  it('a binary pair shows no editor', async () => {
    const fake = fakeMonaco();
    const { fixture, container } = await mount(fake, { pair: pair('', '', true) });
    expect(fake.raw.editor.createModel).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Binary file. No line diff.');
    expect(container.querySelector<HTMLElement>('[data-slot=monaco]')!.hidden).toBe(true);

    fixture.componentRef.setInput('pair', pair('a', 'b'));
    await fixture.whenStable();
    expect(container.textContent).not.toContain('Binary file.');
    expect(container.querySelector<HTMLElement>('[data-slot=monaco]')!.hidden).toBe(false);
  });
});
