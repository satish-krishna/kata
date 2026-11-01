import type { RunKind } from '@bindings/RunKind';

/** The document runs of a change that exists, which `sdlcRunChange` launches: the kinds of `RunKind` that compose a run-spec of a change without building. */
export type DocumentKind = Extract<RunKind, 'intent' | 'spec' | 'plan' | 'triage' | 'fix'>;
