import { redirect } from "next/navigation";

/** Where A04's magic-link email points; 08 §3 calls the screen `/magic`. */
export default async function MagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const token = (await searchParams)["token"];
  const value = Array.isArray(token) ? token[0] : token;
  redirect(value === undefined ? "/magic" : `/magic?token=${encodeURIComponent(value)}`);
}
