/**
 * useDraggableFab — spec 090 (T005). Real hook, real jsdom localStorage; the button size is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, fireEvent, act } from "@testing-library/react";
import { useDraggableFab, type UseDraggableFab } from "../useDraggableFab";
import { FAB_STORAGE_KEY } from "../fabPosition";

// jsdom's PointerEvent may drop clientX/clientY; a MouseEvent subclass keeps them.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
vi.stubGlobal("PointerEvent", TestPointerEvent);

let hook: UseDraggableFab;

function Harness() {
  hook = useDraggableFab();
  return <button ref={hook.ref} style={hook.style} data-testid="fab" {...hook.handlers} />;
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

function mount() {
  const utils = render(<Harness />);
  return { ...utils, fab: utils.getByTestId("fab") };
}

const pt = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 });

beforeEach(() => {
  localStorage.clear();
  setViewport(1000, 800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 928, top: 728, width: 56, height: 56, right: 984, bottom: 784, x: 928, y: 728, toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDraggableFab", () => {
  it("(a) a 3px move is a click: consumeClick false and nothing saved", () => {
    const { fab } = mount();
    fireEvent.pointerDown(fab, pt(950, 750));
    fireEvent.pointerMove(fab, pt(953, 750));
    fireEvent.pointerUp(fab, pt(953, 750));
    expect(hook.consumeClick()).toBe(false);
    expect(localStorage.getItem(FAB_STORAGE_KEY)).toBeNull();
    expect(hook.style).toBeUndefined();
  });

  it("(b) a 50px move is a drag: consumeClick true (once) and the key is saved", () => {
    const { fab } = mount();
    fireEvent.pointerDown(fab, pt(950, 750));
    fireEvent.pointerMove(fab, pt(900, 750));
    expect(localStorage.getItem(FAB_STORAGE_KEY)).toBeNull(); // nothing written on pointermove
    fireEvent.pointerUp(fab, pt(900, 750));
    expect(hook.consumeClick()).toBe(true);
    expect(hook.consumeClick()).toBe(false);
    const saved = JSON.parse(localStorage.getItem(FAB_STORAGE_KEY) as string) as { x: number; y: number };
    expect(saved.x).toBeCloseTo((900 - 22) / 1000);
    expect(saved.y).toBeCloseTo(728 / 800);
    expect(hook.hasCustomPosition).toBe(true);
    expect(hook.style).toEqual({ left: 878, top: 728 });
  });

  it("(c) invalid stored value gives no style", () => {
    localStorage.setItem(FAB_STORAGE_KEY, "not-json{");
    mount();
    expect(hook.style).toBeUndefined();
    expect(hook.hasCustomPosition).toBe(false);
  });

  it("(d) a smaller viewport re-clamps the saved position", () => {
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ x: 0.9, y: 0.9 }));
    mount();
    expect(hook.style).toEqual({ left: 900, top: 720 });
    act(() => {
      setViewport(500, 400);
      window.dispatchEvent(new Event("resize"));
    });
    expect(hook.viewport).toEqual({ width: 500, height: 400 });
    expect(hook.style).toEqual({ left: 500 - 16 - 56, top: 400 - 16 - 56 });
  });

  it("(e) resetPosition removes the key and clears hasCustomPosition", () => {
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ x: 0.5, y: 0.5 }));
    mount();
    expect(hook.hasCustomPosition).toBe(true);
    act(() => hook.resetPosition());
    expect(localStorage.getItem(FAB_STORAGE_KEY)).toBeNull();
    expect(hook.hasCustomPosition).toBe(false);
    expect(hook.style).toBeUndefined();
  });

  it("(f) localStorage.setItem throwing does not crash the drag", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { fab } = mount();
    fireEvent.pointerDown(fab, pt(950, 750));
    fireEvent.pointerMove(fab, pt(900, 750));
    expect(() => fireEvent.pointerUp(fab, pt(900, 750))).not.toThrow();
    expect(hook.consumeClick()).toBe(true);
    expect(hook.style).toBeDefined(); // kept in memory
  });

  it("(g) captures the pointer at pointerdown, before any move (fast drag)", () => {
    const { fab } = mount();
    const set = vi.fn();
    const release = vi.fn();
    Object.assign(fab, { setPointerCapture: set, releasePointerCapture: release });
    fireEvent.pointerDown(fab, pt(950, 750));
    expect(set).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(fab, pt(100, 100));
    fireEvent.pointerUp(fab, pt(100, 100));
    expect(set).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(1);
  });

  it("(h) measures the button when it mounts AFTER the hook's first render", () => {
    setViewport(800, 600);
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ x: 0.88, y: 0.5 }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 131, height: 48, right: 131, bottom: 48, x: 0, y: 0, toJSON: () => ({}),
    });
    let setShow: (v: boolean) => void = () => {};
    function LateHarness() {
      const [show, set] = useState(false);
      setShow = set;
      hook = useDraggableFab();
      return show ? <button ref={hook.ref} style={hook.style} data-testid="fab" /> : null;
    }
    render(<LateHarness />);
    expect(hook.fabRect).toBeNull();
    act(() => setShow(true));
    expect(hook.fabRect).not.toBeNull();
    expect(hook.fabRect?.width).toBe(131);
    expect(hook.fabRect!.left + 131).toBeLessThanOrEqual(800 - 16);
  });
});
