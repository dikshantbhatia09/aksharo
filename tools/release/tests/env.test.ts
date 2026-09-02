import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadReleaseDotEnv,
  parseDotEnv,
  releaseMode,
  requireSecretsIfSigned,
  winSignProviderName,
} from "../src/env.js";
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

describe("parseDotEnv / loadReleaseDotEnv", () => {
  it("parses KEY=value lines, skipping comments and blanks, and stripping quotes", () => {
    const text = [
      "# a comment",
      "",
      "FOO=bar",
      'QUOTED="hello world"',
      "SINGLE='it work'",
      "  SPACED = trimmed  ",
      "not a valid line",
    ].join("\n");
    const parsed = parseDotEnv(text);
    expect(parsed.FOO).toBe("bar");
    expect(parsed.QUOTED).toBe("hello world");
    expect(parsed.SINGLE).toBe("it work");
    expect(parsed.SPACED).toBe("trimmed");
  });

  it("loadReleaseDotEnv fills unset keys but never overrides an already-set real env var", () => {
    const env: NodeJS.ProcessEnv = { RELEASE_MODE: "signed", EMPTY_ALREADY: "" };
    const dir = mkdtempSync(path.join(tmpdir(), "release-dotenv-"));
    const file = path.join(dir, ".env");
    writeFileSync(
      file,
      "RELEASE_MODE=dry-run\nWIN_SIGN_PROVIDER=digicert-key-locker\nEMPTY_ALREADY=filled\n",
    );

    loadReleaseDotEnv(file, env);

    expect(env.RELEASE_MODE).toBe("signed"); // real env wins
    expect(env.WIN_SIGN_PROVIDER).toBe("digicert-key-locker"); // filled from file
    expect(env.EMPTY_ALREADY).toBe("filled"); // empty string counts as unset

    rmSync(dir, { recursive: true, force: true });
  });

  it("loadReleaseDotEnv is a silent no-op when the file is missing", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadReleaseDotEnv("/does/not/exist/.env", env)).not.toThrow();
    expect(env).toEqual({});
  });
});
