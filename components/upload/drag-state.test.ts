import { describe, expect, it } from "vitest";
import { DRAG_IDLE, carriesFiles, dragTransition, type DragState } from "./drag-state";

function run(signals: readonly Parameters<typeof dragTransition>[1][]): DragState {
  return signals.reduce<DragState>(
    (state, signal) => dragTransition(state, signal),
    DRAG_IDLE,
  );
}

describe("dragTransition", () => {
  it("activates on the first enter", () => {
    expect(run(["enter"])).toEqual({ depth: 1, active: true });
  });

  it("stays active while crossing into child elements", () => {
    // enter zone -> enter icon -> leave zone-level boundary
    expect(run(["enter", "enter", "leave"]).active).toBe(true);
  });

  it("does not flicker across a nested enter/leave pair", () => {
    const sequence: Array<Parameters<typeof dragTransition>[1]> = [
      "enter", // zone
      "enter", // icon
      "leave", // icon
      "enter", // text
      "leave", // text
    ];
    let state = DRAG_IDLE;
    const observed: boolean[] = [];
    for (const signal of sequence) {
      state = dragTransition(state, signal);
      observed.push(state.active);
    }
    expect(observed).toEqual([true, true, true, true, true]);
  });

  it("deactivates only when the counter returns to zero", () => {
    expect(run(["enter", "enter", "leave", "leave"])).toEqual(DRAG_IDLE);
  });

  it("clamps unmatched leaves instead of going negative", () => {
    const state = run(["leave", "leave", "enter"]);
    expect(state).toEqual({ depth: 1, active: true });
  });

  it("resets hard on drop even from a deep counter", () => {
    expect(run(["enter", "enter", "enter", "drop"])).toEqual(DRAG_IDLE);
  });

  it("resets hard on an explicit reset", () => {
    expect(run(["enter", "enter", "reset"])).toEqual(DRAG_IDLE);
  });
});

describe("carriesFiles", () => {
  it("accepts a payload advertising files", () => {
    expect(carriesFiles(["Files"])).toBe(true);
    expect(carriesFiles(["text/plain", "Files"])).toBe(true);
  });

  it("rejects dragged text selections", () => {
    expect(carriesFiles(["text/plain", "text/html"])).toBe(false);
  });

  it("rejects missing type lists", () => {
    expect(carriesFiles(undefined)).toBe(false);
    expect(carriesFiles(null)).toBe(false);
    expect(carriesFiles([])).toBe(false);
  });
});
