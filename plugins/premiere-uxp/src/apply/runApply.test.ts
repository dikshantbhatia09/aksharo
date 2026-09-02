import { describe, expect, it } from "vitest";

import { planApply, runApply } from "./runApply.js";
import { BridgeClient, MockBridgeTransport } from "../bridge/client.js";
import { MockPremiereHost } from "../host/premiere.js";

import type { EdgPassItemLike, EdgSegmentLike } from "./types.js";

function makeBridge(): { bridge: BridgeClient; transport: MockBridgeTransport } {
  const transport = new MockBridgeTransport();
  let stepCount = 0;
  transport.on("apply.begin", () => ({ transactionId: "txn-1" }));
  transport.on("apply.step", () => {
    stepCount += 1;
    return { accepted: true };
  });
  transport.on("apply.commit", () => ({ committed: true, appliedSteps: stepCount }));
  transport.on("apply.abort", () => ({ aborted: true }));
  return { bridge: new BridgeClient(transport), transport };
}

describe("planApply", () => {
  it("counts visible segments, accepted items and optional assets", () => {
    const segments: EdgSegmentLike[] = [
      { id: "s1", seq: "a0", startFrames: 0, endFrames: 10, words: [] },
      { id: "s2", seq: "a1", startFrames: 10, endFrames: 20, hidden: true, words: [] },
    ];
    const items: EdgPassItemLike[] = [
      { itemId: "c1", kind: "cut", startFrames: 0, endFrames: 5, state: "accepted" },
      { itemId: "c2", kind: "cut", startFrames: 5, endFrames: 8, state: "proposed" },
      { itemId: "z1", kind: "zoom", startFrames: 0, endFrames: 10, state: "accepted" },
    ];
    const counts = planApply({
      segments,
      items,
      alphaOverlayCount: 2,
      hasCleanedAudio: true,
    });
    expect(counts).toEqual({
      transcript: 1,
      mogrtCaptions: 1,
      alphaOverlay: 2,
      srtToBin: 1,
      cuts: 1,
      zooms: 1,
      audio: 1,
    });
  });
});

describe("runApply", () => {
  it("runs one host transaction, reports steps and commits on success", async () => {
    const host = new MockPremiereHost();
    const { bridge } = makeBridge();
    const applied: string[] = [];

    const result = await runApply(host, bridge, {
      projectId: "proj-1",
      modes: ["transcript", "cuts"],
      itemIds: ["seg-1", "cut-1"],
      step: async (mode) => {
        applied.push(mode);
      },
    });

    expect(applied).toEqual(["transcript", "cuts"]);
    expect(result.appliedSteps).toBe(2);
    expect(host.transactionLog).toEqual([{ name: "apply:txn-1", outcome: "committed" }]);
  });

  it("aborts + rolls back and reports the reason when a step throws", async () => {
    const host = new MockPremiereHost();
    const { bridge, transport } = makeBridge();

    await expect(
      runApply(host, bridge, {
        projectId: "proj-1",
        modes: ["transcript", "cuts"],
        itemIds: ["seg-1"],
        step: async (mode) => {
          if (mode === "cuts") throw new Error("host mutation failed");
          await host.importTranscript({
            sequenceId: "seq-mock-1",
            language: "en",
            range: { startFrames: 0, endFrames: 10 },
            segments: [],
          });
        },
      }),
    ).rejects.toThrow("host mutation failed");

    expect(host.transactionLog).toEqual([{ name: "apply:txn-1", outcome: "rolledBack" }]);
    const abortCall = transport.calls.find((c) => c.method === "apply.abort");
    expect(abortCall?.params).toMatchObject({
      transactionId: "txn-1",
      reason: "host mutation failed",
    });
  });

  it("throws and aborts when the bridge rejects a step", async () => {
    const host = new MockPremiereHost();
    const { bridge, transport } = makeBridge();
    transport.on("apply.step", () => ({ accepted: false }));

    await expect(
      runApply(host, bridge, {
        projectId: "proj-1",
        modes: ["transcript"],
        itemIds: ["seg-1"],
        step: async () => {},
      }),
    ).rejects.toThrow(/apply\.step rejected/);

    expect(host.transactionLog).toEqual([{ name: "apply:txn-1", outcome: "rolledBack" }]);
  });
});
