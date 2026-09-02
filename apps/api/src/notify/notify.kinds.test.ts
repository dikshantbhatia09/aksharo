import { describe, expect, it } from "vitest";

import {
  allowsUnsubscribe,
  CRITICAL_KINDS,
  IN_APP_KINDS,
  isCriticalKind,
  isInAppKind,
  isNotifyKind,
  NON_TRANSACTIONAL_KINDS,
  NOTIFY_KINDS,
} from "./notify.kinds.js";
import { EN_MESSAGES } from "./templates/messages.en.js";
import { HI_MESSAGES } from "./templates/messages.hi.js";

describe("the kind list", () => {
  it("is the ten templates the brief names", () => {
    expect([...NOTIFY_KINDS].sort()).toEqual([
      "device-approval",
      "export-ready",
      "login-new-device",
      "low-credits",
      "magic-link",
      "parental-waitlist",
      "password-changed",
      "renewal-notice",
      "share-comment",
      "verify-email",
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(NOTIFY_KINDS).size).toBe(NOTIFY_KINDS.length);
  });

  it("recognises its own members and nothing else", () => {
    for (const kind of NOTIFY_KINDS) expect(isNotifyKind(kind)).toBe(true);
    expect(isNotifyKind("welcome")).toBe(false);
    expect(isNotifyKind(42)).toBe(false);
    expect(isNotifyKind(undefined)).toBe(false);
  });

  it("has an English and a Hindi entry for every kind", () => {
    for (const kind of NOTIFY_KINDS) {
      expect(EN_MESSAGES.kinds[kind], `en is missing ${kind}`).toBeDefined();
      expect(HI_MESSAGES.kinds[kind], `hi is missing ${kind}`).toBeDefined();
    }
    expect(Object.keys(EN_MESSAGES.kinds).sort()).toEqual([...NOTIFY_KINDS].sort());
    expect(Object.keys(HI_MESSAGES.kinds).sort()).toEqual([...NOTIFY_KINDS].sort());
  });
});

describe("the three classifications", () => {
  it("only classifies real kinds", () => {
    for (const list of [CRITICAL_KINDS, IN_APP_KINDS, NON_TRANSACTIONAL_KINDS]) {
      for (const kind of list) expect(isNotifyKind(kind)).toBe(true);
    }
  });

  it("treats every account-security message as critical", () => {
    for (const kind of [
      "verify-email",
      "magic-link",
      "password-changed",
      "device-approval",
      "login-new-device",
    ] as const) {
      expect(isCriticalKind(kind)).toBe(true);
    }
    expect(isCriticalKind("low-credits")).toBe(false);
    expect(isCriticalKind("export-ready")).toBe(false);
  });

  it("keeps the sign-in path out of the bell", () => {
    expect(isInAppKind("magic-link")).toBe(false);
    expect(isInAppKind("verify-email")).toBe(false);
    expect(isInAppKind("export-ready")).toBe(true);
  });

  /**
   * The rule this pins is a legal one as much as a product one: an unsubscribe
   * link on a message the recipient cannot opt out of is a promise the product
   * does not keep.
   */
  it("never offers unsubscribe on a critical or legally required message", () => {
    for (const kind of CRITICAL_KINDS) expect(allowsUnsubscribe(kind)).toBe(false);
    expect(allowsUnsubscribe("renewal-notice")).toBe(false);
    expect(allowsUnsubscribe("parental-waitlist")).toBe(false);
    expect(allowsUnsubscribe("low-credits")).toBe(true);
    expect(allowsUnsubscribe("share-comment")).toBe(true);
  });
});
