import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { PrismaService } from "../common/index.js";

/**
 * Crockford base32 minus ambiguous characters already excluded by Crockford
 * itself (`I`, `L`, `O`, `U`) — 8 characters of this alphabet is
 * 32^8 ≈ 1.1e12 possibilities, non-guessable per the brief (§1).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

@Injectable()
export class AffiliateCodeService {
  constructor(private readonly prisma: PrismaService) {}

  private random(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      const byte = bytes[i] ?? 0;
      out += ALPHABET[byte % ALPHABET.length];
    }
    return out;
  }

  /** Retries on the (astronomically unlikely) collision. */
  async generateUnique(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = this.random();
      const existing = await this.prisma.affiliate.findUnique({ where: { code } });
      if (existing === null) return code;
    }
    throw new Error("could not generate a unique affiliate code after 10 attempts");
  }
}
