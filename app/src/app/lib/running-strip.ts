import type { OpenRun } from '@bindings/OpenRun';
import type { RunKind } from '@bindings/RunKind';

/** One run of a change the engineer can open: its repository (null for a review) and whether it waits on the engineer. */
export type RunChoice = { run: number; kind: RunKind; repo: string | null; waiting: boolean; label: string; action: 'Answer' | 'Watch'; open: OpenRun };

/** One entry as the strip draws it. Everything but the run lists is formatting of what the backend sent. */
export type StripRow = {
  id: string;
  /** The workspace's id in the workspace list; null when the backend found none. */
  workspaceId: string | null;
  system: string;
  change: string;
  /** The change's name without its date prefix. */
  name: string;
  state: string;
  tone: 'running' | 'awaiting' | 'warning' | 'error' | 'success';
  /** The question or the action asked for, or the reason a run stopped; null when the state has none. */
  text: string | null;
  /** The run an entry opens at once: the backend's `opens` is a session. */
  direct: RunChoice | null;
  /** The change's runs a list offers: the backend's `opens` is a list; empty when it is a session or the change. */
  choices: RunChoice[];
  /** The entry's whole line, for the hover text. */
  title: string;
};

/** What picking an entry asks for: the change's page, and the run to show there, or none. */
export type StripPick = { row: StripRow; choice: RunChoice | null };
