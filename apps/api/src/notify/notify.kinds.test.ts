import { describe, expect, it } from "vitest";

import {
  allowsUnsubscribe,
  CRITICAL_KINDS,
  DEVICE_KINDS,
  IN_APP_KINDS,
  isCriticalKind,
  isDeviceKind,
  isInAppKind,
  isNotifyKind,
  NON_TRANSACTIONAL_KINDS,
  NOTIFY_KINDS,
} from "./notify.kinds.js";
import { EN_MESSAGES } from "./templates/messages.en.js";
import { HI_MESSAGES } from "./templates/messages.hi.js";

describe("the kind list", () => {
  it("is the templates the briefs name (B06 adds streak-nudge, B16 adds retention-warning)", () => {
    expect([...NOTIFY_KINDS].sort()).toEqual([
      "clips-ready",
      "device-approval",
      "export-ready",
      "login-new-device",
      "low-credits",
      "magic-link",
      "parental-waitlist",
      "password-changed",
      "renewal-notice",
      "retention-warning",
      "run-complete",
      "run-failed",
      "run-needs-you",
      "share-comment",
      "share-report-resolved",
      "streak-nudge",
      "support-ticket-created",
      "support-ticket-reply",
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
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      expect(EN_MESSAGES.kinds[kind], `en is missing ${kind}`).toBeDefined();
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      expect(HI_MESSAGES.kinds[kind], `hi is missing ${kind}`).toBeDefined();
    }
    expect(Object.keys(EN_MESSAGES.kinds).sort()).toEqual([...NOTIFY_KINDS].sort());
    expect(Object.keys(HI_MESSAGES.kinds).sort()).toEqual([...NOTIFY_KINDS].sort());
  });
});

describe("the four classifications", () => {
  it("only classifies real kinds", () => {
    for (const list of [CRITICAL_KINDS, IN_APP_KINDS, NON_TRANSACTIONAL_KINDS, DEVICE_KINDS]) {
      for (const kind of list) expect(isNotifyKind(kind)).toBe(true);
    }
  });

  /**
   * A tap on a phone notification opens the app; the bell is where the person
   * finds it again. A device kind with no bell row would be news that vanished
   * the moment it was swiped away.
   */
  it("keeps every device kind in the bell too, with device text in both languages", () => {
    for (const kind of DEVICE_KINDS) {
      expect(isInAppKind(kind), kind).toBe(true);
      expect(isDeviceKind(kind)).toBe(true);
      // eslint-disable-next-line security/detect-object-injection -- a typed kind from the closed list
      expect(EN_MESSAGES.kinds[kind].push, `en ${kind} has no push strings`).toBeDefined();
      // eslint-disable-next-line security/detect-object-injection -- as above
      expect(HI_MESSAGES.kinds[kind].push, `hi ${kind} has no push strings`).toBeDefined();
    }
    expect(isDeviceKind("export-ready")).toBe(false);
    expect(isDeviceKind("magic-link")).toBe(false);
  });

  it("sends the run notifications as the answer to what the person started, not as marketing", () => {
    for (const kind of ["clips-ready", "run-complete", "run-failed", "run-needs-you"] as const) {
      expect(isCriticalKind(kind)).toBe(false);
      expect(allowsUnsubscribe(kind)).toBe(false);
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
