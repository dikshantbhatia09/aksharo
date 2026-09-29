import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * Web Push with nothing but `node:crypto` (2026-09-29).
 *
 * There is no `web-push` package in the lockfile and this machine cannot take a
 * new dependency, so the two standards a push service checks are implemented
 * here, small and exact:
 *
 *   * **RFC 8291 + RFC 8188 (`aes128gcm`)**: the payload is encrypted to the
 *     browser's own key (`p256dh`) and secret (`auth`), so the push service
 *     relaying it (Google, Mozilla, Microsoft, Apple) never reads it.
 *     `web-push.crypto.test.ts` reproduces the RFC 8291 Appendix A example byte
 *     for byte, which is what makes this correct rather than plausible.
 *   * **RFC 8292 (VAPID)**: every request carries a short ES256 JWT signed with
 *     this server's key, which is how a push service knows the sender is the
 *     one the browser subscribed with.
 *
 * Every key on the wire is base64url without padding, as browsers produce it
 * (`PushSubscription.toJSON()`) and as `applicationServerKey` accepts it.
 */

/** An uncompressed P-256 point: `0x04 || X || Y`. */
const P256_PUBLIC_KEY_BYTES = 65;
const P256_PRIVATE_KEY_BYTES = 32;
/** RFC 8291 §3.2: the authentication secret is 16 bytes. */
const AUTH_SECRET_BYTES = 16;
/** RFC 8188 §2.1: 16 bytes of salt per message. */
const SALT_BYTES = 16;
/**
 * The record size written into the header. One record carries the whole
 * message; 4096 is what RFC 8291's own example uses and what every push
 * service accepts, and it bounds a payload at 4096 - 17 bytes (delimiter + tag).
 */
export const PUSH_RECORD_SIZE = 4096;
/** The most plaintext one record carries: the record less the delimiter and the GCM tag. */
export const MAX_PUSH_PLAINTEXT_BYTES = PUSH_RECORD_SIZE - 1 - 16;
/** RFC 8292 §2: a VAPID token must not be valid for more than 24 hours. */
export const VAPID_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Strict base64url: Node's own decoder skips characters it does not know, so
 * `"ab$cd"` would decode to something. A key that is not base64url at all is a
 * bad key, and says so.
 */
export function base64UrlDecode(text: string): Buffer {
  if (!BASE64URL.test(text)) throw new Error("not base64url");
  return Buffer.from(text.replace(/=+$/, ""), "base64url");
}

/** Thrown for a browser key or secret that cannot be encrypted to. */
export class PushKeyError extends Error {
  public override readonly name = "PushKeyError";
}

/**
 * A browser's `p256dh`: 65 bytes, an uncompressed point that is actually on
 * P-256. Checked by doing an ECDH with it, which is the one test that cannot
 * be fooled by a string of the right length.
 */
export function assertUserAgentPublicKey(key: Uint8Array): void {
  if (key.length !== P256_PUBLIC_KEY_BYTES || key[0] !== 0x04) {
    throw new PushKeyError("p256dh is not an uncompressed P-256 public key");
  }
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(key);
  } catch {
    throw new PushKeyError("p256dh is not a point on P-256");
  }
}

export function assertAuthSecret(secret: Uint8Array): void {
  if (secret.length !== AUTH_SECRET_BYTES) {
    throw new PushKeyError("auth is not a 16-byte secret");
  }
}

export interface PushEncryptionInput {
  readonly plaintext: Uint8Array;
  /** The subscription's `keys.p256dh`, decoded. */
  readonly userAgentPublicKey: Uint8Array;
  /** The subscription's `keys.auth`, decoded. */
  readonly authSecret: Uint8Array;
  /**
   * Test seams only: RFC 8291 Appendix A fixes both. In production each
   * message gets a fresh salt and a fresh key pair, which is what RFC 8291
   * §3.1 requires ("a new ephemeral key pair for every message").
   */
  readonly salt?: Uint8Array;
  readonly applicationServerPrivateKey?: Uint8Array;
}

/** The intermediate values, for the test that checks them against the RFC. */
export interface PushEncryptionTrace {
  readonly sharedSecret: Buffer;
  readonly ikm: Buffer;
  readonly cek: Buffer;
  readonly nonce: Buffer;
}

/**
 * RFC 8291 §3.4: encrypt one push message.
 *
 * ```
 * ecdh_secret = ECDH(as_private, ua_public)
 * IKM   = HKDF(salt = auth_secret, ikm = ecdh_secret,
 *              info = "WebPush: info" || 0x00 || ua_public || as_public, L = 32)
 * CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm" || 0x00, 16)
 * NONCE = HKDF(salt, IKM, "Content-Encoding: nonce" || 0x00, 12)
 * body  = salt || rs (uint32) || idlen (65) || as_public
 *         || AES-128-GCM(CEK, NONCE, plaintext || 0x02)
 * ```
 *
 * One record, no padding: the `0x02` is RFC 8188's last-record delimiter.
 */
export function encryptPushPayload(input: PushEncryptionInput): Buffer {
  return encryptWithTrace(input).body;
}

