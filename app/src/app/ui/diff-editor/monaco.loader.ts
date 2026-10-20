import type * as Monaco from 'monaco-editor/editor/editor.api';

export type MonacoApi = typeof Monaco;

export function loadMonaco(): Promise<MonacoApi> {
  return Promise.reject(new Error('not implemented'));
}

/** Tests spy on `monaco.load`, the way the Mermaid tests spy on `diagrams.render`. */
export const monaco = { load: (): Promise<MonacoApi> => loadMonaco() };
