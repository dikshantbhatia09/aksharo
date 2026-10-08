import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";

const HKDF_INFO = Buffer.from("montaj.cloud.vault.v1");
const HKDF_SALT = Buffer.from("montaj-cloud-vault-salt");
const ALGO = "aes-256-gcm";

/**
 * VaultService: Secure AES-256-GCM encryption & decryption at rest
 * for third-party cloud storage OAuth tokens (Google Drive, Dropbox, Box, OneDrive).
 *
 * Implements Step 1 of Pillar 1 §02 Cloud Storage Connectors.
 */
@Injectable()
export class VaultService {
  private readonly key: Buffer;

  constructor(secretOverride?: string) {
    const rawSecret =
      secretOverride ||
      process.env["ENCRYPTION_KEY"] ||
      process.env["INTERNAL_CALLBACK_SECRET"] ||
      "aksharo-cloud-vault-fallback-secret-2026";
    this.key = deriveKey(rawSecret);
  }

  /**
   * Encrypt plaintext string into `iv:authTag:ciphertext` encoded in base64url.
   */
  encrypt(plaintext: string): string {
    if (!plaintext) {
      throw new Error("Cannot encrypt empty or undefined text");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((b) => b.toString("base64url")).join(":");
  }

  /**
   * Decrypt `iv:authTag:ciphertext` base64url payload back to plaintext UTF-8.
   * Throws an error if data is malformed or tampered with.
   */
  decrypt(encryptedPayload: string): string {
    if (!encryptedPayload) {
      throw new Error("Cannot decrypt empty payload");
    }
    const parts = encryptedPayload.split(":");
    if (parts.length !== 3) {
      throw new Error("Malformed encrypted payload: expected iv:authTag:ciphertext");
    }
    const [ivB64, authTagB64, ctB64] = parts;
    if (!ivB64 || !authTagB64 || !ctB64) {
      throw new Error("Malformed encrypted payload segments");
    }

    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(authTagB64, "base64url");
    const ciphertext = Buffer.from(ctB64, "base64url");

    if (iv.length !== 12) {
      throw new Error("Invalid IV length for AES-256-GCM");
    }

    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

function deriveKey(secret: string): Buffer {
  const bytes = hkdfSync("sha256", Buffer.from(secret, "utf8"), HKDF_SALT, HKDF_INFO, 32);
  return Buffer.from(bytes);
}

