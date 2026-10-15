import { Provider } from '@angular/core';
import { inTauri } from '../../lib/mock';
import { KataTransport } from './kata-transport';
import { MockTransport } from './mock-transport';
import { TauriTransport } from './tauri-transport';

/** Pick the backend once, at bootstrap. */
export function provideKataTransport(): Provider {
  return { provide: KataTransport, useFactory: () => (inTauri() ? new TauriTransport() : new MockTransport()) };
}
