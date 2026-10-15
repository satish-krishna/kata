import { Provider, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

/** Mount a standalone component with its inputs set, the way @testing-library's
 *  render() did for the Svelte tests, so ported test bodies stay recognizable. */
export async function render<T>(
  cmp: Type<T>,
  inputs: Record<string, unknown> = {},
  providers: Provider[] = [],
): Promise<{ fixture: ComponentFixture<T>; container: HTMLElement }> {
  TestBed.configureTestingModule({ imports: [cmp], providers });
  const fixture = TestBed.createComponent(cmp);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  await fixture.whenStable();
  return { fixture, container: fixture.nativeElement as HTMLElement };
}
