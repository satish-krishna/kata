import { zoomStepFor } from './zoom-keys';

const key = (k: string, mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey'>> = { ctrlKey: true }) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('zoomStepFor', () => {
  it('maps Ctrl or Cmd with = + - 0 to a zoom step', () => {
    expect(zoomStepFor(key('='))).toBe('in');
    expect(zoomStepFor(key('+'))).toBe('in');
    expect(zoomStepFor(key('-'))).toBe('out');
    expect(zoomStepFor(key('0'))).toBe('reset');
    expect(zoomStepFor(key('=', { metaKey: true }))).toBe('in');
  });

  it('ignores the keys without Ctrl or Cmd, with Alt, and other keys', () => {
    expect(zoomStepFor(key('=', {}))).toBeNull();
    expect(zoomStepFor(key('-', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(zoomStepFor(key('s'))).toBeNull();
  });
});
