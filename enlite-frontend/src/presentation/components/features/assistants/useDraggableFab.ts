/**
 * useDraggableFab — drag behaviour of the floating assistants button (spec 090).
 * Pointer events only (no drag library). A move up to DRAG_THRESHOLD_PX is a click; beyond it, a drag.
 * The position is written to localStorage ONLY on pointerup, as a fraction of the viewport (DF-4).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, DOMAttributes, PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  DRAG_THRESHOLD_PX,
  FAB_STORAGE_KEY,
  clampFab,
  defaultFab,
  fabFromFraction,
  fractionFromFab,
  parseStoredFraction,
  type FabFraction,
  type Point,
  type Rect,
  type Size,
} from "./fabPosition";

type FabHandlers = Pick<
  DOMAttributes<HTMLButtonElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel"
>;

export interface UseDraggableFab {
  ref: RefObject<HTMLButtonElement>;
  /** undefined = no saved position → the button keeps its default classes (DF-9). */
  style: CSSProperties | undefined;
  handlers: FabHandlers;
  /** true if the last pointerup ended a drag; clears the flag. The button's onClick returns early when true. */
  consumeClick(): boolean;
  /** Button rect (saved or default position) + last measured size; null before the first measurement. */
  fabRect: Rect | null;
  viewport: Size;
  hasCustomPosition: boolean;
  resetPosition(): void;
}

interface DragState {
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  dragging: boolean;
}

function readViewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

function readStoredFraction(): FabFraction | null {
  try {
    return parseStoredFraction(localStorage.getItem(FAB_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function useDraggableFab(): UseDraggableFab {
  const ref = useRef<HTMLButtonElement>(null);
  const drag = useRef<DragState | null>(null);
  const justDragged = useRef(false);
  const [fraction, setFraction] = useState<FabFraction | null>(readStoredFraction);
  const [dragPos, setDragPos] = useState<Point | null>(null);
  const [viewport, setViewport] = useState<Size>(readViewport);
  // Last measurement survives the button unmounting while the panel is open.
  const [size, setSize] = useState<Size | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const onResize = () => {
      setViewport(readViewport());
      measure();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  const pointFor = (clientX: number, clientY: number, d: DragState, fab: Size): Point =>
    clampFab({ left: clientX - d.offsetX, top: clientY - d.offsetY }, fab, readViewport());

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      dragging: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.dragging) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) <= DRAG_THRESHOLD_PX) return;
      d.dragging = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    const fab = size ?? { width: 0, height: 0 };
    setDragPos(pointFor(e.clientX, e.clientY, d, fab));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.dragging) return;
    const fab = size ?? { width: 0, height: 0 };
    const vp = readViewport();
    const next = fractionFromFab(pointFor(e.clientX, e.clientY, d, fab), vp);
    try {
      localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable (private mode etc.) — position lives in memory only.
    }
    setFraction(next);
    setDragPos(null);
    setViewport(vp);
    justDragged.current = true;
  };

  const onPointerCancel = () => {
    drag.current = null;
    setDragPos(null);
  };

  const consumeClick = () => {
    const was = justDragged.current;
    justDragged.current = false;
    return was;
  };

  const resetPosition = () => {
    try {
      localStorage.removeItem(FAB_STORAGE_KEY);
    } catch {
      // ignore — see above.
    }
    setFraction(null);
    setDragPos(null);
  };

  const fab = size ?? { width: 0, height: 0 };
  const saved = fraction ? fabFromFraction(fraction, fab, viewport) : null;
  const pos = dragPos ?? saved;
  const style: CSSProperties | undefined = pos ? { left: pos.left, top: pos.top } : undefined;
  const fabRect: Rect | null = size ? { ...(pos ?? defaultFab(size, viewport)), ...size } : null;

  return {
    ref: ref as RefObject<HTMLButtonElement>,
    style,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    consumeClick,
    fabRect,
    viewport,
    hasCustomPosition: fraction !== null,
    resetPosition,
  };
}
