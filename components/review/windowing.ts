/**
 * Row windowing — render the visible slice, not the catalog.
 *
 * A 400-key file in eight locales is 3,200 rows, and every row carries a fit
 * meter, badges and an editable cell. Mounting all of them costs seconds; this
 * mounts the ~30 that are on screen plus an overscan margin.
 *
 * Rows are not uniform: an expanded row is a row plus a fixed-height detail
 * panel. Heights are therefore accumulated into a prefix-sum table rather than
 * multiplied, and the detail panel is given a fixed height (it scrolls
 * internally) so that table is exact — a measurement-based virtualiser would
 * need a ResizeObserver per row and would still jitter while scrolling.
 *
 * Pure arithmetic, no DOM: the whole thing is unit-testable.
 */

/**
 * Row height in pixels. Dense by intent — a localisation catalog is read by
 * scanning, and 34px keeps ~20 rows on a laptop screen without crowding the
 * fit meter.
 */
export const ROW_HEIGHT = 34;

/**
 * Height of an expanded row's detail panel. Fixed rather than measured: it
 * makes the offset table exact, so scrolling never jumps, and the panel scrolls
 * internally when a row has more issues than fit.
 */
export const DETAIL_HEIGHT = 268;

export interface WindowSlice {
  /** First row index to render, inclusive. */
  start: number;
  /** Last row index to render, exclusive. */
  end: number;
  /** Spacer height above the rendered slice, in pixels. */
  padTop: number;
  /** Spacer height below the rendered slice, in pixels. */
  padBottom: number;
  /** Height of the full list, in pixels. */
  totalHeight: number;
}

/**
 * Cumulative row offsets: `offsets[i]` is the top of row `i`, and the last
 * element is the total height. Length is always `count + 1`.
 */
export function buildOffsets(
  count: number,
  rowHeight: number,
  expandedHeight: number,
  isExpanded: (index: number) => boolean,
): Float64Array {
  const offsets = new Float64Array(count + 1);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = acc;
    acc += rowHeight + (isExpanded(i) ? expandedHeight : 0);
  }
  offsets[count] = acc;
  return offsets;
}

/** Fast path for a list with nothing expanded — no per-row callback. */
export function uniformOffsets(count: number, rowHeight: number): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i <= count; i++) offsets[i] = i * rowHeight;
  return offsets;
}

/**
 * Index of the row containing pixel offset `y`, clamped into range.
 * Binary search over the prefix sums — O(log n) per scroll event.
 */
export function indexAtOffset(offsets: Float64Array, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  const target = Math.max(0, y);

  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= target) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function computeWindow(
  offsets: Float64Array,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): WindowSlice {
  const count = offsets.length - 1;
  const totalHeight = offsets[count] ?? 0;

  if (count === 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };
  }

  const top = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - 1));
  const firstVisible = indexAtOffset(offsets, top);
  const lastVisible = indexAtOffset(offsets, top + Math.max(0, viewportHeight));

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + overscan + 1);

  return {
    start,
    end,
    padTop: offsets[start] ?? 0,
    padBottom: Math.max(0, totalHeight - (offsets[end] ?? totalHeight)),
    totalHeight,
  };
}

/**
 * Scroll position that brings row `index` fully into view, or `null` when it
 * already is. Keyboard navigation uses this to follow the focus ring.
 */
export function scrollToIndex(
  offsets: Float64Array,
  index: number,
  scrollTop: number,
  viewportHeight: number,
  stickyHeight = 0,
): number | null {
  const count = offsets.length - 1;
  if (index < 0 || index >= count) return null;

  const top = offsets[index] ?? 0;
  const bottom = offsets[index + 1] ?? top;

  // The sticky header floats over the top of the scroll box, so "visible"
  // starts below it.
  if (top - stickyHeight < scrollTop) return Math.max(0, top - stickyHeight);
  if (bottom > scrollTop + viewportHeight) {
    return Math.max(0, bottom - viewportHeight);
  }
  return null;
}
