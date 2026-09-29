import type { PublishProvider } from "../publishing.contract.js";

/**
 * Aksharo's post, in the shape Postiz takes it: the adapter half of "these
 * are OUR names" (`@montaj/publishing-contracts`). Canonical providers and
 * settings are mapped here and nowhere else, so a rename inside Postiz is one
 * change in this file rather than a migration of stored rows.
 */

/**
 * Postiz's provider names, mapped to ours. Only the ones Aksharo posts to are
 * listed; any other channel connected in Postiz is shown as "not supported yet".
 */
export const POSTIZ_PROVIDER: Readonly<Record<string, PublishProvider>> = Object.freeze({
  instagram: "instagram",
  "instagram-standalone": "instagram",
  facebook: "facebook",
  threads: "threads",
  youtube: "youtube",
  linkedin: "linkedin",
  "linkedin-page": "linkedin",
  tiktok: "tiktok",
  "tiktok-business": "tiktok",
  x: "x",
});

export function canonicalProviderOf(identifier: string): PublishProvider | null {
  return Object.hasOwn(POSTIZ_PROVIDER, identifier)
    ? // eslint-disable-next-line security/detect-object-injection -- guarded by hasOwn on a frozen table
      (POSTIZ_PROVIDER[identifier] ?? null)
    : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Plain text as Postiz's composer writes it: one `<p>` per line, escaped.
 *
 * Postiz treats a post's content as HTML. Sent as plain text, a line with an
 * `&` in it is posted as `&amp;` (its sanitiser escapes, and plain text never
 * reaches the path that un-escapes); in paragraphs it comes out as written,
 * and an empty line stays an empty line.
 */
export function postizHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

/**
 * Content as a person reads it, whitespace collapsed: how a post found in
 * Postiz is compared with the one this module sent, after Postiz's sanitiser
 * has had its way with the markup.
 */
export function comparableText(html: string): string {
  return html
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Aksharo's canonical settings for one post (`ProviderSettingsSchema` in the contract). */
export type CanonicalSettings =
  | {
      readonly provider: "instagram";
      readonly surface: "reel" | "feed" | "story";
      readonly shareToFeed: boolean;
      readonly collaborators: readonly string[];
    }
  | {
      readonly provider: "facebook";
      readonly surface: "reel" | "feed" | "story";
      readonly pageId: string | null;
    }
  | { readonly provider: "threads"; readonly surface: "post" }
  | {
      readonly provider: "youtube";
      readonly surface: "short" | "video";
      readonly privacy: "private" | "unlisted" | "public";
      readonly madeForKids: boolean;
      readonly categoryId: string | null;
    }
  | {
      readonly provider: "linkedin";
      readonly surface: "member" | "organization";
      readonly organizationUrn: string | null;
      readonly visibility: "public" | "connections";
    }
  | {
      readonly provider: "tiktok";
      readonly surface: "video";
      readonly privacy: "private" | "friends" | "public";
      readonly disclosesBrandedContent: boolean;
      readonly allowComment: boolean;
      readonly allowDuet: boolean;
      readonly allowStitch: boolean;
    }
  | {
      readonly provider: "x";
      readonly surface: "post";
      readonly replySettings: "everyone" | "following" | "mentioned";
    };

const TIKTOK_PRIVACY = {
  public: "PUBLIC_TO_EVERYONE",
  friends: "MUTUAL_FOLLOW_FRIENDS",
  private: "SELF_ONLY",
} as const;

const X_REPLY = {
  everyone: "everyone",
  following: "following",
  mentioned: "mentionedUsers",
} as const;

/** YouTube caps the tags of one video at 500 characters in all. */
const YOUTUBE_TAGS_MAX_CHARS = 500;

/** Hashtags as YouTube tags (`#MoneyTips` → `MoneyTips`), within YouTube's budget. */
export function youtubeTags(hashtags: readonly string[]): { value: string; label: string }[] {
  const tags: { value: string; label: string }[] = [];
  let used = 0;
  for (const hashtag of hashtags) {
    const label = hashtag.replace(/^#/, "");
    if (label === "" || tags.some((tag) => tag.label === label)) continue;
    // A tag with a space would be quoted by YouTube, two more characters; ours have none.
    if (used + label.length > YOUTUBE_TAGS_MAX_CHARS) break;
    used += label.length;
    tags.push({ value: label, label });
  }
  return tags;
}

/**
 * The `settings` object Postiz's provider DTO for this channel validates
 * (`libraries/nestjs-libraries/src/dtos/posts/providers-settings/*`).
 * `__type` is added by the client from the channel itself.
 */
export function postizSettings(
  settings: CanonicalSettings,
  post: { readonly title: string | null; readonly hashtags: readonly string[] },
): Record<string, unknown> {
  switch (settings.provider) {
    case "youtube":
      return {
        title: post.title ?? "",
        type: settings.privacy,
        selfDeclaredMadeForKids: settings.madeForKids ? "yes" : "no",
        tags: youtubeTags(post.hashtags),
      };
    case "instagram":
      // A video `post` goes out as a Reel (Postiz sends `media_type=REELS`).
      return {
        post_type: settings.surface === "story" ? "story" : "post",
        collaborators: settings.collaborators.map((label) => ({ label })),
      };
    case "facebook":
      return { post_type: settings.surface === "story" ? "story" : "post" };
    case "linkedin":
      return { post_as_images_carousel: false };
    case "x":
      return { who_can_reply_post: X_REPLY[settings.replySettings] };
    case "tiktok":
      return {
        ...(post.title === null || post.title === "" ? {} : { title: post.title.slice(0, 90) }),
        privacy_level: TIKTOK_PRIVACY[settings.privacy],
        duet: settings.allowDuet,
        stitch: settings.allowStitch,
        comment: settings.allowComment,
        autoAddMusic: "no",
        brand_content_toggle: settings.disclosesBrandedContent,
        brand_organic_toggle: false,
        video_made_with_ai: false,
        // DIRECT_POST publishes; UPLOAD only drops a draft in the TikTok app.
        content_posting_method: "DIRECT_POST",
      };
    case "threads":
      return {};
  }
}
