import { describe, expect, it, vi } from "vitest";

import { MockPremiereHost } from "./premiere.js";

describe("MockPremiereHost (PremiereHost contract)", () => {
  it("reports a host version", async () => {
    const host = new MockPremiereHost({ hostVersion: "25.6.2" });
    await expect(host.getHostVersion()).resolves.toBe("25.6.2");
  });

  it("returns the initial sequence by default", async () => {
    const host = new MockPremiereHost();
    const seq = await host.getActiveSequence();
    expect(seq?.name).toBe("Mock Sequence");
    expect(seq?.inOut).toEqual({ startFrames: 0, endFrames: 250 });
  });

  it("returns undefined when no sequence is open", async () => {
    const host = new MockPremiereHost({ initialSequence: undefined });
    await expect(host.getActiveSequence()).resolves.toBeUndefined();
  });

  it("returns the selected clips", async () => {
    const clips = [{ trackItemId: "a", trackIndex: 0, name: "Clip A" }];
    const host = new MockPremiereHost({ initialSelection: clips });
    await expect(host.getSelectedClips()).resolves.toEqual(clips);
  });

  it("notifies subscribers on sequence change and supports unsubscribe", async () => {
    const host = new MockPremiereHost();
    const listener = vi.fn();
    const unsubscribe = host.onSequenceChange(listener);

    host.emitSequenceChange({ kind: "inOutChanged", sequence: await host.getActiveSequence() });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].kind).toBe("inOutChanged");

    unsubscribe();
    host.emitSequenceChange({ kind: "inOutChanged", sequence: undefined });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("setSelection updates selection and fires a selectionChanged event", async () => {
    const host = new MockPremiereHost();
    const listener = vi.fn();
    host.onSequenceChange(listener);
    const clips = [{ trackItemId: "b", trackIndex: 1, name: "Clip B" }];

    host.setSelection(clips);

    await expect(host.getSelectedClips()).resolves.toEqual(clips);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: "selectionChanged" }));
  });

  it("requestMixdown reports progress and resolves a temp WAV path", async () => {
    const host = new MockPremiereHost();
    const progress: number[] = [];

    const result = await host.requestMixdown(
      { sequenceId: "seq-mock-1", range: { startFrames: 0, endFrames: 250 }, format: "mono16k" },
      ({ fraction }) => progress.push(fraction),
    );

    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
    expect(result.tempFilePath).toMatch(/\.wav$/);
    expect(result.format).toBe("mono16k");
    expect(result.durationMs).toBe(10_000); // 250 frames @ 25fps = 10s
  });

  it("requestMixdown honours a mixdownResult override", async () => {
    const host = new MockPremiereHost({ mixdownResult: { durationMs: 42 } });
    const result = await host.requestMixdown({
      sequenceId: "seq-mock-1",
      range: { startFrames: 0, endFrames: 25 },
      format: "stereo48k",
    });
    expect(result.durationMs).toBe(42);
    expect(result.format).toBe("stereo48k");
  });

  it("records openExternalUrl calls (device-code sign-in)", async () => {
    const host = new MockPremiereHost();
    await host.openExternalUrl("https://aksharo.ai/activate?code=ABC");
    expect(host.openedUrls).toEqual(["https://aksharo.ai/activate?code=ABC"]);
  });

  it("readFile returns deterministic placeholder bytes by default", async () => {
    const host = new MockPremiereHost();
    const bytes = await host.readFile("/tmp/x.wav");
    expect(new TextDecoder().decode(bytes)).toBe("mock-audio-bytes:/tmp/x.wav");
  });

  it("readFile returns seeded bytes when set", async () => {
    const host = new MockPremiereHost();
    const seeded = new Uint8Array([1, 2, 3]);
    host.setFileContents("/tmp/y.wav", seeded);
    await expect(host.readFile("/tmp/y.wav")).resolves.toEqual(seeded);
  });

  describe("C06 apply modes", () => {
    it("importTranscript is idempotent: a second import reports replacedExisting", async () => {
      const host = new MockPremiereHost();
      const request = {
        sequenceId: "seq-mock-1",
        language: "en",
        range: { startFrames: 0, endFrames: 250 },
        segments: [
          {
            segmentId: "seg-1",
            words: [{ wid: "0:0", text: "hi", startFrames: 0, endFrames: 10 }],
          },
        ],
      };
      const first = await host.importTranscript(request);
      expect(first.replacedExisting).toBe(false);
      const second = await host.importTranscript(request);
      expect(second.replacedExisting).toBe(true);
      expect(second.transcriptItemId).not.toBe(first.transcriptItemId);
    });

    it("insertMogrt + setMogrtParams + getMogrtParams round-trips params", async () => {
      const host = new MockPremiereHost();
      const { itemId } = await host.insertMogrt({
        mogrtPath: "aksharo-captions.mogrt",
        trackIndex: 2,
        startFrames: 0,
        durationFrames: 50,
      });
      await host.setMogrtParams(itemId, { Text: "Hello", Size: 42 });
      await expect(host.getMogrtParams(itemId)).resolves.toEqual({ Text: "Hello", Size: 42 });
    });

    it("setMogrtParams rejects an unknown item id", async () => {
      const host = new MockPremiereHost();
      await expect(host.setMogrtParams("no-such-item", { Text: "x" })).rejects.toThrow();
    });

    it("rippleDelete records the ranges passed", async () => {
      const host = new MockPremiereHost();
      const ranges = [{ startFrames: 10, endFrames: 20 }];
      await host.rippleDelete(ranges);
      expect(host.rippleDeleteCalls).toEqual([ranges]);
    });

    it("setMotionKeyframes stores keyframes retrievable by test helper", async () => {
      const host = new MockPremiereHost();
      const keyframes = [
        { atFrames: 0, scale: 1, positionX: 0, positionY: 0, ease: "linear" as const },
        { atFrames: 10, scale: 1.2, positionX: 5, positionY: 0, ease: "inOut" as const },
      ];
      await host.setMotionKeyframes("clip-1", keyframes);
      expect(host.getMotionKeyframesFor("clip-1")).toEqual(keyframes);
    });

    it("importMediaToBin then placeOnTrack returns a track item id", async () => {
      const host = new MockPremiereHost();
      const { itemId } = await host.importMediaToBin({ sourcePath: "/tmp/captions.srt" });
      const { trackItemId } = await host.placeOnTrack({
        itemId,
        trackIndex: 3,
        startFrames: 0,
        durationFrames: 100,
      });
      expect(trackItemId).toMatch(/^track-item-/);
    });

    it("placeOnTrack rejects an item never imported to the bin", async () => {
      const host = new MockPremiereHost();
      await expect(
        host.placeOnTrack({ itemId: "ghost", trackIndex: 0, startFrames: 0, durationFrames: 1 }),
      ).rejects.toThrow();
    });

    it("replaceAudioRange records the call", async () => {
      const host = new MockPremiereHost();
      const request = {
        sourcePath: "/tmp/cleaned.wav",
        range: { startFrames: 0, endFrames: 250 },
        muteOriginalTrackIndex: 0,
      };
      await host.replaceAudioRange(request);
      expect(host.replaceAudioRangeCalls).toEqual([request]);
    });

    it("item metadata round-trips and listAksharoItems reflects it", async () => {
      const host = new MockPremiereHost();
      const metadata = { aksharo: { projectId: "p1", segmentId: "seg-1", rev: 3 } };
      await host.setItemMetadata("clip-1", metadata);
      await expect(host.getItemMetadata("clip-1")).resolves.toEqual(metadata);
      await expect(host.listAksharoItems()).resolves.toEqual([{ trackItemId: "clip-1", metadata }]);
    });

    it("removeItem clears metadata so re-sync sees it as gone", async () => {
      const host = new MockPremiereHost();
      await host.setItemMetadata("clip-1", { aksharo: { projectId: "p1", rev: 1 } });
      await host.removeItem("clip-1");
      await expect(host.getItemMetadata("clip-1")).resolves.toBeUndefined();
    });

    it("transaction commits and logs the outcome on success", async () => {
      const host = new MockPremiereHost();
      const result = await host.transaction("apply-captions", async () => {
        await host.rippleDelete([{ startFrames: 0, endFrames: 5 }]);
        return 42;
      });
      expect(result).toBe(42);
      expect(host.transactionLog).toEqual([{ name: "apply-captions", outcome: "committed" }]);
      expect(host.rippleDeleteCalls).toHaveLength(1);
    });

    it("transaction rolls back every mutation made inside it when fn throws", async () => {
      const host = new MockPremiereHost();
      await host.setItemMetadata("existing", { aksharo: { projectId: "p1", rev: 1 } });

      await expect(
        host.transaction("apply-captions", async () => {
          await host.rippleDelete([{ startFrames: 0, endFrames: 5 }]);
          await host.setItemMetadata("new-item", { aksharo: { projectId: "p1", rev: 1 } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(host.transactionLog).toEqual([{ name: "apply-captions", outcome: "rolledBack" }]);
      expect(host.rippleDeleteCalls).toHaveLength(0);
      await expect(host.getItemMetadata("new-item")).resolves.toBeUndefined();
      await expect(host.getItemMetadata("existing")).resolves.toEqual({
        aksharo: { projectId: "p1", rev: 1 },
      });
    });
  });
});
