import type { StatusText } from '../sdlc/build/build-page.view-model';

export type TaskLine = { id: string; name: string; status: StatusText; finished: boolean; departure: string | null };

export type TaskFilter = 'all' | 'open' | 'departed' | 'done';

export type TaskListView = {
  fold: { range: string; done: number; departed: number; open: boolean } | null;
  rows: { line: TaskLine; showDeparture: boolean }[];
  empty: string | null;
};

export type FilterCounts = { all: number; open: number; departed: number; done: number };

export function taskList(_tasks: TaskLine[], _filter: TaskFilter, _open: boolean, _picked: string | null): TaskListView {
  return { fold: null, rows: [], empty: null };
}

export function filterCounts(_tasks: TaskLine[]): FilterCounts {
  return { all: 0, open: 0, departed: 0, done: 0 };
}
