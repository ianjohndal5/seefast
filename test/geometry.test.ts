// Launcher window geometry (app/src/geometry.ts): pure functions, tested without Electron.
import { describe, expect, it } from 'vitest';
import { BUBBLE, PressTracker, bubbleFromPanel, clampRect, displayFor, keepOnScreen, panelBounds, restorePosition, savePosition, union, type DisplayInfo } from '../app/src/geometry.js';

const wa = { x: 0, y: 0, width: 1920, height: 1040 };
const size = { width: 440, height: 640 };
const bubbleAt = (x: number, y: number) => ({ x, y, width: BUBBLE, height: BUBBLE });

describe('panels open toward the side with room, never off-screen', () => {
  it.each([
    ['top-left corner', 20, 20, 'top-left'],
    ['top-right corner', 1830, 20, 'top-right'],
    ['bottom-left corner', 20, 960, 'bottom-left'],
    ['bottom-right corner', 1830, 960, 'bottom-right'],
  ])('%s', (_n, x, y, anchor) => {
    const r = panelBounds(bubbleAt(x, y), size, wa);
    expect(r.anchor).toBe(anchor);
    expect(r.bounds.x).toBeGreaterThanOrEqual(wa.x);
    expect(r.bounds.y).toBeGreaterThanOrEqual(wa.y);
    expect(r.bounds.x + r.bounds.width).toBeLessThanOrEqual(wa.x + wa.width);
    expect(r.bounds.y + r.bounds.height).toBeLessThanOrEqual(wa.y + wa.height);
  });
  it('keeps the bubble at the anchored corner when there is room', () => {
    const b = bubbleAt(1830, 960);
    const r = panelBounds(b, size, wa);
    expect(bubbleFromPanel(r.bounds, r.anchor)).toEqual(b);
  });
  it('shrinks a panel that does not fit a small screen', () => {
    const small = { x: 0, y: 0, width: 400, height: 500 };
    const r = panelBounds(bubbleAt(10, 10), size, small);
    expect(r.bounds.width).toBeLessThanOrEqual(400 - 16);
    expect(r.bounds.height).toBeLessThanOrEqual(500 - 16);
  });
  it('works on a monitor left of and above the primary (negative coordinates)', () => {
    const left = { x: -1280, y: -200, width: 1280, height: 1024 };
    const r = panelBounds(bubbleAt(-80, 700), size, left);
    expect(r.anchor).toBe('bottom-right');
    expect(r.bounds.x).toBeGreaterThanOrEqual(-1280);
    expect(r.bounds.x + r.bounds.width).toBeLessThanOrEqual(0);
  });
  it('morphs between shapes inside the union of both rectangles', () => {
    expect(union({ x: 10, y: 10, width: 100, height: 100 }, { x: 50, y: 0, width: 100, height: 50 })).toEqual({ x: 10, y: 0, width: 140, height: 110 });
    expect(clampRect({ x: -50, y: 5000, width: 100, height: 100 }, wa)).toEqual({ x: 8, y: 1040 - 8 - 100, width: 100, height: 100 });
  });
});

describe('the bubble stays visible when monitors change', () => {
  const primary: DisplayInfo = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const second: DisplayInfo = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 25, width: 2560, height: 1415 } };
  it('remembers the display and the relative position', () => {
    const b = bubbleAt(1920 + 2560 - 100, 25 + 700);
    const saved = savePosition(b, [primary, second]);
    expect(saved.displayId).toBe(2);
    expect(restorePosition(saved, [primary, second])).toEqual(b);
  });
  it('moves to the primary display at the same relative place when its display is gone', () => {
    const saved = savePosition(bubbleAt(1920 + 2560 - 64, 25 + 1415 - 64), [primary, second]);
    const r = restorePosition(saved, [primary], 1);
    expect(r).toEqual({ x: 1920 - 64, y: 1040 - 64, width: 64, height: 64 });
  });
  it('follows a resolution change on the same display', () => {
    const saved = savePosition(bubbleAt(1920 - 64, 520), [primary]);
    const smaller: DisplayInfo = { ...primary, bounds: { x: 0, y: 0, width: 1280, height: 720 }, workArea: { x: 0, y: 0, width: 1280, height: 680 } };
    const r = restorePosition(saved, [smaller]);
    expect(r.x).toBe(1280 - 64);
    expect(r.y + 64).toBeLessThanOrEqual(680);
  });
  it('pulls a bubble that ended up off every screen back onto the nearest one', () => {
    expect(keepOnScreen(bubbleAt(5000, -300), [primary, second])).toEqual({ x: 1920 + 2560 - 64, y: 25, width: 64, height: 64 });
    expect(displayFor([primary, second], { x: 1900, y: 500 }).id).toBe(1);
  });
  it('places a first-time bubble on the right of the primary display', () => {
    const r = restorePosition(null, [primary, second], 1);
    expect(r.x + r.width).toBeLessThanOrEqual(1920);
  });
});

describe('a drag is never a click', () => {
  it('small jitter is still a click', () => {
    const t = new PressTracker();
    t.down(100, 100);
    expect(t.move(103, 102)).toBe(false);
    expect(t.up()).toBe('click');
  });
  it('moving past the threshold starts a drag once and ends as a drag', () => {
    const t = new PressTracker();
    t.down(100, 100);
    expect(t.move(110, 100)).toBe(true);
    expect(t.move(150, 100)).toBe(false);
    expect(t.move(101, 100)).toBe(false); // coming back does not turn it into a click
    expect(t.up()).toBe('drag-end');
  });
  it('a release without a press is nothing', () => {
    expect(new PressTracker().up()).toBeNull();
  });
});
