import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CODENAME } from "@montaj/config";

import { hashEmail, parentalWaitlistRow } from "./parental-waitlist.js";
import { PRIVACY_NOTICE } from "./privacy-notice.js";
import { CONSENT_PURPOSES } from "../consents/consents.dto.js";
import { PRIVACY_NOTICE_VERSION } from "../users/users.service.js";

describe("the privacy notice", () => {
  it("is stamped with the version every consent record carries", () => {
    expect(PRIVACY_NOTICE.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(Date.parse(PRIVACY_NOTICE.effectiveFrom)).not.toBeNaN();
  });

  it("itemises every consentable purpose plus the essential one (Rule 3)", () => {
    const listed = PRIVACY_NOTICE.purposes.map((entry) => entry.purpose);
    for (const purpose of CONSENT_PURPOSES) expect(listed).toContain(purpose);
    expect(PRIVACY_NOTICE.purposes.filter((entry) => entry.essential)).toHaveLength(1);
  });

  it("defaults every optional purpose to refused", () => {
    for (const purpose of PRIVACY_NOTICE.purposes) {
      if (!purpose.essential) expect(purpose.defaultGranted).toBe(false);
    }
  });

  it("publishes a contact and the 30-day response period (Rules 9 and 14)", () => {
    expect(PRIVACY_NOTICE.contactEmail).toMatch(/@/);
    expect(PRIVACY_NOTICE.responseDays).toBe(30);
    expect(PRIVACY_NOTICE.rights.length).toBeGreaterThan(3);
  });

  it("never leaks the engineering codename into user-facing text (CONTRACTS §0)", () => {
    const rendered = JSON.stringify(PRIVACY_NOTICE).toLowerCase();
    expect(rendered).not.toContain(CODENAME);
  });
});

describe("the parental waiting list", () => {
  it("hashes the address exactly as A04's Redis key did, so the two agree", () => {
    const expected = createHash("sha256").update("kid@example.test").digest("hex");
    expect(hashEmail("  KID@Example.TEST ")).toBe(expected);
  });

  it("keeps only the digest, never the address", () => {
    const row = parentalWaitlistRow({ email: "kid@example.test", jurisdiction: "IN" });
    expect(JSON.stringify(row)).not.toContain("kid@example.test");
    expect(row.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.jurisdiction).toBe("IN");
  });

  it("defaults to an unrecorded jurisdiction and a declared minor", () => {
    const row = parentalWaitlistRow({ email: "kid@example.test" });
    expect(row.jurisdiction).toBe("OTHER");
    expect(row.ageBracket).toBe("minor");
  });

  it("is idempotent on the address: two submissions produce the same key", () => {
    const first = parentalWaitlistRow({ email: "kid@example.test" });
    const second = parentalWaitlistRow({ email: "KID@EXAMPLE.TEST" });
    expect(second.emailHash).toBe(first.emailHash);
    expect(second.id).not.toBe(first.id);
  });
});
