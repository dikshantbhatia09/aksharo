import { redirect } from "next/navigation";

/**
 * Where A04's confirmation email actually points.
 *
 * `AuthMailerService.webLink("/auth/verify-email", { token })` builds the link,
 * and 08 §3 calls the screen `/verify`. Rather than have two implementations or
 * change a link that is already in people's inboxes, this route forwards.
 */
export default async function VerifyEmailLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const token = (await searchParams)["token"];
  const value = Array.isArray(token) ? token[0] : token;
  redirect(value === undefined ? "/verify" : `/verify?token=${encodeURIComponent(value)}`);
}
