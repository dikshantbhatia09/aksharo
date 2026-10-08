import { describe, expect, it } from "vitest";
import { VaultService } from "./vault.service.js";

describe("VaultService", () => {
  it("encrypts and decrypts OAuth access and refresh tokens successfully", () => {
    const vault = new VaultService("test-secret-key-12345");
    const token = "ya29.a0AfH6SMD_google_oauth_token_example_123456789";

    const encrypted = vault.encrypt(token);
    expect(encrypted).not.toBe(token);
    expect(encrypted.split(":")).toHaveLength(3);

    const decrypted = vault.decrypt(encrypted);
    expect(decrypted).toBe(token);
  });

  it("produces different ciphertexts for the same plaintext due to random IV", () => {
    const vault = new VaultService("test-secret-key-12345");
    const secret = "dropbox_refresh_token_abc123";

    const enc1 = vault.encrypt(secret);
    const enc2 = vault.encrypt(secret);

    expect(enc1).not.toBe(enc2);
    expect(vault.decrypt(enc1)).toBe(secret);
    expect(vault.decrypt(enc2)).toBe(secret);
  });

  it("fails decryption if ciphertext is tampered with", () => {
    const vault = new VaultService("test-secret-key-12345");
    const encrypted = vault.encrypt("sensitive_token");
    const [iv, tag, ct] = encrypted.split(":");

    // Tamper with ciphertext
    const tamperedCt = ct!.slice(0, -2) + "aa";
    const tampered = `${iv}:${tag}:${tamperedCt}`;

    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it("fails decryption if authTag is tampered with", () => {
    const vault = new VaultService("test-secret-key-12345");
    const encrypted = vault.encrypt("sensitive_token");
    const [iv, tag, ct] = encrypted.split(":");

    // Tamper with tag
    const tamperedTag = tag!.slice(0, -2) + "zz";
    const tampered = `${iv}:${tamperedTag}:${ct}`;

    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it("fails decryption with a different secret key", () => {
    const vault1 = new VaultService("key-1");
    const vault2 = new VaultService("key-2");

    const encrypted = vault1.encrypt("token_value");
    expect(() => vault2.decrypt(encrypted)).toThrow();
  });

  it("throws on invalid input shapes", () => {
    const vault = new VaultService();
    expect(() => vault.encrypt("")).toThrow();
    expect(() => vault.decrypt("")).toThrow();
    expect(() => vault.decrypt("invalid:payload")).toThrow();
  });
});

