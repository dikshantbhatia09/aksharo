import { describe, expect, it } from "vitest";

import { DSR_DUE_DAYS } from "./account.constants.js";
import { A05_AUDIT_ACTIONS } from "./audit.service.js";
import { evidenceKey } from "./data-export.service.js";
import { anonymisedEmail, dsrDueAt, toProfileView } from "./profile.service.js";
import { updateProfileSchema } from "./users.dto.js";

const USER_ID = "01JUSER00000000000000000AA";
const WORKSPACE_ID = "01JWORKSPACE0000000000000A";

describe("dsrDueAt", () => {
  it("is 30 days after the request (DPDP Rule 14, D61)", () => {
    const from = new Date("2026-09-02T00:00:00.000Z");
    expect(dsrDueAt(from).toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(DSR_DUE_DAYS).toBe(30);
  });
});

describe("anonymisedEmail", () => {
  it("is deterministic, unique per user and undeliverable", () => {
    const address = anonymisedEmail(USER_ID);
    // `.invalid` is reserved by RFC 2606: nothing can be delivered to it, and no
    // future sign-up can collide with it.
    expect(address).toMatch(/^deleted-[0-9a-z]{26}@deleted\.invalid$/);
    expect(anonymisedEmail(USER_ID)).toBe(address);
    expect(anonymisedEmail("01JOTHER0000000000000000BB")).not.toBe(address);
  });
});

describe("evidenceKey", () => {
  it("names the object the bundle will occupy, scoped to the user", () => {
    expect(evidenceKey(USER_ID, "01JREQ000000000000000000CC")).toBe(
      `u/${USER_ID}/dsr/01JREQ000000000000000000CC.json`,
    );
  });
});

describe("updateProfileSchema", () => {
  it("accepts a partial patch and rejects an empty one", () => {
    expect(updateProfileSchema.safeParse({ name: "Priya" }).success).toBe(true);
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it("allows clearing the name and the avatar with null", () => {
    expect(updateProfileSchema.safeParse({ name: null, avatarUrl: null }).success).toBe(true);
  });

  it("refuses an avatar that is not https", () => {
    // The value is rendered in the product and in email; `data:` and `http:` are
    // both ways to get something else into that <img>.
    expect(updateProfileSchema.safeParse({ avatarUrl: "http://example.test/a.png" }).success).toBe(
      false,
    );
    expect(updateProfileSchema.safeParse({ avatarUrl: "data:image/png;base64,AA" }).success).toBe(
      false,
    );
    expect(updateProfileSchema.safeParse({ avatarUrl: "https://cdn.example/a.png" }).success).toBe(
      true,
    );
  });

  it("refuses a locale that is not a language tag", () => {
    expect(updateProfileSchema.safeParse({ locale: "en-IN" }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ locale: "../../etc/passwd" }).success).toBe(false);
  });

  it("bounds the onboarding blob so the JSONB column cannot be abused", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`k${String(index)}`, true]),
    );
    expect(updateProfileSchema.safeParse({ onboarding: tooMany }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ onboarding: { tourDone: true } }).success).toBe(true);
  });
});

describe("toProfileView", () => {
  const row = {
    id: USER_ID,
    email: "priya@example.test",
    emailVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    name: "Priya",
    avatarUrl: null,
    locale: "en-IN",
    jurisdiction: "IN" as const,
    ageBracket: "adult" as const,
    marketingOptIn: false,
    onboarding: { tourDone: true },
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    lastSeenAt: null,
    deletedAt: null,
  };

  it("renders timestamps as ISO-8601 and verification as a boolean", () => {
    const view = toProfileView(row, { id: WORKSPACE_ID, role: "owner" });
    expect(view.emailVerified).toBe(true);
    expect(view.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(view.lastSeenAt).toBeNull();
    expect(view.deletedAt).toBeNull();
  });

  it("carries the token's workspace and role, so a client needs one request", () => {
    const view = toProfileView(row, { id: WORKSPACE_ID, role: "editor" });
    expect(view.workspace).toEqual({ id: WORKSPACE_ID, role: "editor" });
  });

  it("never returns a credential", () => {
    const view = toProfileView(row, { id: WORKSPACE_ID, role: "owner" });
    expect(Object.keys(view)).not.toContain("passwordHash");
    expect(Object.keys(view)).not.toContain("mfaSecret");
    // Date of birth is collected for the age gate and is not part of the profile.
    expect(Object.keys(view)).not.toContain("dateOfBirth");
  });
});

describe("A05_AUDIT_ACTIONS", () => {
  it("names every action `<domain>.<noun>.<verb>` and never repeats one", () => {
    const actions = Object.values(A05_AUDIT_ACTIONS);
    for (const action of actions) expect(action).toMatch(/^[a-z_]+(\.[a-z_]+){1,2}$/);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
