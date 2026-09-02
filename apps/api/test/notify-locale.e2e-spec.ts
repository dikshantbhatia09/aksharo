/**
 * A25b: transactional mail is written in the recipient's own language.
 *
 * The whole point of two message catalogues is that a Hindi user gets Hindi, and
 * the only way to prove that end to end is a real sign-up: `users.locale` is set
 * by the sign-up request, read back by the auth flows, carried on the notify job
 * and used by the renderer three layers later. A unit test on any one of those
 * layers would pass while the chain was broken.
 *
 * It reuses A04's harness — real PostgreSQL, real Redis, the real `notify`
 * consumer writing to the development outbox — rather than A04's spec file, so
 * this work package adds a suite instead of editing another one's.
 */
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authSkipReason, createAuthTestContext } from "./auth-harness.js";
import { isDatabaseAvailable, skipReason } from "./db-harness.js";

import type { AuthTestContext, OutboxEntry } from "./auth-harness.js";
import type { Server } from "node:http";

const available = isDatabaseAvailable();
if (!available) {
  console.warn(`[notify-locale.e2e] SKIPPED - ${skipReason}`);
}

const PASSWORD = "correct-horse-battery-staple";
const ADULT_DOB = "1996-01-15";

describe.skipIf(!available)("transactional mail follows users.locale (e2e)", () => {
  let ctx: AuthTestContext;
  let server: Server;

  beforeAll(async () => {
    const created = await createAuthTestContext();
    if (created === null) throw new Error(`auth harness unavailable: ${authSkipReason}`);
    ctx = created;
    server = ctx.app.getHttpServer() as Server;
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const address = (label: string) => `${label}-${Date.now().toString(36)}@example.test`;

  async function signUp(email: string, locale: string | undefined, ip: string): Promise<void> {
    await request(server)
      .post("/auth/signup")
      .set("X-Forwarded-For", ip)
      .send({
        email,
        password: PASSWORD,
        name: "Asha",
        dateOfBirth: ADULT_DOB,
        jurisdiction: "IN",
        ...(locale === undefined ? {} : { locale }),
      })
      .expect(202);
  }

  async function messageFor(template: string): Promise<OutboxEntry> {
    const message = (await ctx.outbox()).find((entry) => entry.template === template);
    expect(message, `no ${template} message in the outbox`).toBeDefined();
    return message as OutboxEntry;
  }

  it("writes to a hi-IN user in Hindi, and greets them by name", async () => {
    await signUp(address("hindi"), "hi-IN", "203.0.113.90");

    const message = await messageFor("email_verification");
    expect(message.locale).toBe("hi");
    expect(message.subject).toBe("अपना ईमेल पता कन्फ़र्म करें");
    expect(message.text).toContain("नमस्ते Asha,");
    // The link still has to work: a translated message is not a different flow.
    expect(message.token).toBeTruthy();
    expect(message.link).toContain("/auth/verify-email");
  });

  it("writes to an en-IN user in English", async () => {
    await signUp(address("english"), "en-IN", "203.0.113.91");

    const message = await messageFor("email_verification");
    expect(message.locale).toBe("en");
    expect(message.subject).toBe("Confirm your email address");
    expect(message.text).toContain("Hi Asha,");
  });

  it("falls back to English for a language with no catalogue", async () => {
    await signUp(address("marathi"), "mr-IN", "203.0.113.92");

    const message = await messageFor("email_verification");
    expect(message.locale).toBe("en");
    expect(message.subject).toBe("Confirm your email address");
  });

  /**
   * The second half of the chain: this message is sent from a *stored* row rather
   * than from the request that created it, so it proves `users.locale` is read
   * back and not just echoed.
   */
  it("uses the stored locale for a magic link, long after sign-up", async () => {
    const email = address("magic-hindi");
    await signUp(email, "hi-IN", "203.0.113.93");
    await ctx.reset();

    // `reset()` truncates `users`, so sign the user up again and then ask for a
    // link in a second request that carries no locale of its own.
    await signUp(email, "hi-IN", "203.0.113.93");
    await request(server)
      .post("/auth/magic-link")
      .set("X-Forwarded-For", "203.0.113.93")
      .send({ email })
      .expect(202);

    const message = await messageFor("magic_link");
    expect(message.locale).toBe("hi");
    expect(message.subject).toBe("आपका साइन-इन लिंक");
    expect(message.text).toContain("नमस्ते Asha,");
  });

  it("defaults to the account's own default when the sign-up sent no locale", async () => {
    await signUp(address("nolocale"), undefined, "203.0.113.94");

    const message = await messageFor("email_verification");
    // `users.locale` defaults to en-IN, and the sign-up path passes what it was
    // given, so an omitted locale is English either way.
    expect(message.locale).toBe("en");
  });
});
