import { describe, expect, it } from "vitest";

import { importSrtToBin } from "./srtBin.js";
import { MockPremiereHost } from "../host/premiere.js";

describe("importSrtToBin", () => {
  it("imports the SRT to the bin without placing it on a track", async () => {
    const host = new MockPremiereHost();
    const result = await importSrtToBin(host, { localPath: "/tmp/captions.srt" });
    expect(result.binItemId).toMatch(/^bin-/);
  });

  it("uses the default bin name when none is given", async () => {
    const host = new MockPremiereHost();
    let seenBinName: string | undefined;
    const original = host.importMediaToBin.bind(host);
    host.importMediaToBin = async (request) => {
      seenBinName = request.binName;
      return original(request);
    };
    await importSrtToBin(host, { localPath: "/tmp/captions.srt" });
    expect(seenBinName).toBe("Aksharo subtitles");
  });
});
