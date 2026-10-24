import { layoutKeyFor, type LayoutKey } from './build-layout-keys';

const key = (k: string, mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const ctrl = { ctrlKey: true };

describe('layoutKeyFor', () => {
  const cases: [string, ReturnType<typeof key>, LayoutKey | null][] = [
    ['Ctrl+1', key('1', ctrl), { kind: 'mode', mode: 'overview' }],
    ['Ctrl+2', key('2', ctrl), { kind: 'mode', mode: 'watch' }],
    ['Ctrl+3', key('3', ctrl), { kind: 'mode', mode: 'changes' }],
    ['Ctrl+4', key('4', ctrl), { kind: 'mode', mode: 'review' }],
    ['Cmd+1', key('1', { metaKey: true }), { kind: 'mode', mode: 'overview' }],
    ['Esc', key('Escape'), { kind: 'unfocus' }],
    ['1 alone', key('1'), null],
    ['Ctrl+Alt+1', key('1', { ctrlKey: true, altKey: true }), null],
    ['Ctrl+Shift+1', key('1', { ctrlKey: true, shiftKey: true }), null],
    ['Ctrl+5', key('5', ctrl), null],
    ['Ctrl+0', key('0', ctrl), null],
    ['Ctrl+A', key('a', ctrl), null],
    ['Ctrl+Esc', key('Escape', ctrl), null],
    ['Shift+Esc', key('Escape', { shiftKey: true }), null],
    ['Enter', key('Enter'), null],
  ];
  for (const [name, event, expected] of cases) {
    it(`${name} gives ${JSON.stringify(expected)}`, () => {
      expect(layoutKeyFor(event)).toEqual(expected);
    });
  }
});
