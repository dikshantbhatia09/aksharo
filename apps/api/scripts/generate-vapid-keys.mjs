#!/usr/bin/env node
/**
 * Print a fresh VAPID key pair for Web Push (2026-09-29), as the two lines
 * `.env.local-run` takes:
 *
 *   node apps/api/scripts/generate-vapid-keys.mjs
 *
 * `node:crypto` only - the same P-256 key `notify/push/web-push.crypto.ts`
 * signs with, base64url without padding (65-byte public point, 32-byte private
 * scalar), which is also the format the `web-push` tooling prints, so a pair
 * moves between the two.
 *
 * Generate it ONCE per deployment. Every browser subscribes with the public
 * key; a new pair makes every existing subscription useless (the push services
 * refuse our tokens for them) until each person turns notifications on again.
 * The private key is a secret: it goes in the env file and nowhere else.
 */
import { createECDH } from "node:crypto";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const privateKey = ecdh.getPrivateKey();
// A scalar can start with zero bytes; keep it the 32 bytes every reader expects.
const scalar = Buffer.concat([Buffer.alloc(Math.max(0, 32 - privateKey.length)), privateKey]);

process.stdout.write(
  [
    `WEB_PUSH_VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString("base64url")}`,
    `WEB_PUSH_VAPID_PRIVATE_KEY=${scalar.toString("base64url")}`,
    "",
  ].join("\n"),
);
