import { buttonVariants } from '@spartan-ng/helm/button';

describe('buttonVariants bare', () => {
  it('emits no appearance or sizing utilities', () => {
    expect(buttonVariants({ variant: 'bare', size: 'bare' })).toBe('');
  });

  it('leaves the existing variants intact', () => {
    expect(buttonVariants({ variant: 'primary', size: 'default' })).toContain('k-btn--primary');
    expect(buttonVariants({ variant: 'ghost', size: 'icon-sm' })).toContain('size-(--control-h-sm)');
  });
});
