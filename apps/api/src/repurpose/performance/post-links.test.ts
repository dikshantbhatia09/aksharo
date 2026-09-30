import { describe, expect, it } from "vitest";

import { isRefusal, parsePostLink, postizPostKey } from "./post-links.js";

import type { ParsedPostLink, PostLinkRefusal } from "./post-links.js";

function parsed(raw: string): ParsedPostLink {
  const result = parsePostLink(raw);
  if (isRefusal(result)) throw new Error(`${raw} was refused: ${result.message}`);
  return result;
}

function refused(raw: string): PostLinkRefusal {
  const result = parsePostLink(raw);
  if (!isRefusal(result)) throw new Error(`${raw} was taken as ${result.key}`);
  return result;
}

describe("parsePostLink", () => {
  it("reads every YouTube link shape as the one video, and rebuilds the link", () => {
    for (const raw of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&si=abc",
      "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=tracking",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      expect(parsed(raw), raw).toEqual({
        platform: "youtube",
        key: "youtube:dQw4w9WgXcQ",
        id: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
    }
    expect(parsed("https://www.youtube.com/shorts/Zgu97mCGS74?feature=share")).toEqual({
      platform: "youtube",
      key: "youtube:Zgu97mCGS74",
      id: "Zgu97mCGS74",
      url: "https://www.youtube.com/shorts/Zgu97mCGS74",
    });
  });

  it("refuses a YouTube channel, a search or a malformed id as not a post", () => {
    for (const raw of [
      "https://www.youtube.com/@aksharo",
      "https://www.youtube.com/channel/UCAuUUnT6oDeKwE6v1NGQxug",
      "https://www.youtube.com/results?search_query=clips",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/shorts/../../etc",
    ]) {
      expect(refused(raw).refused, raw).toBe("performance/link_not_a_post");
    }
  });

  it("reads Instagram reels and posts, with or without the profile in the path", () => {
    expect(parsed("https://www.instagram.com/reel/C8xYz12AbCd/?igsh=MWx0")).toEqual({
      platform: "instagram",
      key: "instagram:C8xYz12AbCd",
      id: "C8xYz12AbCd",
      url: "https://www.instagram.com/reel/C8xYz12AbCd/",
    });
    expect(parsed("https://instagram.com/reels/C8xYz12AbCd").key).toBe("instagram:C8xYz12AbCd");
    expect(parsed("https://www.instagram.com/aksharo.app/reel/C8xYz12AbCd/").url).toBe(
      "https://www.instagram.com/reel/C8xYz12AbCd/",
    );
    expect(parsed("https://www.instagram.com/p/C8xYz12AbCd/")).toMatchObject({
      key: "instagram:C8xYz12AbCd",
      url: "https://www.instagram.com/p/C8xYz12AbCd/",
    });
    expect(refused("https://www.instagram.com/aksharo.app/").refused).toBe(
      "performance/link_not_a_post",
    );
  });

  it("reads a TikTok video link and refuses its short links", () => {
    expect(
      parsed("https://www.tiktok.com/@aksharo.app/video/7312345678901234567?is_from_webapp=1"),
    ).toEqual({
      platform: "tiktok",
      key: "tiktok:7312345678901234567",
      id: "7312345678901234567",
      url: "https://www.tiktok.com/@aksharo.app/video/7312345678901234567",
    });
    expect(refused("https://vm.tiktok.com/ZMabc123/").refused).toBe("performance/link_short");
    expect(refused("https://www.tiktok.com/t/ZTabc123/").refused).toBe("performance/link_short");
    expect(refused("https://www.tiktok.com/@aksharo.app").refused).toBe(
      "performance/link_not_a_post",
    );
  });

  it("reads LinkedIn posts by their activity, share or ugcPost id", () => {
    expect(
      parsed(
        "https://www.linkedin.com/posts/jane-doe_budget-tips-activity-7123456789012345678-AbCd/?utm_source=share",
      ),
    ).toEqual({
      platform: "linkedin",
      key: "linkedin:activity:7123456789012345678",
      id: "7123456789012345678",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
    });
    expect(
      parsed("https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/").key,
    ).toBe("linkedin:activity:7123456789012345678");
    expect(
      parsed("https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7123456789012345000").key,
    ).toBe("linkedin:ugcPost:7123456789012345000");
    expect(refused("https://www.linkedin.com/in/jane-doe/").refused).toBe(
      "performance/link_not_a_post",
    );
    expect(refused("https://lnkd.in/abc123").refused).toBe("performance/link_short");
  });

  it("reads X and Twitter status links as one id", () => {
    expect(parsed("https://x.com/aksharo/status/1840000000000000001?s=46")).toEqual({
      platform: "x",
      key: "x:1840000000000000001",
      id: "1840000000000000001",
      url: "https://x.com/aksharo/status/1840000000000000001",
    });
    expect(parsed("https://twitter.com/aksharo/status/1840000000000000001").key).toBe(
      "x:1840000000000000001",
    );
    expect(parsed("https://mobile.twitter.com/i/web/status/1840000000000000001").url).toBe(
      "https://x.com/i/status/1840000000000000001",
    );
    expect(refused("https://x.com/aksharo").refused).toBe("performance/link_not_a_post");
    expect(refused("https://t.co/abcdef").refused).toBe("performance/link_short");
  });

  it("reads Facebook videos, reels, posts and share links", () => {
    expect(parsed("https://www.facebook.com/reel/1234567890123456")).toEqual({
      platform: "facebook",
      key: "facebook:video:1234567890123456",
      id: "1234567890123456",
      url: "https://www.facebook.com/reel/1234567890123456",
    });
    // The same video from its watch link and its page's videos tab.
    expect(parsed("https://www.facebook.com/watch/?v=1234567890123456").key).toBe(
      "facebook:video:1234567890123456",
    );
    expect(parsed("https://m.facebook.com/AksharoApp/videos/1234567890123456/").key).toBe(
      "facebook:video:1234567890123456",
    );
    expect(parsed("https://www.facebook.com/AksharoApp/videos/my-clip/1234567890123456/").key).toBe(
      "facebook:video:1234567890123456",
    );
    expect(parsed("https://www.facebook.com/AksharoApp/posts/pfbid02abcDEF123ghiJKL456")).toEqual({
      platform: "facebook",
      key: "facebook:post:pfbid02abcDEF123ghiJKL456",
      id: "pfbid02abcDEF123ghiJKL456",
      url: "https://www.facebook.com/AksharoApp/posts/pfbid02abcDEF123ghiJKL456",
    });
    expect(parsed("https://www.facebook.com/share/v/1AbCdEfGh/").key).toBe(
      "facebook:share:1AbCdEfGh",
    );
    expect(
      parsed("https://www.facebook.com/permalink.php?story_fbid=1234567890&id=100064000000000").url,
    ).toBe("https://www.facebook.com/permalink.php?story_fbid=1234567890&id=100064000000000");
    expect(refused("https://fb.watch/abc123/").refused).toBe("performance/link_short");
    expect(refused("https://www.facebook.com/AksharoApp").refused).toBe(
      "performance/link_not_a_post",
    );
  });

  it("reads Threads posts on either of its domains", () => {
    expect(parsed("https://www.threads.net/@aksharo.app/post/C8xYz12AbCd?xmt=abc")).toEqual({
      platform: "threads",
      key: "threads:C8xYz12AbCd",
      id: "C8xYz12AbCd",
      url: "https://www.threads.com/@aksharo.app/post/C8xYz12AbCd",
    });
    expect(parsed("https://threads.com/@aksharo.app/post/C8xYz12AbCd").key).toBe(
      "threads:C8xYz12AbCd",
    );
  });

  it("refuses what is not a link, another site, credentials, ports and other schemes", () => {
    expect(refused("").refused).toBe("performance/link_invalid");
    expect(refused("not a link at all").refused).toBe("performance/link_invalid");
    expect(refused("javascript:alert(1)").refused).toBe("performance/link_invalid");
    expect(refused("ftp://www.youtube.com/watch?v=dQw4w9WgXcQ").refused).toBe(
      "performance/link_invalid",
    );
    expect(refused("https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ").refused).toBe(
      "performance/link_invalid",
    );
    expect(refused("https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ").refused).toBe(
      "performance/link_invalid",
    );
    expect(refused(`https://www.youtube.com/watch?v=${"a".repeat(3_000)}`).refused).toBe(
      "performance/link_invalid",
    );
    expect(refused("https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ").refused).toBe(
      "performance/link_unsupported",
    );
    expect(refused("https://vimeo.com/123456789").message).toContain("YouTube, Instagram");
  });

  it("takes plain http, and stores https", () => {
    expect(parsed("http://www.youtube.com/watch?v=dQw4w9WgXcQ").url).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });
});

describe("postizPostKey", () => {
  it("files a post Postiz gave the link of under the platform's own id", () => {
    expect(postizPostKey("youtube", "https://youtube.com/shorts/Zgu97mCGS74", "pz-1")).toEqual({
      key: "youtube:Zgu97mCGS74",
      url: "https://www.youtube.com/shorts/Zgu97mCGS74",
    });
  });

  it("falls back to Postiz's id with no link, or a link that is not that platform's post", () => {
    expect(postizPostKey("instagram", null, "pz-2")).toEqual({ key: "postiz:pz-2", url: null });
    expect(
      postizPostKey("instagram", "https://www.youtube.com/shorts/Zgu97mCGS74", "pz-3"),
    ).toEqual({ key: "postiz:pz-3", url: null });
    expect(postizPostKey("x", "https://example.test/post/1", "pz-4")).toEqual({
      key: "postiz:pz-4",
      url: null,
    });
  });
});