export function encryptWithTrace(input: PushEncryptionInput): {
  readonly body: Buffer;
  readonly trace: PushEncryptionTrace;
} {
  const uaPublic = Buffer.from(input.userAgentPublicKey);
  const authSecret = Buffer.from(input.authSecret);
  assertUserAgentPublicKey(uaPublic);
  assertAuthSecret(authSecret);
  if (input.plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new RangeError(
      `a push payload is at most ${String(MAX_PUSH_PLAINTEXT_BYTES)} bytes; this one is ${String(input.plaintext.length)}`,
    );
  }

  const ecdh = createECDH("prime256v1");
  if (input.applicationServerPrivateKey === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(Buffer.from(input.applicationServerPrivateKey));
  }
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));

  const salt = Buffer.from(input.salt ?? randomBytes(SALT_BYTES));
  if (salt.length !== SALT_BYTES) throw new RangeError("the salt must be 16 bytes");
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12),
  );

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(input.plaintext), Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(SALT_BYTES + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(PUSH_RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(asPublic.length, SALT_BYTES + 4);
  asPublic.copy(header, SALT_BYTES + 5);

  return {
    body: Buffer.concat([header, ciphertext]),
    trace: { sharedSecret, ikm, cek, nonce },
  };
}

/** This server's VAPID key pair, parsed once. */
export interface VapidKeys {
  /** 65 bytes, uncompressed: what the browser subscribes with and `k=` carries. */
  readonly publicKey: Buffer;
  readonly privateKey: KeyObject;
}

/** Left-pad a big-endian scalar to 32 bytes (a key can start with zero bytes). */
function padScalar(bytes: Buffer): Buffer {
  if (bytes.length === P256_PRIVATE_KEY_BYTES) return bytes;
  if (bytes.length > P256_PRIVATE_KEY_BYTES)
    throw new PushKeyError("the VAPID private key is too long");
  return Buffer.concat([Buffer.alloc(P256_PRIVATE_KEY_BYTES - bytes.length), bytes]);
}

/**
 * Parse `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY`: base64url
 * of the 65-byte public point and the 32-byte private scalar, the format the
 * `web-push` tooling everyone else uses prints (so keys move between the two).
 *
 * The public key is derived from the private one and must match what was
 * configured: a pair copied from two different generations would sign tokens
 * the push service rejects for every single message, which is far harder to
 * see there than here.
 *
 * @throws PushKeyError when either is malformed or they are not one pair.
 */
export function vapidKeysFrom(publicKeyText: string, privateKeyText: string): VapidKeys {
  let privateBytes: Buffer;
  let configuredPublic: Buffer;
  try {
    privateBytes = padScalar(base64UrlDecode(privateKeyText.trim()));
    configuredPublic = base64UrlDecode(publicKeyText.trim());
  } catch (error) {
    if (error instanceof PushKeyError) throw error;
    throw new PushKeyError("a VAPID key is not base64url");
  }
  const ecdh = createECDH("prime256v1");
  try {
    ecdh.setPrivateKey(privateBytes);
  } catch {
    throw new PushKeyError("the VAPID private key is not a P-256 key");
  }
  const derivedPublic = ecdh.getPublicKey();
  if (!derivedPublic.equals(configuredPublic)) {
    throw new PushKeyError("the VAPID public key does not belong to the private key");
  }
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: base64UrlEncode(privateBytes),
      x: base64UrlEncode(derivedPublic.subarray(1, 33)),
      y: base64UrlEncode(derivedPublic.subarray(33, 65)),
    },
    format: "jwk",
  });
  return { publicKey: derivedPublic, privateKey };
}

/**
 * A fresh VAPID key pair, as the two environment values. What
 * `scripts/generate-vapid-keys.mjs` prints, restated here for the tests.
 */
export function generateVapidKeys(): { readonly publicKey: string; readonly privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(padScalar(ecdh.getPrivateKey())),
  };
}

export interface VapidTokenInput {
  /** The push endpoint's origin (`https://fcm.googleapis.com`): RFC 8292 §2's `aud`. */
  readonly audience: string;
  /** `mailto:` or `https:` — who the push service can contact about this sender. */
  readonly subject: string;
  readonly keys: VapidKeys;
  /** Seconds since the epoch. At most 24 hours ahead (RFC 8292 §2). */
  readonly expiresAt: number;
}

/**
 * The `Authorization` header for one push request (RFC 8292 §3):
 * `vapid t=<ES256 JWT>, k=<public key>`. ES256 wants the raw 64-byte `r || s`
 * signature, not DER, which is what `dsaEncoding: "ieee-p1363"` gives.
 */
export function vapidAuthorization(input: VapidTokenInput): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    Buffer.from(
      JSON.stringify({ aud: input.audience, exp: Math.floor(input.expiresAt), sub: input.subject }),
    ),
  );
  const signed = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(signed), {
    key: input.keys.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${signed}.${base64UrlEncode(signature)}, k=${base64UrlEncode(input.keys.publicKey)}`;
}
