/**
 * The closed set of things the platform sends, and the three properties that
 * decide how each one is treated.
 *
 * Adding a kind is: a name here, a row in each of the three tables below, and an
 * English and a Hindi entry in `templates/messages.*.ts`. `notify.kinds.test.ts`
 * fails until all of them exist, so a template can never be half-added.
 */

export const NOTIFY_KINDS = [
  "verify-email",
  "magic-link",
  "password-changed",
  "device-approval",
  "login-new-device",
  "parental-waitlist",
  "renewal-notice",
  "low-credits",
  "export-ready",
  "share-comment",
  "streak-nudge",
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set<string>(NOTIFY_KINDS);

export function isNotifyKind(value: unknown): value is NotifyKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/**
 * Kinds that are never rate limited and are never withheld for a *soft* bounce.
 *
 * Everything on this list is either the only way back into an account or a
 * warning that somebody else is already in it. Dropping one of these to protect a
 * sending reputation would trade a security control for a deliverability metric,
 * so the limiter skips them and only a hard bounce or a complaint suppresses them.
 */
export const CRITICAL_KINDS: readonly NotifyKind[] = [
  "verify-email",
  "magic-link",
  "password-changed",
  "device-approval",
  "login-new-device",
];

const CRITICAL_SET: ReadonlySet<string> = new Set<string>(CRITICAL_KINDS);

export function isCriticalKind(kind: NotifyKind): boolean {
  return CRITICAL_SET.has(kind);
}

/**
 * Kinds that also become a row in `notifications` — the bell in the app shell.
 *
 * The test is "would a signed-in user want to find this again tomorrow?", which
 * is why nothing from the sign-in path is here: a magic link that is already
 * spent is noise, and a verification link that has not been clicked belongs in
 * the mailbox where it was sent, not in an app the user cannot reach yet.
 */
export const IN_APP_KINDS: readonly NotifyKind[] = [
  "login-new-device",
  "renewal-notice",
  "low-credits",
  "export-ready",
  "share-comment",
  "streak-nudge",
];

const IN_APP_SET: ReadonlySet<string> = new Set<string>(IN_APP_KINDS);

export function isInAppKind(kind: NotifyKind): boolean {
  return IN_APP_SET.has(kind);
}

/**
 * Kinds a recipient may switch off, which is exactly the set that carries an
 * unsubscribe link and a `List-Unsubscribe` header.
 *
 * Everything else is transactional — it is the answer to something the recipient
 * did, or a notice the law requires (the pre-debit `renewal-notice` of the RBI
 * e-mandate rules) — and an unsubscribe footer on a transactional message is
 * both a lie and a support ticket.
 */
export const NON_TRANSACTIONAL_KINDS: readonly NotifyKind[] = [
  "low-credits",
  "share-comment",
  "streak-nudge",
];

const NON_TRANSACTIONAL_SET: ReadonlySet<string> = new Set<string>(NON_TRANSACTIONAL_KINDS);

export function allowsUnsubscribe(kind: NotifyKind): boolean {
  return NON_TRANSACTIONAL_SET.has(kind);
}
