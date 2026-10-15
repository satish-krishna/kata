import { Component } from '@angular/core';
import { HlmInput } from '@spartan-ng/helm/input';
import { render } from '../../testing/render';
import { Field } from './field';

@Component({
  imports: [Field, HlmInput],
  template: `<app-field label="Task" key="task" hint="required" [error]="true"><input hlmInput id="x" /></app-field>`,
})
class Host {}

describe('Field', () => {
  it('renders label, key, projected control and error hint', async () => {
    const { container } = await render(Host);
    expect(container.querySelector('.k-field__label')!.textContent).toContain('Task');
    expect(container.querySelector('.k-field__label code')!.textContent).toBe('task');
    expect(container.querySelector('.k-field input#x')).not.toBeNull();
    expect(container.querySelector('.k-field__hint--error')!.textContent).toBe('required');
  });
});
