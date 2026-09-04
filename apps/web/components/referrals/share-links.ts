import { BRAND } from "@montaj/config";

/**
 * The share surfaces for the give-get referral loop (brief §3: "copy
 * link/code and share buttons — WhatsApp, X, Instagram copy").
 *
 * Instagram has no web share-intent URL (it only accepts shares from its own
 * apps), so "Instagram copy" is a copy-to-clipboard affordance with caption
 * text formatted for a bio-link/story sticker, not a deep link — the same
 * distinction the brief draws by naming it "copy" rather than "share".
 */

/**
 * Every link here builds from `origin` — the runtime config's `webOrigin`, i.e.
 * the deployment the sharer is actually using. Hard-coding the production
 * domain meant a local or staging build handed out links to a site the tester
 * has no account on (F07-E8).
 */
export function referralSignupUrl(code: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/signup?ref=${encodeURIComponent(code)}`;
}

export function referralShareMessage(code: string, origin: string): string {
  return (
    `Edit vertical video 10x faster with ${BRAND.name} — captions, cuts and zooms in minutes. ` +
    `Use my code ${code} and we both get 30 free credits: ${referralSignupUrl(code, origin)}`
  );
}

export function whatsappShareUrl(code: string, origin: string): string {
  return `https://wa.me/?text=${encodeURIComponent(referralShareMessage(code, origin))}`;
}

export function xShareUrl(code: string, origin: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    referralShareMessage(code, origin),
  )}`;
}

/** Instagram has no web share-intent — this is the caption text a bio-link/story copy-paste needs. */
export function instagramCaption(code: string, origin: string): string {
  return referralShareMessage(code, origin);
}
