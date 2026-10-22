import { Injectable, signal } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';
import type { RunSettings } from '@bindings/RunSettings';
import type { Mode } from '@bindings/Mode';
import type { PresetFrom, KindGroup } from '../../lib/given';
import type { PreviewEnvRow, PreviewSettingRow } from '../../ui/run-preview-dialog';

export type PreviewRequest = { spec: RunSpec; mode: 'run' | 'sdlc'; workdir: string; from: Omit<PresetFrom, 'workdir'> };

export function settingRows(_settings: RunSettings, _mode: Mode): PreviewSettingRow[] {
  return [];
}

@Injectable()
export class RunPreviewViewModel {
  readonly isOpen = signal(false);
  readonly busy = signal(false);
  readonly groups = signal<KindGroup[]>([]);
  readonly settings = signal<PreviewSettingRow[]>([]);
  readonly env = signal<PreviewEnvRow[]>([]);
  readonly warnings = signal<string[]>([]);
  open(_req: PreviewRequest): Promise<RunSpec | null> {
    return Promise.resolve(null);
  }
  toggle(_key: string, _off: boolean): void {}
  start(): void {}
  cancel(): void {}
}
