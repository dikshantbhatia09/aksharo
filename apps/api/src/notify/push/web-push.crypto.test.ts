import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_PUSH_PLAINTEXT_BYTES,
  PushKeyError,
  assertUserAgentPublicKey,
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
  encryptWithTrace,
  generateVapidKeys,
  vapidAuthorization,
  vapidKeysFrom,
} from "./web-push.crypto.js";

/**
 * RFC 8291 Appendix A, "Intermediate Values for Encryption": the worked
 * example every Web Push implementation is checked against. The RFC prints the
 * finished message as its header and its ciphertext, each base64url on its own.
 */
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  sharedSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
} as const;

/** The header's length: salt, record size, key-id length, and a 65-byte key. */
const HEADER_BYTES = 16 + 4 + 1 + 65;

/**
 * The browser's side of RFC 8291, written out here so a message this module
 * encrypts with a random salt and key can be read back — what a browser does
 * with every push it receives.
 */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  expect(recordSize).toBeGreaterThanOrEqual(ciphertext.length);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  // The last record ends in 0x02, then any zero padding.
  let end = record.length - 1;
  while (end >= 0 && record.at(end) === 0x00) end -= 1;
  expect(record.at(end)).toBe(0x02);
  return record.subarray(0, end);
}

describe("RFC 8291 Appendix A", () => {
  const run = () =>
    encryptWithTrace({
      plaintext: Buffer.from(RFC8291.plaintext, "ascii"),
      userAgentPublicKey: base64UrlDecode(RFC8291.uaPublic),
      authSecret: base64UrlDecode(RFC8291.authSecret),
      salt: base64UrlDecode(RFC8291.salt),
      applicationServerPrivateKey: base64UrlDecode(RFC8291.asPrivate),
    });

  it("derives the RFC's shared secret, IKM, CEK and nonce", () => {
    const { trace } = run();
    expect(base64UrlEncode(trace.sharedSecret)).toBe(RFC8291.sharedSecret);
    expect(base64UrlEncode(trace.ikm)).toBe(RFC8291.ikm);
    expect(base64UrlEncode(trace.cek)).toBe(RFC8291.cek);
    expect(base64UrlEncode(trace.nonce)).toBe(RFC8291.nonce);
  });

  it("produces the RFC's message byte for byte: header, then ciphertext", () => {
    const { body } = run();
    expect(body.length).toBe(HEADER_BYTES + RFC8291.plaintext.length + 1 + 16);
    expect(base64UrlEncode(body.subarray(0, HEADER_BYTES))).toBe(RFC8291.header);
    expect(base64UrlEncode(body.subarray(HEADER_BYTES))).toBe(RFC8291.ciphertext);
    // The key in the header is the application server's public key.
    expect(base64UrlEncode(body.subarray(21, HEADER_BYTES))).toBe(RFC8291.asPublic);
  });

  it("is read back by the browser's side with the RFC's user agent key", () => {
    const { body } = run();
    const plain = decryptAsBrowser(
      body,
      base64UrlDecode(RFC8291.uaPrivate),
      base64UrlDecode(RFC8291.authSecret),
    );
    expect(plain.toString("ascii")).toBe(RFC8291.plaintext);
  });
});

