/**
 * fabPosition — spec 090 (§9.2). Pure rules; every expected value is written by hand, never computed by the function.
 */
import { describe, it, expect } from "vitest";
import {
  clampFab,
  defaultFab,
  fabFromFraction,
  fractionFromFab,
  parseStoredFraction,
  placePanel,
} from "../fabPosition";

const VP = { width: 1280, height: 800 };
const FAB = { width: 132, height: 48 };
const rect = (left: number, top: number) => ({ left, top, ...FAB });

describe("defaultFab / placePanel (default corner)", () => {
  it("default button sits in the bottom-right corner", () => {
    expect(defaultFab(FAB, VP)).toEqual({ left: 1132, top: 736 });
  });

  it("panel from the default button equals today's CSS (bottom 16, right 16)", () => {
    expect(placePanel(rect(1132, 736), VP)).toEqual({ left: 908, top: 304, width: 356, height: 480, opensDown: false });
  });
});

describe("placePanel (corners)", () => {
  it("top-left: opens down, aligned to the button's left", () => {
    const p = placePanel(rect(16, 16), VP);
    expect(p.opensDown).toBe(true);
    expect(p.top).toBe(16);
    expect(p.left).toBe(16);
  });

  it("bottom-left: opens up, panel bottom = 784", () => {
    const p = placePanel(rect(16, 736), VP);
    expect(p.opensDown).toBe(false);
    expect(p.left).toBe(16);
    expect(p.top + p.height).toBe(784);
  });

  it("top-right: opens down, panel right edge = 1264", () => {
    const p = placePanel(rect(1132, 16), VP);
    expect(p.opensDown).toBe(true);
    expect(p.left + p.width).toBe(1264);
  });

  it("short window: tie between above and below opens up with the available height", () => {
    const p = placePanel(rect(16, 176), { width: 1280, height: 400 });
    expect(p).toEqual({ left: 16, top: 16, width: 356, height: 208, opensDown: false });
  });
});

describe("clampFab", () => {
  it("brings a point outside the screen back inside the margin", () => {
    expect(clampFab({ left: -50, top: 2000 }, FAB, VP)).toEqual({ left: 16, top: 736 });
  });

  it("keeps a point already inside untouched", () => {
    expect(clampFab({ left: 300, top: 200 }, FAB, VP)).toEqual({ left: 300, top: 200 });
  });

  it("viewport smaller than the button falls back to the margin", () => {
    expect(clampFab({ left: 500, top: 500 }, FAB, { width: 100, height: 40 })).toEqual({ left: 16, top: 16 });
  });
});

describe("parseStoredFraction", () => {
  it.each([[null], ["abc"], ['{"x":2,"y":0.5}']])("rejects %s", (raw) => {
    expect(parseStoredFraction(raw)).toBeNull();
  });

  it("accepts a valid fraction", () => {
    expect(parseStoredFraction('{"x":0.25,"y":0.5}')).toEqual({ x: 0.25, y: 0.5 });
  });
});

describe("fraction round trip", () => {
  it("fabFromFraction(fractionFromFab(p)) returns p for points inside the screen", () => {
    for (const p of [{ left: 16, top: 16 }, { left: 640, top: 400 }, { left: 1132, top: 736 }]) {
      expect(fabFromFraction(fractionFromFab(p, VP), FAB, VP)).toEqual(p);
    }
  });
});
