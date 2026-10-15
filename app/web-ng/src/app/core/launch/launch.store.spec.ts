import { TestBed } from '@angular/core/testing';
import type { RunSpec } from '@bindings/RunSpec';
import { LaunchStore } from './launch.store';

const s = { schema: 1, name: 'k', task: 't', workdir: '/w' } as RunSpec;

describe('LaunchStore', () => {
  it('take returns the set payload once, then null', () => {
    const store = TestBed.inject(LaunchStore);
    expect(store.take()).toBeNull();
    store.set({ spec: s, autorun: true });
    const got = store.take();
    expect(got?.spec.name).toBe('k');
    expect(got?.autorun).toBe(true);
    expect(store.take()).toBeNull();
  });
});
