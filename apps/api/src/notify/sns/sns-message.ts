import { createVerify } from "node:crypto";

import { z } from "zod";

/**
 * Amazon SNS message signature verification (AWS SNS Developer Guide,
 * "Verifying the signatures of Amazon SNS messages").
 *
 * `POST /internal/mail/events` is a public, unauthenticated endpoint — SNS will
 * not send an HMAC header and cannot be given one — so the signature **is** the
 * authentication. Without it, anyone who guesses the path can suppress any
 * address on the platform, which is a denial-of-service against every mailbox
 * they name (THREAT-MODEL T16 is the same shape for Razorpay).
 *
 * Three checks, all of them required:
 *
 *   1. the message parses as one of the three SNS types, with every field the
 *      canonical string needs;
 *   2. the certificate URL is `https` on an `sns.<region>.amazonaws.com` host and
 *      ends in `.pem` — the guide's own rule, and the SSRF guard of 05 section 8:
 *      without it the endpoint fetches any URL an attacker writes;
 *   3. the RSA signature over the canonical string verifies against that
 *      certificate's public key.
 *
 * The certificate fetch is a port rather than a bare `fetch`, so the unit suite
 * signs a fixture with a throwaway key and never touches the network.
 */

export const SnsMessageSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]),
  MessageId: z.string().min(1),
  TopicArn: z.string().min(1),
  Subject: z.string().optional(),
  Message: z.string(),
  Timestamp: z.string().min(1),
  SignatureVersion: z.enum(["1", "2"]),
  Signature: z.string().min(1),
  SigningCertURL: z.string().min(1),
  Token: z.string().optional(),
  SubscribeURL: z.string().optional(),
  UnsubscribeURL: z.string().optional(),
});

export type SnsMessage = z.infer<typeof SnsMessageSchema>;

/** Fetches a PEM certificate for a URL this module has already validated. */
export type CertificateFetcher = (url: string) => Promise<string>;

export class SnsVerificationError extends Error {
  public override readonly name = "SnsVerificationError";
}

/**
 * `sns.<region>.amazonaws.com` over https, path ending `.pem`.
 *
 * `amazonaws.com.cn` is accepted because the China partitions use it; nothing
 * else is, and in particular a host that merely *contains* `amazonaws.com`
 * (`sns.amazonaws.com.evil.test`) fails, which is the mistake this check exists
 * to prevent.
 */
export function isSnsCertificateUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!/\.pem$/i.test(url.pathname)) return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i.test(url.hostname);
}

/**
 * The exact bytes SNS signed: the required keys in alphabetical order, each as
 * `name\nvalue\n`. Absent optional keys are skipped, which is why `Subject` is
 * conditional and why a confirmation carries `SubscribeURL` and `Token` while a
 * notification does not.
 */
export function canonicalString(message: SnsMessage): string {
  const keys =
    message.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : ([
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ] as const);

  let canonical = "";
  for (const key of keys) {
    const value = message[key as keyof SnsMessage];
    if (typeof value !== "string") continue;
    canonical += `${key}\n${value}\n`;
  }
  return canonical;
}

/**
 * Verify one message, or throw {@link SnsVerificationError}.
 *
 * Signature version 1 is SHA-1 and version 2 is SHA-256. Version 1 is still what
 * most topics emit; SHA-1 is weak against collisions, but a collision attack
 * needs both texts to be chosen and here one of them is AWS's, so the practical
 * risk is the certificate check, which is why that one is strict.
 */
export async function verifySnsMessage(
  message: SnsMessage,
  fetchCertificate: CertificateFetcher,
): Promise<void> {
  if (!isSnsCertificateUrl(message.SigningCertURL)) {
    throw new SnsVerificationError("SigningCertURL is not an Amazon SNS certificate URL.");
  }

  let certificate: string;
  try {
    certificate = await fetchCertificate(message.SigningCertURL);
  } catch (error) {
    throw new SnsVerificationError(
      `could not fetch the signing certificate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!certificate.includes("-----BEGIN CERTIFICATE-----")) {
    throw new SnsVerificationError("the signing certificate is not a PEM certificate.");
  }

  const algorithm = message.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  let verified: boolean;
  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonicalString(message), "utf8");
    verifier.end();
    verified = verifier.verify(certificate, message.Signature, "base64");
  } catch (error) {
    throw new SnsVerificationError(
      `signature check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!verified) throw new SnsVerificationError("the signature does not match.");
}

/**
 * Fetch a certificate over https with a short timeout and a size cap.
 *
 * The URL has already passed {@link isSnsCertificateUrl}, so this is not the SSRF
 * guard — it is the part that stops a slow or enormous response from holding a
 * request open. Redirects are not followed: an SNS certificate URL never
 * redirects, so one that does is not the thing it claims to be.
 */
export async function fetchSigningCertificate(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const text = await response.text();
  if (text.length > 16_384) throw new Error("certificate response is implausibly large");
  return text;
}
