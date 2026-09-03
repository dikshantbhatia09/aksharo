import { describe, expect, it } from "vitest";

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
});
