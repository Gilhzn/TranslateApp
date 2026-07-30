/**
 * Drag tracking for the drop zone.
 *
 * `dragleave` fires every time the pointer crosses into a *child* element, so
 * the naive `onDragEnter -> true / onDragLeave -> false` implementation flickers
 * the whole time the user hovers over the zone's own icon and text. The fix is
 * a depth counter: enter increments, leave decrements, and the zone is only
 * inactive once the count returns to zero.
 *
 * Kept as a pure transition function so the counter can be tested without a DOM.
 */

export interface DragState {
  /** Net dragenter/dragleave depth. Never negative. */
  readonly depth: number;
  /** True while a drag is over the zone or any of its descendants. */
  readonly active: boolean;
}

export const DRAG_IDLE: DragState = Object.freeze({ depth: 0, active: false });

export type DragSignal = "enter" | "leave" | "drop" | "reset";

export function dragTransition(state: DragState, signal: DragSignal): DragState {
  switch (signal) {
    case "enter": {
      const depth = state.depth + 1;
      return { depth, active: true };
    }
    case "leave": {
      // Clamp: browsers occasionally deliver a leave without a matching enter
      // (drag started inside the zone, or the drag left the window entirely).
      const depth = Math.max(0, state.depth - 1);
      return { depth, active: depth > 0 };
    }
    case "drop":
    case "reset":
      return DRAG_IDLE;
  }
}

/**
 * True when a drag payload actually contains files.
 *
 * `DataTransfer.types` is the only thing readable during dragover — the file
 * list itself is protected until drop — so selecting text and dragging it
 * across the zone must not light it up.
 */
export function carriesFiles(types: readonly string[] | undefined | null): boolean {
  if (!types) return false;
  for (const type of types) {
    if (type === "Files") return true;
  }
  return false;
}
