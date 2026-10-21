import type { ChangeStatus } from '@bindings/ChangeStatus';

type Tone = 'success' | 'warning' | 'error' | 'idle';

/** How each kind of change reads: its letter in the file list, its name for assistive technology, and its status tone. */
export const FILE_STATUS: Record<ChangeStatus, { letter: string; name: string; tone: Tone }> = {
  added: { letter: 'A', name: 'Added', tone: 'success' },
  modified: { letter: 'M', name: 'Modified', tone: 'idle' },
  deleted: { letter: 'D', name: 'Deleted', tone: 'error' },
  renamed: { letter: 'R', name: 'Renamed', tone: 'idle' },
  untracked: { letter: 'U', name: 'Untracked', tone: 'warning' },
};
