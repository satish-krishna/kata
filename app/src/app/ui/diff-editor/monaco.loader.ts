import type * as Monaco from 'monaco-editor/editor/editor.api';

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | undefined;

/**
 * Loads Monaco on first use, entirely from the app bundle: the editor core is a lazy
 * chunk, its stylesheet is the `monaco` bundle angular.json builds without injecting,
 * and its one worker is a bundled file. Nothing comes from a CDN and nothing needs a
 * blob URL, so the Tauri CSP stays at 'self'.
 *
 * Only the editor worker is configured: the diff view highlights by language id and needs
 * no language services, so no TypeScript, JSON, CSS or HTML workers are shipped.
 */
export function loadMonaco(): Promise<MonacoApi> {
  loading ??= (async () => {
    (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: () => new Worker(new URL('./editor.worker', import.meta.url), { type: 'module' }),
    };
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    // The `monaco` bundle from angular.json (inject: false) is emitted unhashed even with
    // outputHashing "all"; resolve it against the document base so a sub-path deploy loads too.
    stylesheet.href = new URL('monaco.css', document.baseURI).href;
    document.head.append(stylesheet);
    return import('monaco-editor/editor/editor.api');
  })();
  return loading;
}

/** Tests spy on `monaco.load`, the way the Mermaid tests spy on `diagrams.render`. */
export const monaco = { load: (): Promise<MonacoApi> => loadMonaco() };
