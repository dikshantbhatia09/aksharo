import { describe, expect, it } from "vitest";

import { createRealAeHost, MockAeHost } from "./ae.js";

describe("MockAeHost (AeHost contract)", () => {
  it("reports a host version", async () => {
    const host = new MockAeHost({ hostVersion: "24.1.0" });
    await expect(host.getHostVersion()).resolves.toBe("24.1.0");
  });

  it("returns the initial comp by default", async () => {
    const host = new MockAeHost();
    const comp = await host.readComp();
    expect(comp?.name).toBe("Mock Comp");
    expect(comp?.workArea).toEqual({ startSeconds: 0, durationSeconds: 10 });
  });

  it("returns undefined when no comp is open", async () => {
    const host = new MockAeHost({ initialComp: undefined });
    await expect(host.readComp()).resolves.toBeUndefined();
  });

  it("mixdownToWav reports progress and resolves a temp WAV path", async () => {
    const host = new MockAeHost();
    const progress: number[] = [];
    const result = await host.mixdownToWav(
      { compId: "comp-mock-1", range: { startSeconds: 0, durationSeconds: 4 }, format: "mono16k" },
      (p) => progress.push(p.fraction),
    );
    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
    expect(result.tempFilePath).toMatch(/\.wav$/);
    expect(result.durationMs).toBe(4000);
  });

  it("openExternalUrl records opened URLs", async () => {
    const host = new MockAeHost();
    await host.openExternalUrl("https://aksharo.ai/pair?pairingId=abc");
    expect(host.openedUrls).toEqual(["https://aksharo.ai/pair?pairingId=abc"]);
  });

  it("readFile returns deterministic placeholder bytes, or seeded bytes", async () => {
    const host = new MockAeHost();
    const bytes = await host.readFile("/tmp/x.wav");
    expect(new TextDecoder().decode(bytes)).toContain("/tmp/x.wav");

    const seeded = new Uint8Array([1, 2, 3]);
    host.setFileContents("/tmp/y.wav", seeded);
    await expect(host.readFile("/tmp/y.wav")).resolves.toEqual(seeded);
  });

  it("addTextLayers requires an undoGroup", async () => {
    const host = new MockAeHost();
    await expect(
      host.addTextLayers("comp-mock-1", [
        {
          segmentId: "s1",
          text: "hi",
          startSeconds: 0,
          durationSeconds: 1,
          fontFamily: "Inter",
          fontSizePx: 40,
          colorRgb: [255, 255, 255],
          positionXPx: 0,
          positionYPx: 0,
        },
      ]),
    ).rejects.toThrow(/outside undoGroup/);
  });

  it("addTextLayers inside undoGroup adds one layer per spec and records the group name", async () => {
    const host = new MockAeHost();
    const result = await host.undoGroup("Aksharo: test", async () =>
      host.addTextLayers("comp-mock-1", [
        {
          segmentId: "s1",
          text: "hi",
          startSeconds: 0,
          durationSeconds: 1,
          fontFamily: "Inter",
          fontSizePx: 40,
          colorRgb: [255, 255, 255],
          positionXPx: 0,
          positionYPx: 0,
        },
      ]),
    );
    expect(result.layerIds).toHaveLength(1);
    expect(host.undoGroupNames).toEqual(["Aksharo: test"]);
  });

  it("undoGroup still closes (decrements depth) when fn throws", async () => {
    const host = new MockAeHost();
    await expect(
      host.undoGroup("Aksharo: boom", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A second, well-formed call still works, proving the group depth was cleaned up.
    await expect(host.undoGroup("Aksharo: after", async () => "ok")).resolves.toBe("ok");
  });

  it("tagLayer / getLayerMetadata / listAksharoLayers / removeLayer round-trip", async () => {
    const host = new MockAeHost();
    const { layerId } = await host.importOverlay({
      sourcePath: "/tmp/o.mov",
      compId: "comp-mock-1",
    });
    await expect(host.getLayerMetadata(layerId)).resolves.toBeUndefined();

    const metadata = { aksharo: { projectId: "p1", rev: 1 } };
    await host.tagLayer(layerId, metadata);
    await expect(host.getLayerMetadata(layerId)).resolves.toEqual(metadata);
    await expect(host.listAksharoLayers()).resolves.toEqual([{ layerId, metadata }]);

    await host.removeLayer(layerId);
    await expect(host.listAksharoLayers()).resolves.toEqual([]);
  });

  it("tagLayer throws for an unknown layer id", async () => {
    const host = new MockAeHost();
    await expect(
      host.tagLayer("no-such-layer", { aksharo: { projectId: "p1", rev: 1 } }),
    ).rejects.toThrow(/unknown layer/);
  });
});

describe("createRealAeHost", () => {
  it("every method throws until Gate C (no real After Effects on this build host)", () => {
    const host = createRealAeHost();
    expect(() => host.getHostVersion()).toThrow(/GATE-C-CHECKLIST/);
    expect(() => host.readComp()).toThrow(/not implemented/);
  });
});
