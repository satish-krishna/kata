import type { StatusText } from '../sdlc/build/build-page.view-model';

export type TaskLine = { id: string; name: string; status: StatusText; finished: boolean; departure: string | null };

export type TaskFilter = 'all' | 'open' | 'departed' | 'done';

export type TaskListView = {
  fold: { range: string; done: number; departed: number; open: boolean } | null;
  rows: { line: TaskLine; showDeparture: boolean }[];
  empty: string | null;
};

export type FilterCounts = { all: number; open: number; departed: number; done: number };

const departedOf = (lines: TaskLine[]) => lines.filter((t) => t.departure !== null);
const plain = (lines: TaskLine[]) => lines.map((line) => ({ line, showDeparture: false }));

export function taskList(tasks: TaskLine[], filter: TaskFilter, open: boolean, picked: string | null): TaskListView {
  const finished = tasks.filter((t) => t.finished);
  const unfinished = tasks.filter((t) => !t.finished);
  switch (filter) {
    case 'open':
      return { fold: null, rows: plain(unfinished), empty: unfinished.length === 0 ? 'Nothing open.' : null };
    case 'departed':
      return { fold: null, rows: departedOf(finished).map((line) => ({ line, showDeparture: true })), empty: null };
    case 'done':
      return { fold: null, rows: plain(finished), empty: null };
    case 'all': {
      if (finished.length === 0) return { fold: null, rows: plain(tasks), empty: null };
      const shown = open || finished.some((t) => t.id === picked);
      const first = finished[0].id;
      const last = finished[finished.length - 1].id;
      return {
        fold: {
          range: finished.length === 1 ? first : `${first}–${last}`,
          done: finished.length,
          departed: departedOf(finished).length,
          open: shown,
        },
        rows: plain(shown ? [...finished, ...unfinished] : unfinished),
        empty: null,
      };
    }
  }
}

export function filterCounts(tasks: TaskLine[]): FilterCounts {
  const finished = tasks.filter((t) => t.finished);
  return {
    all: tasks.length,
    open: tasks.length - finished.length,
    departed: departedOf(finished).length,
    done: finished.length,
  };
}
