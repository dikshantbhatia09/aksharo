/**
 * Every sentence the run page says about guest links (2026-10-05), in one place
 * so the beginner-safety sweep (`beginnerSafetyViolations`: no tool names, no
 * "queue") covers all of it. The guest's own page keeps its words beside it
 * (`GUEST_COPY` in `app/(share)/share/guest/[token]/guest-page.tsx`).
 */
import { isApiError } from "@montaj/api-client";

export const GUEST_LINK_COPY = Object.freeze({
  button: "Share with a guest",
  title: "Share clips with a guest",
  description:
    "Send your guest a link to download the clips they appear in, ready to post: every size, the images and the words. No account needed.",
  nameLabel: "Guest's name (optional)",
  nameHint: "Greets them on their page.",
  namePlaceholder: "Priya",
  allClips: "Share every clip, including ones made later",
  pickClips: "Clips to share",
  noneChosen: "Choose at least one clip to share.",
  expiresLabel: "Link works for",
  days: (days: number): string => (days === 1 ? "1 day" : `${String(days)} days`),
  includeDubs: "Include the dubbed versions",
  includeDubsHint: "Your guest also gets each clip in the other languages it was dubbed into.",
  approvalNote:
    "Your workspace needs approval before posting, so your guest sees each clip once it is approved.",
  create: "Create link",
  creating: "Creating…",
  created: "Copy the link now and send it to your guest. For safety it is shown only once.",
  copy: "Copy link",
  copied: "Copied",
  shareNative: "Share",
  done: "Done",
  linksHeading: "Guest links",
  noLinks: "No guest links yet.",
  forGuest: (name: string): string => `For ${name}`,
  status: Object.freeze({ live: "Works", expired: "Expired", revoked: "Turned off" }),
  until: (date: string): string => `until ${date}`,
  clips: (all: boolean, count: number): string =>
    all ? `every clip (${String(count)})` : count === 1 ? "1 clip" : `${String(count)} clips`,
  visits: (count: number): string =>
    count === 0 ? "not opened yet" : count === 1 ? "opened once" : `opened ${String(count)} times`,
  downloads: (count: number): string => (count === 1 ? "1 download" : `${String(count)} downloads`),
  revoke: "Turn off",
  revokeTitle: "Turn off this guest link?",
  revokeDescription:
    "It stops opening at once, for everyone who has it. Files already downloaded stay with them.",
});

/** Sentences for the API's refusals that are not written for people. */
const REFUSAL: Readonly<Record<string, string>> = Object.freeze({
  "guest/link_not_found": "That guest link is no longer here.",
  "repurpose/not_available": "This is not available yet.",
  "repurpose/not_found": "We could not find that video project.",
  "common/rate_limited": "That is a lot at once. Wait a minute and try again.",
  "common/forbidden": "Your role does not allow this.",
});

/**
 * One sentence for a refused request: the API's own message for the refusals
 * it writes for people (too many links, a clip no longer on the run), a fixed
 * sentence for the rest.
 */
export function describeGuestLinkError(error: unknown): string {
  if (!isApiError(error) || error.code.startsWith("network/")) {
    return "We could not reach Aksharo. Check your connection and try again.";
  }
  const specific = new Set(["guest/too_many_links", "guest/clip_not_in_run"]);
  if (specific.has(error.code) && error.message.trim() !== "") return error.message;
  return REFUSAL[error.code] ?? "That did not work. Try again.";
}
