import { splitStep } from './step-view';

describe('splitStep', () => {
  it('splits a step into its keyword and the rest', () => {
    expect(splitStep('Given a product with 10 photos')).toEqual(['Given', 'a product with 10 photos']);
    expect(splitStep('And it stays')).toEqual(['And', 'it stays']);
  });
});
