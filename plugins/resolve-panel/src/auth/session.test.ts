import { describe, expect, it } from "vitest";

import { parseSessionStatus, SIGNED_OUT_STATUS } from "./session.js";

describe("parseSessionStatus", () => {
  it("parses a signed-out wire status", () => {
    const status = parseSessionStatus({
      signedIn: false,
      workspaceId: null,
      userEmail: null,
      pairing: null,
    });
    expect(status).toEqual(SIGNED_OUT_STATUS);
  });

  it("parses a pairing-in-progress wire status", () => {
    const status = parseSessionStatus({
      signedIn: false,
      workspaceId: null,
      userEmail: null,
      pairing: { userCode: "4F7K-92QA", verificationUrl: "https://aksharo.ai/device" },
    });
    expect(status.pairing).toEqual({
      userCode: "4F7K-92QA",
      verificationUrl: "https://aksharo.ai/device",
    });
  });

  it("parses a signed-in wire status", () => {
    const status = parseSessionStatus({
      signedIn: true,
      workspaceId: "ws_1",
      userEmail: "creator@example.com",
      pairing: null,
    });
    expect(status.signedIn).toBe(true);
    expect(status.workspaceId).toBe("ws_1");
    expect(status.pairing).toBeNull();
  });
});
