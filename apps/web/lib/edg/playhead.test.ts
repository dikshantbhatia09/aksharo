import { describe, expect, it, vi } from "vitest";

import { PlayheadStore } from "./playhead";

describe("PlayheadStore (FIX-02 commander semantics)", () => {
  it("seek() bumps seekSeq; syncFromMedia() never does", () => {
    const store = new PlayheadStore();
    store.seek(4_000);
    expect(store.getSnapshot()).toMatchObject({ ms: 4_000, seekSeq: 1 });
    store.syncFromMedia(4_040);
    expect(store.getSnapshot()).toMatchObject({ ms: 4_040, seekSeq: 1 });
    store.seek(1_000);
    expect(store.getSnapshot().seekSeq).toBe(2);
  });

  it("clamps seeks below zero and preserves playing across them", () => {
    const store = new PlayheadStore();
    store.setPlaying(true);
    store.seek(-50);
    expect(store.getSnapshot()).toMatchObject({ ms: 0, playing: true });
  });

  it("notifies once per real change and not for no-ops", () => {
    const store = new PlayheadStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setPlaying(false); // no-op
    store.syncFromMedia(0); // no-op
    expect(listener).not.toHaveBeenCalled();
    store.togglePlaying();
    store.syncFromMedia(120);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
