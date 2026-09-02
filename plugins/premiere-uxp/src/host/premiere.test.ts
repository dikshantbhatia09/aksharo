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
});
