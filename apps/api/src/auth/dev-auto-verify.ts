import type { Env } from "@montaj/config";

/**
 * Whether a sign-up may bypass mailbox ownership verification on this process.
 *
 * Threat-model invariant: this convenience is never valid outside the development
 * outbox. Requiring `MAIL_PROVIDER=dev` here, next to the decision itself, means an
 * accidentally retained `AUTH_DEV_AUTO_VERIFY=1` becomes inert as soon as a real
 * SMTP or SES transport is selected.
 *
 * Blast radius, so nobody re-enables this casually: `emailVerifiedAt` is not only
 * mailbox proof. `MembersService` treats it as the authorisation gate for listing
 * and accepting pending workspace invitations — "anybody can type an address into a
 * sign-up form, and an invitation is an authorisation grant". Auto-verifying a
 * sign-up therefore hands whoever typed the address any invitation waiting for it.
 *
 * Defence in depth: `crossFieldProblems` in `@montaj/config` already refuses to boot
 * on every unsafe combination (a non-dev transport, a merely-defaulted MAIL_PROVIDER,
 * or NODE_ENV=production). The `NODE_ENV` term is repeated here because the validated
 * `Env` is a mutable singleton, so boot-time validation is not by itself an
 * enforcement boundary for a value read on every sign-up.
 */
export function devAutoVerifyEnabled(
  env: Pick<Env, "AUTH_DEV_AUTO_VERIFY" | "MAIL_PROVIDER">,
): boolean {
  if (process.env["NODE_ENV"] === "production") return false;
  return env.MAIL_PROVIDER === "dev" && env.AUTH_DEV_AUTO_VERIFY;
}
