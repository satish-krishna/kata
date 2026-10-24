import { areasOnShow, bringBack, canTuck, defaultArrangement, fitSizes, place, resize, tuck, whereIs, type Arrangement } from './build-layout';

const sizes = { left: 300, right: 360, bottom: 200 };
const arr = (over: Partial<Arrangement>): Arrangement => ({ middle: 'tasks', left: [], right: [], bottom: [], tucked: [], sizes: { ...sizes }, ...over });

describe('build-layout', () => {
  describe('defaultArrangement', () => {
    it('overview', () => {
      expect(defaultArrangement('overview')).toEqual({
        middle: 'tasks',
        left: [],
        right: ['activity'],
        bottom: [],
        tucked: [
          { area: 'files', edge: 'right', back: 'right' },
          { area: 'findings', edge: 'right', back: 'right' },
        ],
        sizes: { left: 300, right: 520, bottom: 200 },
      });
    });
    it('watch', () => {
      expect(defaultArrangement('watch')).toEqual({
        middle: 'activity',
        left: ['tasks'],
        right: [],
        bottom: [],
        tucked: [
          { area: 'files', edge: 'right', back: 'right' },
          { area: 'findings', edge: 'right', back: 'right' },
        ],
        sizes: { left: 300, right: 360, bottom: 200 },
      });
    });
    it('changes', () => {
      expect(defaultArrangement('changes')).toEqual({
        middle: 'files',
        left: [],
        right: [],
        bottom: ['activity'],
        tucked: [
          { area: 'tasks', edge: 'right', back: 'right' },
          { area: 'findings', edge: 'right', back: 'right' },
        ],
        sizes: { left: 300, right: 360, bottom: 200 },
      });
    });
    it('review', () => {
      expect(defaultArrangement('review')).toEqual({
        middle: 'files',
        left: ['findings'],
        right: [],
        bottom: [],
        tucked: [
          { area: 'tasks', edge: 'right', back: 'right' },
          { area: 'activity', edge: 'right', back: 'right' },
        ],
        sizes: { left: 380, right: 360, bottom: 200 },
      });
    });
    it('returns a fresh object each call', () => {
      expect(defaultArrangement('watch')).not.toBe(defaultArrangement('watch'));
    });
  });

  describe('place', () => {
    it('middle to middle is unchanged', () => {
      const a = arr({ middle: 'tasks', right: ['activity'] });
      expect(place(a, 'tasks', 'middle')).toEqual(a);
    });
    it('a side to the middle sends the previous middle to the front of the right stack', () => {
      const a = arr({ middle: 'tasks', left: ['findings'], right: ['activity'] });
      expect(place(a, 'findings', 'middle')).toEqual(arr({ middle: 'findings', left: [], right: ['tasks', 'activity'] }));
    });
    it('a tucked area to the middle sends the previous middle to the front of the right stack', () => {
      const a = arr({ middle: 'tasks', right: ['activity'], tucked: [{ area: 'files', edge: 'right', back: 'right' }] });
      expect(place(a, 'files', 'middle')).toEqual(arr({ middle: 'files', right: ['tasks', 'activity'], tucked: [] }));
    });
    it('a side to the same side is unchanged', () => {
      const a = arr({ middle: 'tasks', left: ['findings', 'activity'] });
      expect(place(a, 'findings', 'left')).toEqual(a);
    });
    it('the middle to a side appends it and refills the middle from the left first', () => {
      const a = arr({ middle: 'tasks', left: ['findings'], right: ['activity'] });
      expect(place(a, 'tasks', 'bottom')).toEqual(arr({ middle: 'findings', left: [], right: ['activity'], bottom: ['tasks'] }));
    });
    it('the middle to a side with no other area in a stack is unchanged', () => {
      const a = arr({ middle: 'tasks', tucked: [{ area: 'files', edge: 'right', back: 'right' }] });
      expect(place(a, 'tasks', 'left')).toEqual(a);
    });
    it('a side to another side appends to the target stack', () => {
      const a = arr({ middle: 'tasks', left: ['findings'], right: ['activity'] });
      expect(place(a, 'activity', 'left')).toEqual(arr({ middle: 'tasks', left: ['findings', 'activity'], right: [] }));
    });
    it('a tucked area to a side leaves the tucked list and is appended', () => {
      const a = arr({ middle: 'tasks', right: ['activity'], tucked: [{ area: 'files', edge: 'right', back: 'right' }] });
      expect(place(a, 'files', 'right')).toEqual(arr({ middle: 'tasks', right: ['activity', 'files'], tucked: [] }));
    });
  });

  describe('tuck', () => {
    it('a tucked area is unchanged', () => {
      const a = arr({ middle: 'tasks', right: ['activity'], tucked: [{ area: 'files', edge: 'right', back: 'right' }] });
      expect(tuck(a, 'files')).toEqual(a);
    });
    it('the last area in a place is unchanged', () => {
      const a = arr({ middle: 'tasks', tucked: [{ area: 'files', edge: 'right', back: 'right' }] });
      expect(tuck(a, 'tasks')).toEqual(a);
    });
    it('a left area is tucked at the left edge and comes back to the left', () => {
      const a = arr({ middle: 'activity', left: ['tasks'] });
      expect(tuck(a, 'tasks')).toEqual(arr({ middle: 'activity', left: [], tucked: [{ area: 'tasks', edge: 'left', back: 'left' }] }));
    });
    it('a right area is tucked at the right edge', () => {
      const a = arr({ middle: 'tasks', right: ['activity'] });
      expect(tuck(a, 'activity')).toEqual(arr({ middle: 'tasks', right: [], tucked: [{ area: 'activity', edge: 'right', back: 'right' }] }));
    });
    it('a bottom area is tucked at the bottom edge', () => {
      const a = arr({ middle: 'files', bottom: ['activity'] });
      expect(tuck(a, 'activity')).toEqual(arr({ middle: 'files', bottom: [], tucked: [{ area: 'activity', edge: 'bottom', back: 'bottom' }] }));
    });
    it('the middle is tucked at the right edge and the middle is refilled', () => {
      const a = arr({ middle: 'tasks', right: ['activity'] });
      expect(tuck(a, 'tasks')).toEqual(arr({ middle: 'activity', right: [], tucked: [{ area: 'tasks', edge: 'right', back: 'right' }] }));
    });
  });

  describe('canTuck', () => {
    it('is false with one area in a place', () => {
      const a = arr({ middle: 'tasks', tucked: [{ area: 'files', edge: 'right', back: 'right' }] });
      expect(canTuck(a, 'tasks')).toBe(false);
    });
    it('is true with another area in a place', () => {
      expect(canTuck(arr({ middle: 'tasks', right: ['activity'] }), 'tasks')).toBe(true);
      expect(canTuck(arr({ middle: 'tasks', right: ['activity'] }), 'activity')).toBe(true);
    });
  });

  describe('bringBack', () => {
    it('appends a tucked area to the stack named by back', () => {
      const a = arr({ middle: 'files', left: ['findings'], tucked: [{ area: 'tasks', edge: 'right', back: 'left' }] });
      expect(bringBack(a, 'tasks')).toEqual(arr({ middle: 'files', left: ['findings', 'tasks'], tucked: [] }));
    });
    it('leaves an area that is not tucked unchanged', () => {
      const a = arr({ middle: 'files', left: ['findings'] });
      expect(bringBack(a, 'findings')).toEqual(a);
    });
  });

  describe('areasOnShow', () => {
    const a = arr({ middle: 'tasks', left: ['findings', 'files'], right: ['activity'] });
    it('with a focus is only the focus', () => {
      expect(areasOnShow(a, {}, 'files')).toEqual(['files']);
    });
    it('is the middle and the first of each stack', () => {
      expect(areasOnShow(a, {}, null)).toEqual(['tasks', 'findings', 'activity']);
    });
    it('shows the flipped area of a stack', () => {
      expect(areasOnShow(a, { left: 'files' }, null)).toEqual(['tasks', 'files', 'activity']);
    });
    it('ignores a flip naming an area no longer in the stack', () => {
      expect(areasOnShow(a, { left: 'tasks', right: 'files' }, null)).toEqual(['tasks', 'findings', 'activity']);
    });
  });

  describe('whereIs', () => {
    const a = arr({ middle: 'tasks', left: ['findings'], tucked: [{ area: 'files', edge: 'bottom', back: 'bottom' }] });
    it('names the place or the edge', () => {
      expect(whereIs(a, 'tasks')).toEqual({ kind: 'place', place: 'middle' });
      expect(whereIs(a, 'findings')).toEqual({ kind: 'place', place: 'left' });
      expect(whereIs(a, 'files')).toEqual({ kind: 'tucked', edge: 'bottom' });
    });
  });

  describe('fitSizes', () => {
    it('leaves Overview right at 520 on 1280 by 600', () => {
      const a = defaultArrangement('overview');
      expect(fitSizes(a, { width: 1280, height: 600 })).toEqual({ left: 300, right: 520, bottom: 200 });
    });
    it('shrinks the left first at 700 wide with left 400 and right 400', () => {
      const a = arr({ middle: 'files', left: ['tasks'], right: ['activity'], sizes: { left: 400, right: 400, bottom: 200 } });
      expect(fitSizes(a, { width: 700, height: 600 })).toEqual({ left: 160, right: 300, bottom: 200 });
    });
    it('shrinks both to 160 at 500 wide', () => {
      const a = arr({ middle: 'files', left: ['tasks'], right: ['activity'], sizes: { left: 400, right: 400, bottom: 200 } });
      expect(fitSizes(a, { width: 500, height: 600 })).toEqual({ left: 160, right: 160, bottom: 200 });
    });
    it('shrinks a drawn bottom to 170 at 450 high', () => {
      const a = arr({ middle: 'files', bottom: ['activity'] });
      expect(fitSizes(a, { width: 1280, height: 450 })).toEqual({ left: 300, right: 360, bottom: 170 });
    });
    it('does not change the arrangement', () => {
      const a = arr({ middle: 'files', left: ['tasks'], sizes: { left: 400, right: 360, bottom: 200 } });
      fitSizes(a, { width: 500, height: 600 });
      expect(a.sizes).toEqual({ left: 400, right: 360, bottom: 200 });
    });
  });

  describe('resize', () => {
    const a = arr({ middle: 'activity', left: ['tasks'] });
    const room = { width: 1280, height: 600 };
    it('clamps below the minimum side', () => {
      expect(resize(a, 'left', 50, room).sizes.left).toBe(160);
    });
    it('clamps above what leaves the middle its minimum', () => {
      expect(resize(a, 'left', 5000, room).sizes.left).toBe(1040);
    });
    it('keeps the other drawn side at its fitted size', () => {
      const b = arr({ middle: 'activity', left: ['tasks'], right: ['findings'] });
      expect(resize(b, 'left', 5000, room).sizes).toEqual({ left: 680, right: 360, bottom: 200 });
    });
    it('clamps the bottom to leave the row above its minimum', () => {
      const b = arr({ middle: 'files', bottom: ['activity'] });
      expect(resize(b, 'bottom', 5000, room).sizes.bottom).toBe(320);
      expect(resize(b, 'bottom', 10, room).sizes.bottom).toBe(160);
    });
  });
});
