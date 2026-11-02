import { diagrams } from './src/app/lib/mermaid';
import { monaco } from './src/app/ui/diff-editor/monaco.loader';

// Monaco never loads in a unit test: under jsdom it throws from its theme service after the
// test that mounted it has finished, and Vitest fails the run on the unhandled rejection.
// The Angular unit-test builder rejects vi.mock for relative imports, so every test starts
// with the loader spied to wait forever. A spec that needs the editor overrides the spy.
beforeEach(() => {
  vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined));
});

// Mermaid is a large package. Its first import in a worker is cold and blocks that worker for seconds under
// full-suite load, past the 5s test timeout, in whichever test first mounts a document with a diagram (the mock
// context and spec documents have one). So no test draws a real diagram unless it overrides this spy.
beforeEach(() => {
  vi.spyOn(diagrams, 'render').mockResolvedValue('<svg></svg>');
});
