import { describe, expect, it } from "vitest";
import {
  buildOffsets,
  computeWindow,
  indexAtOffset,
  scrollToIndex,
  uniformOffsets,
} from "./windowing";

const ROW = 34;
const DETAIL = 260;

describe("offsets", () => {
  it("accumulates uniform rows", () => {
    const offsets = uniformOffsets(5, ROW);
    expect(Array.from(offsets)).toEqual([0, 34, 68, 102, 136, 170]);
  });

  it("adds the detail panel height to expanded rows only", () => {
    const offsets = buildOffsets(4, ROW, DETAIL, (i) => i === 1);
    expect(Array.from(offsets)).toEqual([0, 34, 34 + ROW + DETAIL, 362, 396]);
  });

  it("handles an empty list", () => {
    const offsets = buildOffsets(0, ROW, DETAIL, () => false);
    expect(Array.from(offsets)).toEqual([0]);
    expect(computeWindow(offsets, 0, 500)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: 0,
      totalHeight: 0,
    });
  });
});

describe("indexAtOffset", () => {
  const offsets = uniformOffsets(100, ROW);

  it("finds the row containing a pixel offset", () => {
    expect(indexAtOffset(offsets, 0)).toBe(0);
    expect(indexAtOffset(offsets, 33)).toBe(0);
    expect(indexAtOffset(offsets, 34)).toBe(1);
    expect(indexAtOffset(offsets, 35)).toBe(1);
    expect(indexAtOffset(offsets, 34 * 42 + 5)).toBe(42);
  });

  it("clamps out-of-range offsets", () => {
    expect(indexAtOffset(offsets, -500)).toBe(0);
    expect(indexAtOffset(offsets, 1_000_000)).toBe(99);
  });

  it("agrees with a linear scan for mixed heights", () => {
    const mixed = buildOffsets(200, ROW, DETAIL, (i) => i % 7 === 0);
    const total = mixed[200] ?? 0;
    for (let y = 0; y < total; y += 13) {
      let expected = 0;
      for (let i = 0; i < 200; i++) {
        if ((mixed[i] ?? 0) <= y) expected = i;
        else break;
      }
      expect(indexAtOffset(mixed, y)).toBe(expected);
    }
  });
});

describe("computeWindow", () => {
  const offsets = uniformOffsets(1000, ROW);

  it("renders only the visible slice plus overscan", () => {
    const slice = computeWindow(offsets, 0, 680, 8);
    expect(slice.start).toBe(0);
    // 680 / 34 = 20 visible rows, plus overscan on the trailing edge.
    expect(slice.end).toBe(29);
    expect(slice.end - slice.start).toBeLessThan(40);
  });

  it("keeps total height constant regardless of scroll position", () => {
    const a = computeWindow(offsets, 0, 680);
    const b = computeWindow(offsets, 12_000, 680);
    expect(a.totalHeight).toBe(34_000);
    expect(b.totalHeight).toBe(34_000);
  });

  it("pads so the scrollbar and the rows agree at every position", () => {
    for (const scrollTop of [0, 100, 4_321, 20_000, 33_999]) {
      const slice = computeWindow(offsets, scrollTop, 680);
      const rendered = (offsets[slice.end] ?? 0) - (offsets[slice.start] ?? 0);
      expect(slice.padTop + rendered + slice.padBottom).toBe(slice.totalHeight);
    }
  });

  it("always covers the viewport", () => {
    for (const scrollTop of [0, 999, 5_000, 33_000]) {
      const slice = computeWindow(offsets, scrollTop, 680, 0);
      expect(offsets[slice.start] ?? 0).toBeLessThanOrEqual(scrollTop);
      expect(offsets[slice.end] ?? 0).toBeGreaterThanOrEqual(
        Math.min(scrollTop + 680, slice.totalHeight),
      );
    }
  });

  it("clamps a scroll position past the end of the list", () => {
    const slice = computeWindow(offsets, 999_999, 680);
    expect(slice.end).toBe(1000);
    expect(slice.padBottom).toBe(0);
  });

  it("survives an expanded row inside the window", () => {
    const mixed = buildOffsets(500, ROW, DETAIL, (i) => i === 30);
    const slice = computeWindow(mixed, 34 * 25, 680);
    expect(slice.start).toBeLessThanOrEqual(30);
    expect(slice.end).toBeGreaterThan(30);
    const rendered = (mixed[slice.end] ?? 0) - (mixed[slice.start] ?? 0);
    expect(slice.padTop + rendered + slice.padBottom).toBe(slice.totalHeight);
  });
});

describe("scrollToIndex", () => {
  const offsets = uniformOffsets(1000, ROW);

  it("returns null when the row is already visible", () => {
    expect(scrollToIndex(offsets, 5, 0, 680)).toBeNull();
  });

  it("scrolls up to reveal a row above the viewport", () => {
    expect(scrollToIndex(offsets, 10, 1_000, 680)).toBe(340);
  });

  it("scrolls down just far enough to reveal a row below it", () => {
    expect(scrollToIndex(offsets, 30, 0, 680)).toBe(34 * 31 - 680);
  });

  it("accounts for a sticky header covering the top of the box", () => {
    expect(scrollToIndex(offsets, 10, 350, 680, 40)).toBe(300);
  });

  it("refuses an out-of-range index", () => {
    expect(scrollToIndex(offsets, -1, 0, 680)).toBeNull();
    expect(scrollToIndex(offsets, 1000, 0, 680)).toBeNull();
  });
});
