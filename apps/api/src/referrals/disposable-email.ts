/**
 * Disposable-email domain check (THREAT-MODEL T17: "self-referral including
 * via another email"). Not exhaustive — a short, maintained deny-list of the
 * most common throwaway-inbox providers, matched case-insensitively against
 * the domain only (never the local part, which is free-form and not a
 * fraud signal by itself).
 */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "10minutemail.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "trashmail.com",
  "throwawaymail.com",
  "getnada.com",
  "dispostable.com",
  "sharklasers.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (domain === undefined) return false;
  return DISPOSABLE_DOMAINS.has(domain);
}
