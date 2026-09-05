import { redirect } from "next/navigation";

/**
 * The `(share)` group serves real review links at `/share/{token}`. Its bare
 * root only ever rendered an engineering note about the route group, which is
 * not a page anyone should land on (F07-E7).
 */
export default function SharePage(): never {
  redirect("/");
}
