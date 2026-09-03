import { describe, expect, it } from "vitest";

import { buildDiagnosticsBundle } from "./diagnostics-bundle.js";

/** Same minimal store-only reader as `zip-writer.test.ts`. */
function readStoredZip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let pos = 0;
  while (pos < buffer.length) {
    const signature = buffer.readUInt32LE(pos);
    if (signature !== 0x04034b50) break;
    const nameLength = buffer.readUInt16LE(pos + 26);
    const extraLength = buffer.readUInt16LE(pos + 28);
    const size = buffer.readUInt32LE(pos + 18);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    entries.set(name, buffer.subarray(dataStart, dataStart + size));
    pos = dataStart + size;
  }
  return entries;
}

describe("buildDiagnosticsBundle", () => {
  it("includes versions, redacted logs and redacted config", () => {
    const zip = buildDiagnosticsBundle({
      appVersion: "1.2.3",
      platform: "win32",
      osVersion: "Windows 11",
      updateChannel: "stable",
      logLines: ["contact leak@example.com for help", "render finished in 4.2s"],
      config: { apiKey: "sk_should_be_dropped", locale: "en-IN" },
    });

    const entries = readStoredZip(zip);
    expect([...entries.keys()]).toEqual(["versions.json", "logs.txt", "config.json"]);

    const versions = JSON.parse(entries.get("versions.json")!.toString("utf8")) as {
      appVersion: string;
    };
    expect(versions.appVersion).toBe("1.2.3");

    const logs = entries.get("logs.txt")!.toString("utf8");
    expect(logs).not.toContain("leak@example.com");
    expect(logs).toContain("render finished in 4.2s");

    const config = JSON.parse(entries.get("config.json")!.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(config["apiKey"]).toBe("[redacted]");
    expect(config["locale"]).toBe("en-IN");
  });

  it("drops the bearer entirely from an included bridge discovery file", () => {
    const zip = buildDiagnosticsBundle({
      appVersion: "1.0.0",
      platform: "darwin",
      osVersion: "macOS 15",
      updateChannel: "beta",
      logLines: [],
      config: {},
      bridgeDiscovery: { port: 51820, certFingerprint: "ab:cd", bearer: "super-secret-bearer" },
    });

    const entries = readStoredZip(zip);
    const discovery = JSON.parse(entries.get("bridge-discovery.json")!.toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(discovery["bearer"]).toBeUndefined();
    expect(discovery["port"]).toBe(51820);
    expect(JSON.stringify(discovery)).not.toContain("super-secret-bearer");
  });

  it("omits the bridge discovery entry when the bridge is not running", () => {
    const zip = buildDiagnosticsBundle({
      appVersion: "1.0.0",
      platform: "linux",
      osVersion: "Ubuntu 24.04",
      updateChannel: "alpha",
      logLines: [],
      config: {},
    });
    const entries = readStoredZip(zip);
    expect(entries.has("bridge-discovery.json")).toBe(false);
  });

  it("caps the log tail at 500 lines", () => {
    const zip = buildDiagnosticsBundle({
      appVersion: "1.0.0",
      platform: "win32",
      osVersion: "Windows 11",
      updateChannel: "stable",
      logLines: Array.from({ length: 600 }, (_, i) => `line ${i}`),
      config: {},
    });
    const entries = readStoredZip(zip);
    const logs = entries.get("logs.txt")!.toString("utf8").split("\n");
    expect(logs).toHaveLength(500);
    expect(logs[0]).toBe("line 100");
  });
});
