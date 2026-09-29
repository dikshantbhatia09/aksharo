import { describe, expect, it } from "vitest";

import {
  canonicalProviderOf,
  comparableText,
  postizHtml,
  postizSettings,
  youtubeTags,
} from "./postiz-format.js";

describe("canonicalProviderOf", () => {
  it("maps Postiz's provider names onto Aksharo's, and nothing else", () => {
    expect(canonicalProviderOf("instagram-standalone")).toBe("instagram");
    expect(canonicalProviderOf("linkedin-page")).toBe("linkedin");
    expect(canonicalProviderOf("tiktok-business")).toBe("tiktok");
    expect(canonicalProviderOf("x")).toBe("x");
    expect(canonicalProviderOf("pinterest")).toBeNull();
    expect(canonicalProviderOf("__proto__")).toBeNull();
  });
});

describe("postizHtml / comparableText", () => {
  it("writes one escaped paragraph per line, the way Postiz's composer does", () => {
    expect(postizHtml("Tom & Jerry <3\n\nWatch: https://youtu.be/x")).toBe(
      "<p>Tom &amp; Jerry &lt;3</p><p></p><p>Watch: https://youtu.be/x</p>",
    );
  });

  it("reads back to the same words after Postiz's sanitiser, for matching a lost post", () => {
    const text = "Tom & Jerry\nsecond line";
    expect(comparableText(postizHtml(text))).toBe("Tom & Jerry second line");
    expect(comparableText("<p>Tom &amp; Jerry</p>\n<p>second   line</p>")).toBe(
      "Tom & Jerry second line",
    );
  });
});

describe("postizSettings", () => {
  const post = { title: "A title", hashtags: ["#Money", "#Tips", "#Money"] };

  it("fills YouTube's DTO: title, visibility, not for kids, hashtags as tags", () => {
    expect(
      postizSettings(
        {
          provider: "youtube",
          surface: "short",
          privacy: "unlisted",
          madeForKids: false,
          categoryId: null,
        },
        post,
      ),
    ).toEqual({
      title: "A title",
      type: "unlisted",
      selfDeclaredMadeForKids: "no",
      tags: [
        { value: "Money", label: "Money" },
        { value: "Tips", label: "Tips" },
      ],
    });
  });

  it("posts a TikTok directly, private unless chosen otherwise, with a 90-character title", () => {
    const settings = postizSettings(
      {
        provider: "tiktok",
        surface: "video",
        privacy: "private",
        disclosesBrandedContent: false,
        allowComment: true,
        allowDuet: false,
        allowStitch: false,
      },
      { title: "x".repeat(120), hashtags: [] },
    );
    expect(settings).toMatchObject({
      privacy_level: "SELF_ONLY",
      content_posting_method: "DIRECT_POST",
      comment: true,
      duet: false,
      stitch: false,
    });
    expect(String(settings["title"])).toHaveLength(90);
  });

  it("fills what the other providers' DTOs require", () => {
    expect(
      postizSettings(
        { provider: "instagram", surface: "reel", shareToFeed: true, collaborators: [] },
        post,
      ),
    ).toEqual({ post_type: "post", collaborators: [] });
    expect(
      postizSettings({ provider: "x", surface: "post", replySettings: "mentioned" }, post),
    ).toEqual({
      who_can_reply_post: "mentionedUsers",
    });
    expect(
      postizSettings(
        { provider: "linkedin", surface: "member", organizationUrn: null, visibility: "public" },
        post,
      ),
    ).toEqual({ post_as_images_carousel: false });
    expect(postizSettings({ provider: "threads", surface: "post" }, post)).toEqual({});
    expect(postizSettings({ provider: "facebook", surface: "feed", pageId: null }, post)).toEqual({
      post_type: "post",
    });
  });

  it("keeps YouTube's tags within its 500-character budget", () => {
    const many = Array.from({ length: 60 }, (_, index) => `#tag${"x".repeat(10)}${String(index)}`);
    const tags = youtubeTags(many);
    expect(tags.reduce((total, tag) => total + tag.label.length, 0)).toBeLessThanOrEqual(500);
    expect(tags.length).toBeLessThan(60);
  });
});
