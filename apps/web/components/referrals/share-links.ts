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

export function referralSignupUrl(code: string): string {
  return `https://${BRAND.domain}/signup?ref=${encodeURIComponent(code)}`;
}

export function referralShareMessage(code: string): string {
  return (
    `Edit vertical video 10x faster with ${BRAND.name} — captions, cuts and zooms in minutes. ` +
    `Use my code ${code} and we both get 30 free credits: ${referralSignupUrl(code)}`
  );
}

export function whatsappShareUrl(code: string): string {
  return `https://wa.me/?text=${encodeURIComponent(referralShareMessage(code))}`;
}

export function xShareUrl(code: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(referralShareMessage(code))}`;
}

/** Instagram has no web share-intent — this is the caption text a bio-link/story copy-paste needs. */
export function instagramCaption(code: string): string {
  return referralShareMessage(code);
}
