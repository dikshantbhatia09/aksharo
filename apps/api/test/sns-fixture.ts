/**
 * A throwaway X.509 certificate and a signer that produces real Amazon SNS
 * signatures over it.
 *
 * Generated per run rather than committed, for the reason `auth-harness.ts` gives
 * about the RS256 pair: a key in the repository is a shipped secret
 * (THREAT-MODEL T21), even a useless one. `crypto` can make the key but cannot
 * self-sign a certificate, so `openssl` does that one step; when it is missing,
 * `available` is false and the suites that need it skip with the reason rather
 * than failing for an environment problem.
 */
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalString } from "../src/notify/sns/sns-message.js";

import type { SnsMessage } from "../src/notify/sns/sns-message.js";

export interface SnsFixture {
  readonly available: boolean;
  readonly reason: string;
  /** PEM certificate, as `SigningCertURL` would serve it. */
  readonly certificate: string;
  /** Sign a message the way SNS does, over the canonical string. */
  sign(message: Omit<SnsMessage, "Signature">): SnsMessage;
}

function build(): SnsFixture {
  const directory = mkdtempSync(join(tmpdir(), "sns-fixture-"));
  try {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const keyPath = join(directory, "key.pem");
    const certPath = join(directory, "cert.pem");
    writeFileSync(keyPath, pair.privateKey);
    execFileSync(
      "openssl",
      // prettier-ignore
      [
        "req", "-new", "-x509",
        "-key", keyPath,
        "-out", certPath,
        "-days", "1",
        "-subj", "/CN=sns.ap-south-1.amazonaws.com",
      ],
      { stdio: "pipe" },
    );
    const certificate = execFileSync("openssl", ["x509", "-in", certPath], { encoding: "utf8" });

    return {
      available: true,
      reason: "",
      certificate,
      sign(message) {
        const signer = createSign(message.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1");
        signer.update(canonicalString({ ...message, Signature: "" }), "utf8");
        signer.end();
        return { ...message, Signature: signer.sign(pair.privateKey, "base64") };
      },
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      certificate: "",
      sign: (message) => ({ ...message, Signature: "" }),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const snsFixture: SnsFixture = build();

/** Certificate URL the fixture pretends to have been served from. */
export const SNS_CERT_URL =
  "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-fixture.pem";

/** A well-formed SNS notification carrying `body` as its `Message`. */
export function snsNotification(
  body: unknown,
  overrides: Partial<SnsMessage> = {},
): Omit<SnsMessage, "Signature"> {
  return {
    Type: "Notification",
    MessageId: "11111111-2222-3333-4444-555555555555",
    TopicArn: "arn:aws:sns:ap-south-1:123456789012:aksharo-mail-events",
    Message: JSON.stringify(body),
    Timestamp: "2026-09-02T05:00:00.000Z",
    SignatureVersion: "1",
    SigningCertURL: SNS_CERT_URL,
    ...overrides,
  } as Omit<SnsMessage, "Signature">;
}
