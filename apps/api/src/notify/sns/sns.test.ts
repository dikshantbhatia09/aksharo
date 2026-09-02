import { describe, expect, it } from "vitest";

import { parseSesEvent } from "./ses-event.js";
import {
  canonicalString,
  isSnsCertificateUrl,
  SnsMessageSchema,
  SnsVerificationError,
  verifySnsMessage,
} from "./sns-message.js";
import { SNS_CERT_URL, snsFixture, snsNotification } from "../../../test/sns-fixture.js";

import type { SnsMessage } from "./sns-message.js";

const CERT_URL = SNS_CERT_URL;

const BOUNCE = {
  notificationType: "Bounce",
  bounce: {
    bounceType: "Permanent",
    bounceSubType: "General",
    bouncedRecipients: [{ emailAddress: "gone@example.test" }],
  },
};

const notification = (overrides: Partial<SnsMessage> = {}): Omit<SnsMessage, "Signature"> =>
  snsNotification(BOUNCE, overrides);

const sign = snsFixture.sign;

describe("the certificate URL rule", () => {
  it("accepts only an https sns.<region>.amazonaws.com .pem", () => {
    expect(isSnsCertificateUrl(CERT_URL)).toBe(true);
    expect(
      isSnsCertificateUrl("https://sns.cn-north-1.amazonaws.com.cn/SimpleNotification-a.pem"),
    ).toBe(true);
  });

  /**
   * Each of these is a real published SNS-verification bug: a substring match on
   * the host, a scheme that is not https, or a path that is not a certificate.
   */
  it("rejects the shapes that have gone wrong in other implementations", () => {
    for (const url of [
      "http://sns.ap-south-1.amazonaws.com/a.pem",
      "https://sns.ap-south-1.amazonaws.com.evil.test/a.pem",
      "https://evil.test/sns.ap-south-1.amazonaws.com/a.pem",
      "https://sns.ap-south-1.amazonaws.com/a.txt",
      "https://s3.ap-south-1.amazonaws.com/a.pem",
      "not a url",
    ]) {
      expect(isSnsCertificateUrl(url), url).toBe(false);
    }
  });
});

describe("the canonical string", () => {
  it("is the required keys in order, each as name\\nvalue\\n", () => {
    const message = { ...notification(), Signature: "" } as SnsMessage;
    expect(canonicalString(message)).toBe(
      `Message\n${message.Message}\n` +
        `MessageId\n${message.MessageId}\n` +
        `Timestamp\n${message.Timestamp}\n` +
        `TopicArn\n${message.TopicArn}\n` +
        `Type\nNotification\n`,
    );
  });

  it("includes Subject when it is present and skips it when it is not", () => {
    const withSubject = { ...notification({ Subject: "Amazon SES" }), Signature: "" } as SnsMessage;
    expect(canonicalString(withSubject)).toContain("Subject\nAmazon SES\n");
  });

  it("uses the confirmation key set for a subscription message", () => {
    const message = {
      ...notification({
        Type: "SubscriptionConfirmation",
        Token: "tok",
        SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription",
      }),
      Signature: "",
    } as SnsMessage;
    const canonical = canonicalString(message);
    expect(canonical).toContain("SubscribeURL\n");
    expect(canonical).toContain("Token\ntok\n");
  });
});

