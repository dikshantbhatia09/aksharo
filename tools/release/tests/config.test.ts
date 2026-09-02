import { describe, expect, it } from "vitest";

import { generateElectronBuilderConfig } from "../src/commands/buildDesktop.js";

import type { ReleaseConfig } from "../src/config.js";

const config: ReleaseConfig = {
  appId: "ai.aksharo.desktop",
  productName: "Aksharo",
  desktopAppDir: "apps/desktop",
  mac: { target: ["dmg", "zip"], category: "public.app-category.video" },
  win: { target: "nsis", arch: "x64" },
  ccx: { pluginDir: "plugins/premiere-uxp", minPremiereVersion: "25.6" },
  zxp: { pluginDir: "plugins/ae-cep" },
  resolveBundle: { scriptDir: "plugins/resolve", installPaths: { win: "w", mac: "m", linux: "l" } },
  channels: ["alpha", "beta", "stable"],
};

describe("generateElectronBuilderConfig", () => {
  it("generates a mac config with universal dmg+zip targets and no montaj codename anywhere", () => {
    const eb = generateElectronBuilderConfig(config, "mac");
    expect(eb.appId).toBe("ai.aksharo.desktop");
    expect(eb.productName).toBe("Aksharo");
    expect(JSON.stringify(eb)).not.toMatch(/montaj/i);
    expect((eb.mac as { target: unknown[] }).target).toHaveLength(2);
    expect(eb.win).toBeUndefined();
  });

  it("generates a win config with nsis x64 only", () => {
    const eb = generateElectronBuilderConfig(config, "win");
    expect(eb.mac).toBeUndefined();
    const win = eb.win as { target: { target: string; arch: string[] }[] };
    expect(win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
  });
});
