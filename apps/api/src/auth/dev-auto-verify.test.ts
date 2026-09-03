import { afterEach, describe, expect, it } from "vitest";

import { devAutoVerifyEnabled } from "./dev-auto-verify.js";

describe("devAutoVerifyEnabled", () => {
  it("is off by default in the development outbox", () => {
    expect(devAutoVerifyEnabled({ AUTH_DEV_AUTO_VERIFY: false, MAIL_PROVIDER: "dev" })).toBe(false);
  });

  it("allows the explicit switch with the development outbox", () => {
    expect(devAutoVerifyEnabled({ AUTH_DEV_AUTO_VERIFY: true, MAIL_PROVIDER: "dev" })).toBe(true);
  });

  it.each(["smtp", "ses"] as const)("ignores the switch with the %s mail transport", (provider) => {
    expect(devAutoVerifyEnabled({ AUTH_DEV_AUTO_VERIFY: true, MAIL_PROVIDER: provider })).toBe(
      false,
    );
  });

  // `crossFieldProblems` already refuses this combination at boot. The guard repeats
  // the check because the validated Env is a mutable shared singleton, so a value read
  // on every sign-up cannot rely on boot-time validation alone.
  describe("under NODE_ENV=production", () => {
    const original = process.env["NODE_ENV"];
    afterEach(() => {
      if (original === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = original;
    });

    it("refuses even with the development outbox and the switch on", () => {
      process.env["NODE_ENV"] = "production";
      expect(devAutoVerifyEnabled({ AUTH_DEV_AUTO_VERIFY: true, MAIL_PROVIDER: "dev" })).toBe(
        false,
      );
    });
  });
});