describe.skipIf(!snsFixture.available)("signature verification", () => {
  it("accepts a message signed with the certificate's key", async () => {
    const message = sign(notification());
    await expect(
      verifySnsMessage(message, async () => snsFixture.certificate),
    ).resolves.toBeUndefined();
  });

  it("accepts signature version 2 (SHA-256)", async () => {
    const message = sign(notification({ SignatureVersion: "2" }));
    await expect(
      verifySnsMessage(message, async () => snsFixture.certificate),
    ).resolves.toBeUndefined();
  });

  /** The attack this blocks: replay a real signature over a different Message. */
  it("rejects a message whose body was changed after signing", async () => {
    const signed = sign(notification());
    const tampered: SnsMessage = {
      ...signed,
      Message: JSON.stringify({
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "victim@example.test" }],
        },
      }),
    };
    await expect(verifySnsMessage(tampered, async () => snsFixture.certificate)).rejects.toThrow(
      SnsVerificationError,
    );
  });

  it("rejects a certificate served from anywhere but SNS, without fetching it", async () => {
    let fetched = false;
    const message = {
      ...notification({ SigningCertURL: "https://evil.test/a.pem" }),
      Signature: "x",
    } as SnsMessage;
    await expect(
      verifySnsMessage(message, async () => {
        fetched = true;
        return snsFixture.certificate;
      }),
    ).rejects.toThrow(SnsVerificationError);
    expect(fetched).toBe(false);
  });

  it("rejects a fetch that fails and a response that is not a certificate", async () => {
    const message = { ...notification(), Signature: "x" } as SnsMessage;
    await expect(
      verifySnsMessage(message, async () => {
        throw new Error("HTTP 404");
      }),
    ).rejects.toThrow(/could not fetch/);
    await expect(verifySnsMessage(message, async () => "<html>nope</html>")).rejects.toThrow(
      /not a PEM certificate/,
    );
  });

  it("rejects a signature that is not even base64-decodable as a signature", async () => {
    const message = { ...notification(), Signature: "!!!not base64!!!" } as SnsMessage;
    await expect(verifySnsMessage(message, async () => snsFixture.certificate)).rejects.toThrow(
      SnsVerificationError,
    );
  });
});

describe("the message schema", () => {
  it("refuses anything that is not one of the three SNS types", () => {
    expect(SnsMessageSchema.safeParse({ Type: "Whatever" }).success).toBe(false);
    expect(SnsMessageSchema.safeParse({}).success).toBe(false);
    expect(SnsMessageSchema.safeParse({ ...notification(), Signature: "x" }).success).toBe(true);
  });
});

describe("SES event parsing", () => {
  it("reads a permanent bounce and its recipients", () => {
    const event = parseSesEvent(
      JSON.stringify({
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [{ emailAddress: "Gone@Example.Test" }],
        },
      }),
    );
    expect(event).toEqual({
      kind: "bounce",
      recipients: ["gone@example.test"],
      permanence: "permanent",
      reason: "Permanent/General",
    });
  });

  it("treats a transient bounce as temporary", () => {
    const event = parseSesEvent(
      JSON.stringify({
        eventType: "Bounce",
        bounce: {
          bounceType: "Transient",
          bounceSubType: "MailboxFull",
          bouncedRecipients: [{ emailAddress: "full@example.test" }],
        },
      }),
    );
    expect(event.permanence).toBe("transient");
    expect(event.reason).toBe("Transient/MailboxFull");
  });

  it("treats every complaint as permanent", () => {
    const event = parseSesEvent(
      JSON.stringify({
        notificationType: "Complaint",
        complaint: {
          complainedRecipients: [{ emailAddress: "cross@example.test" }],
          complaintFeedbackType: "abuse",
        },
      }),
    );
    expect(event).toEqual({
      kind: "complaint",
      recipients: ["cross@example.test"],
      permanence: "permanent",
      reason: "abuse",
    });
  });

  it("reads a delivery, whose recipients are bare strings", () => {
    const event = parseSesEvent(
      JSON.stringify({
        notificationType: "Delivery",
        delivery: { recipients: ["back@example.test"] },
      }),
    );
    expect(event).toEqual({ kind: "delivery", recipients: ["back@example.test"] });
  });

  /** SNS retries a 500 forever, so an unknown shape must be a quiet no-op. */
  it("never throws on something it does not recognise", () => {
    expect(parseSesEvent("not json")).toEqual({ kind: "other", recipients: [] });
    expect(parseSesEvent("null")).toEqual({ kind: "other", recipients: [] });
    expect(parseSesEvent(JSON.stringify({ eventType: "Open" }))).toEqual({
      kind: "other",
      recipients: [],
    });
    expect(
      parseSesEvent(JSON.stringify({ eventType: "Bounce", bounce: { bouncedRecipients: "x" } })),
    ).toMatchObject({ kind: "bounce", recipients: [] });
  });
});
