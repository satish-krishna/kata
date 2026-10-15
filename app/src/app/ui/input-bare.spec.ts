import { render } from '../../testing/render';
import { Component } from '@angular/core';
import { HlmInput } from '@spartan-ng/helm/input';

@Component({ selector: 'app-probe', imports: [HlmInput], template: `<input hlmInput variant="bare" class="wb-x" /><input hlmInput />` })
class Probe {}

describe('hlmInput bare', () => {
  it('emits no utilities for bare and leaves the default intact', async () => {
    const { container } = await render(Probe);
    const [bare, dflt] = Array.from(container.querySelectorAll('input'));
    expect(bare.className.trim()).toBe('wb-x');
    expect(dflt.className).toContain('h-(--control-h)');
  });
});
