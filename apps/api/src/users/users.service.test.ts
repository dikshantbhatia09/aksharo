import { describe, expect, it } from "vitest";

import {
  consentRows,
  DEFAULT_BILLING_COUNTRY,
  DEFAULT_REGION,
  normaliseEmail,
  personalWorkspaceSlug,
  PRIVACY_NOTICE_VERSION,
  SIGNUP_CONSENT_PURPOSES,
} from "./users.service.js";

describe("normaliseEmail", () => {
  it("lowercases and trims, and does nothing else", () => {
    expect(normaliseEmail("  Someone@Example.TEST ")).toBe("someone@example.test");
    // Deliberately NOT stripping dots or plus tags: `a+b@` and `a@` are different
    // mailboxes at most providers, and treating them as one is a security bug.
    expect(normaliseEmail("a+tag@example.test")).toBe("a+tag@example.test");
  });
});

describe("personalWorkspaceSlug", () => {
  it("builds a slug from the local part with a random suffix", () => {
    const slug = personalWorkspaceSlug("Priya.Sharma+work@example.test");
    expect(slug).toMatch(/^priya-sharma-work-[0-9a-f]{8}$/);
  });

  it("never collides for the same address", () => {
    const slugs = new Set(
      Array.from({ length: 100 }, () => personalWorkspaceSlug("same@example.test")),
    );
    expect(slugs.size).toBe(100);
  });

  it("copes with a local part that has nothing usable in it", () => {
    expect(personalWorkspaceSlug("___@example.test")).toMatch(/^workspace-[0-9a-f]{8}$/);
    expect(personalWorkspaceSlug("no-at-sign")).toMatch(/^no-at-sign-[0-9a-f]{8}$/);
  });

  it("caps the stem so a long address cannot make an unreadable slug", () => {
    const slug = personalWorkspaceSlug(`${"a".repeat(200)}@example.test`);
    expect(slug).toMatch(/^a{24}-[0-9a-f]{8}$/);
  });
});

describe("consentRows", () => {
  const rows = consentRows({
    userId: "01JUSER00000000000000000AA",
    workspaceId: "01JWORKSPACE0000000000000A",
    choices: { analytics: true, marketing: false },
    at: new Date("2026-09-02T00:00:00.000Z"),
    ip: "203.0.113.1",
    ua: "Test/1.0",
    noticeVersion: PRIVACY_NOTICE_VERSION,
  });

  it("writes one row per purpose the form asked about", () => {
    expect(rows).toHaveLength(SIGNUP_CONSENT_PURPOSES.length);
    expect(rows.map((row) => row.purpose)).toEqual([...SIGNUP_CONSENT_PURPOSES]);
  });

  it("records a refusal as a row, not as an absent row", () => {
    // The DPDP notice-and-choice record has to show what was asked as well as
    // what was agreed to.
    const granted = Object.fromEntries(rows.map((row) => [row.purpose, row.granted]));
    expect(granted).toEqual({ analytics: true, memory: false, marketing: false });
  });

  it("stamps the notice version and the request context onto every row", () => {
    for (const row of rows) {
      expect(row.noticeVersion).toBe(PRIVACY_NOTICE_VERSION);
      expect(row.version).toBe(PRIVACY_NOTICE_VERSION);
      expect(row.ip).toBe("203.0.113.1");
      expect(row.ua).toBe("Test/1.0");
      expect(String(row.id)).toHaveLength(26);
    }
  });
});

describe("workspace defaults", () => {
  it("pins the region to the declared jurisdiction (THREAT-MODEL T24)", () => {
    expect(DEFAULT_REGION).toEqual({ IN: "in", EU: "eu", OTHER: "us" });
  });

  it("gives every jurisdiction a two-letter billing country", () => {
    for (const country of Object.values(DEFAULT_BILLING_COUNTRY)) {
      expect(country).toMatch(/^[A-Z]{2}$/);
    }
  });
});
