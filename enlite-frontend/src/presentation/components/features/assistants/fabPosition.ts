/**
 * fabPosition — pure rules for the floating assistants button and its panel (spec 090).
 * The saved position is the button's top-left corner as a FRACTION of the viewport, so it survives resizes.
 * The button always stays fully on screen (margin 16px); the panel opens to the side with more room (DF-6).
 */
export const FAB_MARGIN = 16;
export const PANEL_SIZE = { width: 356, height: 480 } as const;
export const DESKTOP_MIN_WIDTH = 640; // Tailwind `sm`
export const DRAG_THRESHOLD_PX = 5;
export const FAB_STORAGE_KEY = "enlite.assistants.fabPosition.v1";

export interface Size { width: number; height: number }
export interface Point { left: number; top: number }
export interface Rect extends Point, Size {}
export interface FabFraction { x: number; y: number } // top-left corner / viewport, each in [0,1]
export interface PanelPlacement extends Rect { opensDown: boolean }

function clampAxis(v: number, min: number, max: number): number {
  // A negative range (viewport smaller than the element) falls back to the margin.
  if (max < min) return min;
  return Math.min(Math.max(v, min), max);
}

/** left ∈ [M, vw-M-w], top ∈ [M, vh-M-h]; a negative range (viewport smaller than the button) uses M. */
export function clampFab(p: Point, fab: Size, vp: Size, margin = FAB_MARGIN): Point {
  return {
    left: clampAxis(p.left, margin, vp.width - margin - fab.width),
    top: clampAxis(p.top, margin, vp.height - margin - fab.height),
  };
}

/** Bottom-right corner: { left: vw-M-w, top: vh-M-h }. */
export function defaultFab(fab: Size, vp: Size, margin = FAB_MARGIN): Point {
  return { left: vp.width - margin - fab.width, top: vp.height - margin - fab.height };
}

export function fabFromFraction(f: FabFraction, fab: Size, vp: Size): Point {
  return clampFab({ left: f.x * vp.width, top: f.y * vp.height }, fab, vp);
}

export function fractionFromFab(p: Point, vp: Size): FabFraction {
  return { x: p.left / vp.width, y: p.top / vp.height };
}

const inUnit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** JSON {x,y} with two finite numbers in [0,1] → FabFraction; anything else (null, 'abc', {x:2}) → null. */
export function parseStoredFraction(raw: string | null): FabFraction | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { x, y } = v as { x?: unknown; y?: unknown };
    return inUnit(x) && inUnit(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

/** DF-6: opens down only if there is MORE room below the button's top than above its bottom (tie → up). */
export function placePanel(fab: Rect, vp: Size, panel: Size = PANEL_SIZE, margin = FAB_MARGIN): PanelPlacement {
  const width = Math.min(panel.width, vp.width - 2 * margin);
  const spaceBelow = vp.height - margin - fab.top;
  const spaceAbove = fab.top + fab.height - margin;
  const opensDown = spaceBelow > spaceAbove;
  const height = Math.min(panel.height, opensDown ? spaceBelow : spaceAbove);
  const top = opensDown ? fab.top : fab.top + fab.height - height;
  const wanted = fab.left + fab.width / 2 < vp.width / 2 ? fab.left : fab.left + fab.width - width;
  const left = clampAxis(wanted, margin, vp.width - margin - width);
  return { left, top, width, height, opensDown };
}
