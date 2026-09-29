import { describe, expect, it } from "vitest";

import { HeavySlots } from "./heavy-slot.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("HeavySlots (2026-10-03)", () => {
  it("runs one heavy job at a time on one slot, in the order they asked", async () => {
    const slots = new HeavySlots(1);
    const order: string[] = [];
    const video = deferred();
    const first = slots.run(async () => {
      order.push("video starts");
      await video.promise;
      order.push("video ends");
    });
    const second = slots.run(async () => {
      order.push("compilation starts");
      return "joined";
    });
    const third = slots.run(async () => {
      order.push("next video starts");
    });
    await Promise.resolve();
    expect(slots.load).toEqual({ running: 1, waiting: 2 });
    expect(order).toEqual(["video starts"]);

    video.resolve();
    await expect(second).resolves.toBe("joined");
    await Promise.all([first, third]);
    expect(order).toEqual([
      "video starts",
      "video ends",
      "compilation starts",
      "next video starts",
    ]);
    expect(slots.load).toEqual({ running: 0, waiting: 0 });
  });

  it("frees the slot when the work throws", async () => {
    const slots = new HeavySlots(1);
    await expect(
      slots.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(slots.run(async () => "after")).resolves.toBe("after");
  });

  it("lets as many run as there are slots", async () => {
    const slots = new HeavySlots(2);
    const hold = deferred();
    const running = [slots.run(() => hold.promise), slots.run(() => hold.promise)];
    await Promise.resolve();
    expect(slots.load).toEqual({ running: 2, waiting: 0 });
    hold.resolve();
    await Promise.all(running);
  });

  it("needs at least one slot", () => {
    expect(() => new HeavySlots(0)).toThrow(RangeError);
  });
});
