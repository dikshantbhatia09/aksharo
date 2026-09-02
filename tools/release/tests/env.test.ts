import { describe, expect, it } from "vitest";

import { releaseMode, requireSecretsIfSigned, winSignProviderName } from "../src/env.js";
import { ReleaseFailClosedError } from "../src/types.js";

describe("releaseMode", () => {
  it("defaults to dry-run when unset or unrecognised", () => {
    expect(releaseMode({})).toBe("dry-run");
    expect(releaseMode({ RELEASE_MODE: "whatever" })).toBe("dry-run");
  });

  it("is signed only when explicitly set", () => {
    expect(releaseMode({ RELEASE_MODE: "signed" })).toBe("signed");
    expect(releaseMode({ RELEASE_MODE: "SIGNED" })).toBe("signed");
  });
});

describe("winSignProviderName", () => {
  it("defaults to azure-trusted-signing", () => {
    expect(winSignProviderName({})).toBe("azure-trusted-signing");
  });
  it("selects digicert-key-locker when set", () => {
    expect(winSignProviderName({ WIN_SIGN_PROVIDER: "digicert-key-locker" })).toBe(
      "digicert-key-locker",
    );
  });
});

describe("requireSecretsIfSigned", () => {
  it("is a no-op in dry-run even with nothing set", () => {
    expect(() => requireSecretsIfSigned("dry-run", ["FOO", "BAR"], {})).not.toThrow();
  });

  it("fails closed in signed mode when secrets are missing, naming every missing one", () => {
    try {
      requireSecretsIfSigned("signed", ["FOO", "BAR"], { FOO: "set" });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReleaseFailClosedError);
      const e = err as InstanceType<typeof ReleaseFailClosedError>;
      expect(e.missing).toEqual(["BAR"]);
      expect(e.message).toMatch(/BAR/);
    }
  });

  it("passes in signed mode once every secret is set", () => {
    expect(() =>
      requireSecretsIfSigned("signed", ["FOO", "BAR"], { FOO: "1", BAR: "2" }),
    ).not.toThrow();
  });

  it("treats an empty string as missing", () => {
    expect(() => requireSecretsIfSigned("signed", ["FOO"], { FOO: "" })).toThrow(
      ReleaseFailClosedError,
    );
  });
});
