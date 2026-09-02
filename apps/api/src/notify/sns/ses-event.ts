/**
 * The SES side of the webhook: what an SNS `Message` string means.
 *
 * SES publishes the same facts under two spellings — `notificationType` when the
 * topic is wired as a legacy *notification* destination and `eventType` when it
 * is wired as a configuration-set *event* destination — and an installation will
 * have one or the other depending on when its Terraform was written. Reading
 * both is three lines; guessing wrong is a suppression list that never fills.
 *
 * Only three of the event types matter here. A `Delivery` is recorded because it
 * is what lifts a transient suppression; `Send`, `Open` and `Click` are ignored,
 * and `Open`/`Click` are not enabled at all — there are no tracking pixels.
 */

export type SesEventKind = "bounce" | "complaint" | "delivery" | "other";

/** How long an address stays suppressed, decided by why it bounced. */
export type SuppressionPermanence = "permanent" | "transient";

export interface SesEvent {
  readonly kind: SesEventKind;
  /** Lower-cased addresses the event names. Empty for `other`. */
  readonly recipients: readonly string[];
  /** Present for bounces and complaints. A complaint is always permanent. */
  readonly permanence?: SuppressionPermanence;
  /** `Permanent`/`General`, `abuse`, ... — recorded on the audit row. */
  readonly reason?: string;
}

interface RecipientLike {
  readonly emailAddress?: unknown;
}

function addressesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const addresses: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry === "string") {
      addresses.push(entry.trim().toLowerCase());
      continue;
    }
    const candidate = (entry as RecipientLike).emailAddress;
    if (typeof candidate === "string") addresses.push(candidate.trim().toLowerCase());
  }
  return addresses.filter((address) => address !== "");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Parse the JSON string SNS carried. Never throws: an unparseable or unknown
 * message is `other`, because a webhook that 500s on a shape AWS added last week
 * makes SNS retry it forever.
 */
export function parseSesEvent(rawMessage: string): SesEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    return { kind: "other", recipients: [] };
  }

  const body = asRecord(parsed);
  const type = String(body["eventType"] ?? body["notificationType"] ?? "").toLowerCase();

  if (type === "bounce") {
    const bounce = asRecord(body["bounce"]);
    const bounceType = String(bounce["bounceType"] ?? "");
    const subType = String(bounce["bounceSubType"] ?? "");
    return {
      kind: "bounce",
      recipients: addressesOf(bounce["bouncedRecipients"]),
      // Only `Permanent` is permanent. `Transient` (full mailbox, greylisting)
      // and `Undetermined` get a fortnight, because suppressing a mailbox for
      // ever because its owner was on holiday is its own kind of outage.
      permanence: bounceType === "Permanent" ? "permanent" : "transient",
      reason: subType === "" ? bounceType : `${bounceType}/${subType}`,
    };
  }

  if (type === "complaint") {
    const complaint = asRecord(body["complaint"]);
    return {
      kind: "complaint",
      recipients: addressesOf(complaint["complainedRecipients"]),
      // A complaint is a person pressing "this is spam". There is no version of
      // this that expires.
      permanence: "permanent",
      reason: String(complaint["complaintFeedbackType"] ?? "complaint"),
    };
  }

  if (type === "delivery") {
    const delivery = asRecord(body["delivery"]);
    return { kind: "delivery", recipients: addressesOf(delivery["recipients"]) };
  }

  return { kind: "other", recipients: [] };
}
