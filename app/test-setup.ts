import { monaco } from './src/app/ui/diff-editor/monaco.loader';

// Monaco never loads in a unit test: under jsdom it throws from its theme service after the
// test that mounted it has finished, and Vitest fails the run on the unhandled rejection.
// The Angular unit-test builder rejects vi.mock for relative imports, so every test starts
// with the loader spied to wait forever. A spec that needs the editor overrides the spy.
beforeEach(() => {
  vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
});
