import { TestBed } from '@angular/core/testing';
import type { Versions } from '@bindings/Versions';
import { KataTransport } from '../transport/kata-transport';
import { MockTransport } from '../transport/mock-transport';
import { VersionsStore } from './versions.store';

describe('VersionsStore', () => {
  const found = (version: string): Versions => ({
    workbench: '3.3.0',
    aiSdlc: { kind: 'found', version },
    line: `Workbench 3.3.0 · ai-sdlc ${version}`,
    copy: `Kata Workbench 3.3.0, ai-sdlc ${version}`,
  });

  it('keeps the answer of the newest refresh when an older one finishes last', async () => {
    const transport = new MockTransport();
    let resolveA!: (v: Versions) => void;
    let resolveB!: (v: Versions) => void;
    vi.spyOn(transport, 'appVersions')
      .mockReturnValueOnce(new Promise<Versions>((r) => (resolveA = r)))
      .mockReturnValueOnce(new Promise<Versions>((r) => (resolveB = r)));
    TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useValue: transport }] });
    const store = TestBed.inject(VersionsStore);

    const a = store.refresh();
    const b = store.refresh();
    resolveB(found('1.4.0'));
    await b;
    resolveA(found('1.3.0'));
    await a;

    expect(store.versions()).toEqual(found('1.4.0'));
  });
});
