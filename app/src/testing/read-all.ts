import type { ChangeView } from '@bindings/ChangeView';
import type { OfferStage } from '@bindings/OfferStage';
import type { KataTransport } from '../app/core/transport/kata-transport';
import { MOCK_WORKSPACE_FOLDER } from '../app/lib/sdlc-mock';

/** Every change of a system as the plugin reports it, from the one read the home makes. */
export async function readAllChanges(transport: KataTransport, folder = MOCK_WORKSPACE_FOLDER, system = 'commerce'): Promise<ChangeView[]> {
  return (await transport.sdlcState(folder, [system])).systems.flatMap((v) => v.changes);
}

/** The change as the plugin reports it, standing at another stage. Only the stage changes; the actions are the ones the answer listed. */
export const atStage = (view: ChangeView, stage: OfferStage): ChangeView => ({ ...view, offer: { ...view.offer, stage } });
