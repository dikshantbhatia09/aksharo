import { describe, expect, it } from "vitest";

import { IncrementalSha256, sha256Hex } from "./sha256";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("IncrementalSha256 against the FIPS 180-4 / RFC 6234 test vectors", () => {
  it("hashes the empty string", () => {
    expect(sha256Hex(utf8(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashes "abc"', () => {
    expect(sha256Hex(utf8("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the two-block 448-bit message", () => {
    expect(
      sha256Hex(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("hashes a known long message", () => {
    expect(sha256Hex(utf8("The quick brown fox jumps over the lazy dog"))).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });
});

describe("streaming (update() called many times) matches one call", () => {
  it("agrees with SubtleCrypto for a message that does not divide evenly by 64 bytes", async () => {
    const bytes = new Uint8Array(200_003);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    const streamed = new IncrementalSha256();
    // Deliberately not a multiple of the 64-byte block size, and not of any
    // convenient power of two, so a boundary bug would show up.
    const CHUNK = 7_919;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      streamed.update(bytes.subarray(offset, offset + CHUNK));
    }
    const streamedHex = streamed.digestHex();

    const expected = await crypto.subtle.digest("SHA-256", bytes);
    const expectedHex = [...new Uint8Array(expected)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    expect(streamedHex).toBe(expectedHex);
  });

  it("gives the same digest regardless of how the input is chunked", () => {
    const bytes = utf8("streaming a content hash across many small pieces of one file");

    const oneShot = sha256Hex(bytes);

    const byteAtATime = new IncrementalSha256();
    for (const byte of bytes) byteAtATime.update(new Uint8Array([byte]));

    expect(byteAtATime.digestHex()).toBe(oneShot);
  });

  it("throws rather than silently answer wrong after digestHex()", () => {
    const hasher = new IncrementalSha256();
    hasher.update(utf8("abc"));
    hasher.digestHex();
    expect(() => hasher.update(utf8("more"))).toThrow();
  });
});
