// Window geometry for the floating launcher, as pure functions (no Electron imports) so it is unit-tested.
// All values are in DIPs (device-independent pixels), which is what Electron's window and screen APIs use, so
// per-monitor scaling needs no special cases here.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  /** The display minus taskbars, docks and menu bars. */
  workArea: Rect;
}

export type Anchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const BUBBLE = 64;
/** Movement beyond this many DIPs turns a press into a drag. */
export const DRAG_THRESHOLD = 5;
/** A press held longer than this without moving is still a click (no long-press behaviour). */
export const MARGIN = 8;

export function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** The display a point is on, or the nearest one. */
export function displayFor(displays: DisplayInfo[], p: { x: number; y: number }): DisplayInfo {
  const inside = displays.find((d) => contains(d.bounds, p));
  if (inside) return inside;
  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const cx = Math.max(d.bounds.x, Math.min(p.x, d.bounds.x + d.bounds.width));
    const cy = Math.max(d.bounds.y, Math.min(p.y, d.bounds.y + d.bounds.height));
    const dist = (cx - p.x) ** 2 + (cy - p.y) ** 2;
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/** Keep a rectangle inside an area (shrinking it if the area is smaller), with a margin. */
export function clampRect(r: Rect, area: Rect, margin = MARGIN): Rect {
  const width = Math.min(r.width, area.width - 2 * margin);
  const height = Math.min(r.height, area.height - 2 * margin);
  const x = Math.min(Math.max(r.x, area.x + margin), area.x + area.width - margin - width);
  const y = Math.min(Math.max(r.y, area.y + margin), area.y + area.height - margin - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * Where a panel opens from the bubble: toward the side of the screen with more room, horizontally and vertically,
 * with the bubble at the anchored corner, clamped into the work area so it is never off-screen.
 */
export function panelBounds(bubble: Rect, size: { width: number; height: number }, workArea: Rect): { bounds: Rect; anchor: Anchor } {
  const c = center(bubble);
  const roomRight = workArea.x + workArea.width - bubble.x;
  const roomLeft = bubble.x + bubble.width - workArea.x;
  const roomDown = workArea.y + workArea.height - bubble.y;
  const roomUp = bubble.y + bubble.height - workArea.y;
  const growRight = roomRight >= size.width || roomRight >= roomLeft;
  const growDown = roomDown >= size.height || roomDown >= roomUp;
  const x = growRight ? bubble.x : bubble.x + bubble.width - size.width;
  const y = growDown ? bubble.y : bubble.y + bubble.height - size.height;
  void c;
  const anchor: Anchor = `${growDown ? 'top' : 'bottom'}-${growRight ? 'left' : 'right'}` as Anchor;
  return { bounds: clampRect({ x, y, width: size.width, height: size.height }, workArea), anchor };
}

/** The bubble's place when a panel collapses: the anchored corner of the panel. */
export function bubbleFromPanel(panel: Rect, anchor: Anchor): Rect {
  const x = anchor.endsWith('left') ? panel.x : panel.x + panel.width - BUBBLE;
  const y = anchor.startsWith('top') ? panel.y : panel.y + panel.height - BUBBLE;
  return { x, y, width: BUBBLE, height: BUBBLE };
}

/** The smallest rectangle containing both (the window size while morphing between two panel shapes). */
export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Saved bubble position: which display, and where on it as fractions of its work area (survives resolution changes). */
export interface SavedPosition {
  displayId: number;
  fx: number;
  fy: number;
}

export function savePosition(bubble: Rect, displays: DisplayInfo[]): SavedPosition {
  const d = displayFor(displays, center(bubble));
  const wa = d.workArea;
  const fx = (bubble.x - wa.x) / Math.max(1, wa.width - bubble.width);
  const fy = (bubble.y - wa.y) / Math.max(1, wa.height - bubble.height);
  return { displayId: d.id, fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
}

/**
 * Put the bubble back: on its display if that still exists, else on the primary display at the same relative
 * place; always inside a work area. `primary` is the first display when absent.
 */
export function restorePosition(saved: SavedPosition | null, displays: DisplayInfo[], primaryId?: number): Rect {
  const primary = displays.find((d) => d.id === primaryId) ?? displays[0];
  if (!saved) {
    const wa = primary.workArea;
    return { x: wa.x + wa.width - BUBBLE - 24, y: wa.y + Math.round(wa.height * 0.6), width: BUBBLE, height: BUBBLE };
  }
  const d = displays.find((x) => x.id === saved.displayId) ?? primary;
  const wa = d.workArea;
  const r = { x: wa.x + saved.fx * (wa.width - BUBBLE), y: wa.y + saved.fy * (wa.height - BUBBLE), width: BUBBLE, height: BUBBLE };
  return clampRect(r, wa, 0);
}

/** Keep a bubble that is (partly) off every display fully on the nearest one. */
export function keepOnScreen(bubble: Rect, displays: DisplayInfo[]): Rect {
  const d = displayFor(displays, center(bubble));
  return clampRect(bubble, d.workArea, 0);
}

/** Press → move → release: a click unless the pointer moved past the threshold. */
export class PressTracker {
  private start: { x: number; y: number } | null = null;
  dragging = false;
  get startX(): number | undefined {
    return this.start?.x;
  }
  get startY(): number | undefined {
    return this.start?.y;
  }
  down(x: number, y: number): void {
    this.start = { x, y };
    this.dragging = false;
  }
  /** Returns true when this move starts a drag. */
  move(x: number, y: number): boolean {
    if (!this.start || this.dragging) return false;
    if (Math.hypot(x - this.start.x, y - this.start.y) > DRAG_THRESHOLD) {
      this.dragging = true;
      return true;
    }
    return false;
  }
  /** 'click', 'drag-end', or null when there was no press. */
  up(): 'click' | 'drag-end' | null {
    if (!this.start) return null;
    const r = this.dragging ? 'drag-end' : 'click';
    this.start = null;
    this.dragging = false;
    return r;
  }
}