describe("encryptPushPayload in production (fresh salt and key per message)", () => {
  const browser = createECDH("prime256v1");
  browser.generateKeys();
  const auth = Buffer.from("0123456789abcdef");

  it("round-trips a real notification through a browser's decryption", () => {
    const message = JSON.stringify({ title: "Your clips are ready", url: "/repurpose/01J" });
    const body = encryptPushPayload({
      plaintext: Buffer.from(message),
      userAgentPublicKey: browser.getPublicKey(),
      authSecret: auth,
    });
    expect(decryptAsBrowser(body, browser.getPrivateKey(), auth).toString()).toBe(message);
  });

  it("never repeats a salt or a key: two messages share nothing but the recipient", () => {
    const encrypt = () =>
      encryptPushPayload({
        plaintext: Buffer.from("same"),
        userAgentPublicKey: browser.getPublicKey(),
        authSecret: auth,
      });
    const first = encrypt();
    const second = encrypt();
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(21, HEADER_BYTES).equals(second.subarray(21, HEADER_BYTES))).toBe(false);
  });

  it("refuses a payload one record cannot hold", () => {
    expect(() =>
      encryptPushPayload({
        plaintext: Buffer.alloc(MAX_PUSH_PLAINTEXT_BYTES + 1),
        userAgentPublicKey: browser.getPublicKey(),
        authSecret: auth,
      }),
    ).toThrow(RangeError);
  });

  it("refuses browser keys that are not a P-256 point or a 16-byte secret", () => {
    const notAPoint = Buffer.alloc(65, 1);
    notAPoint[0] = 0x04;
    expect(() => assertUserAgentPublicKey(notAPoint)).toThrow(PushKeyError);
    expect(() => assertUserAgentPublicKey(browser.getPublicKey().subarray(0, 33))).toThrow(
      PushKeyError,
    );
    expect(() =>
      encryptPushPayload({
        plaintext: Buffer.from("x"),
        userAgentPublicKey: browser.getPublicKey(),
        authSecret: Buffer.alloc(8),
      }),
    ).toThrow(PushKeyError);
  });
});

describe("base64url", () => {
  it("decodes what browsers send, with or without padding, and nothing else", () => {
    expect(base64UrlDecode("AQID").equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(base64UrlDecode("AQI=").equals(Buffer.from([1, 2]))).toBe(true);
    expect(() => base64UrlDecode("ab$cd")).toThrow();
    expect(() => base64UrlDecode("ab+/")).toThrow();
  });
});

describe("VAPID (RFC 8292)", () => {
  const generated = generateVapidKeys();
  const keys = vapidKeysFrom(generated.publicKey, generated.privateKey);

  function parse(authorization: string) {
    const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization);
    expect(match).not.toBeNull();
    const [token = "", key = ""] = [match?.[1], match?.[2]];
    const [header = "", claims = "", signature = ""] = token.split(".");
    return { token, key, header, claims, signature };
  }

  it("prints a key pair in the format browsers and the web-push tools use", () => {
    expect(base64UrlDecode(generated.publicKey)).toHaveLength(65);
    expect(base64UrlDecode(generated.privateKey)).toHaveLength(32);
    expect(keys.publicKey.equals(base64UrlDecode(generated.publicKey))).toBe(true);
  });

  it("signs an ES256 token the public key verifies, with the claims RFC 8292 asks for", () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 12 * 3600;
    const parts = parse(
      vapidAuthorization({
        audience: "https://fcm.googleapis.com",
        subject: "mailto:alerts@example.test",
        keys,
        expiresAt,
      }),
    );
    expect(parts.key).toBe(generated.publicKey);
    expect(JSON.parse(base64UrlDecode(parts.header).toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(base64UrlDecode(parts.claims).toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: expiresAt,
      sub: "mailto:alerts@example.test",
    });

    const signature = base64UrlDecode(parts.signature);
    expect(signature).toHaveLength(64); // raw r || s, not DER
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64UrlEncode(keys.publicKey.subarray(1, 33)),
        y: base64UrlEncode(keys.publicKey.subarray(33, 65)),
      },
      format: "jwk",
    });
    const signed = Buffer.from(`${parts.header}.${parts.claims}`);
    expect(verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(
      true,
    );
    // And not for anything else.
    expect(
      verify(
        "sha256",
        Buffer.from("tampered"),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        signature,
      ),
    ).toBe(false);
  });

  it("refuses a public key from a different pair, and keys that are not keys", () => {
    const other = generateVapidKeys();
    expect(() => vapidKeysFrom(other.publicKey, generated.privateKey)).toThrow(PushKeyError);
    expect(() => vapidKeysFrom("not base64url!", generated.privateKey)).toThrow(PushKeyError);
    expect(() => vapidKeysFrom(generated.publicKey, "")).toThrow(PushKeyError);
  });
});
