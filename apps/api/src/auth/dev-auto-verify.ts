import type { Env } from "@montaj/config";

/**
 * Whether a sign-up may bypass mailbox ownership verification on this process.
 *
 * Threat-model invariant: this convenience is never valid outside the development
 * outbox. Requiring `MAIL_PROVIDER=dev` here, next to the decision itself, means an
 * accidentally retained `AUTH_DEV_AUTO_VERIFY=1` becomes inert as soon as a real
 * SMTP or SES transport is selected.
 */
export function devAutoVerifyEnabled(
  env: Pick<Env, "AUTH_DEV_AUTO_VERIFY" | "MAIL_PROVIDER">,
): boolean {
  return env.MAIL_PROVIDER === "dev" && env.AUTH_DEV_AUTO_VERIFY;
}
