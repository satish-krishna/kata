/// <reference lib="webworker" />
// Monaco's editor worker, bundled from node_modules into its own file by the Angular
// builder, so it loads from 'self' under the Tauri CSP rather than from a CDN or a blob.
import 'monaco-editor/editor/editor.worker';
