import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { KataTransport } from '../app/core/transport/kata-transport';

/** Every change of a system, newest first, each read the way the change page reads it: the names first, then one read per change. */
export async function readAllChanges(transport: KataTransport, master = '/m', system = 'commerce'): Promise<ChangeInfo[]> {
  const names = await transport.sdlcChangeNames(master, system);
  return Promise.all(names.map((n) => transport.sdlcReadChange(master, system, n.change)));
}
