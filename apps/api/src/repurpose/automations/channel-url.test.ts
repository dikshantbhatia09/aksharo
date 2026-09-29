import { describe, expect, it } from "vitest";

import { CHANNEL_URL_MESSAGES, channelLink, parseChannelUrl } from "./channel-url.js";

const ID = "UCAksharoTestChannel0001";

function ok(raw: string) {
  const result = parseChannelUrl(raw);
  if (!result.ok) throw new Error(`refused ${raw}: ${result.code}`);
  return result.channel;
}

function code(raw: string): string | undefined {
  const result = parseChannelUrl(raw);
  return result.ok ? undefined : result.code;
}

describe("parseChannelUrl: the four channel forms", () => {
  it("reads a handle, on every accepted host, ignoring tabs, queries and fragments", () => {
    for (const raw of [
      "https://www.youtube.com/@AksharoTestKitchen",
      "https://youtube.com/@AksharoTestKitchen",
      "https://m.youtube.com/@AksharoTestKitchen",
      "https://WWW.YOUTUBE.COM/@AksharoTestKitchen/videos",
      "https://www.youtube.com/@AksharoTestKitchen?si=abc123#top",
      "  https://www.youtube.com:443/@AksharoTestKitchen/featured  ",
    ]) {
      expect(ok(raw), raw).toEqual({
        ref: { kind: "handle", handle: "AksharoTestKitchen" },
        pagePath: "/@AksharoTestKitchen",
        key: "handle:aksharotestkitchen",
      });
    }
  });

  it("reads a handle in another script, and re-encodes it for the path", () => {
    const channel = ok("https://www.youtube.com/@%E0%A4%85%E0%A4%95%E0%A5%8D%E0%A4%B7%E0%A4%B0");
    expect(channel.ref).toEqual({ kind: "handle", handle: "अक्षर" });
    expect(channel.pagePath).toBe(`/@${encodeURIComponent("अक्षर")}`);
  });

  it("reads a channel id, which needs no page to resolve", () => {
    expect(ok(`https://www.youtube.com/channel/${ID}`)).toEqual({
      ref: { kind: "id", channelId: ID },
      pagePath: null,
      key: `id:${ID}`,
    });
    expect(ok(`https://m.youtube.com/channel/${ID}/videos?view=0`).ref).toEqual({
      kind: "id",
      channelId: ID,
    });
  });

  it("reads the legacy /c/ and /user/ names", () => {
    expect(ok("https://www.youtube.com/c/AksharoKitchen")).toEqual({
      ref: { kind: "custom", name: "AksharoKitchen" },
      pagePath: "/c/AksharoKitchen",
      key: "c:aksharokitchen",
    });
    expect(ok("https://www.youtube.com/user/aksharo2009/videos")).toEqual({
      ref: { kind: "user", name: "aksharo2009" },
      pagePath: "/user/aksharo2009",
      key: "user:aksharo2009",
    });
  });

  it("links to a channel by its id", () => {
    expect(channelLink(ID)).toBe(`https://www.youtube.com/channel/${ID}`);
  });
});

describe("parseChannelUrl: refusals", () => {
  it("refuses what is not a link", () => {
    for (const raw of [
      "",
      "   ",
      "@AksharoTestKitchen",
      "youtube.com/@x",
      "not a url",
      "x".repeat(2_100),
    ]) {
      expect(code(raw), raw).toBe("not_a_url");
    }
  });

  it("refuses every scheme but https", () => {
    for (const raw of [
      "http://www.youtube.com/@AksharoTestKitchen",
      "javascript:alert(document.cookie)//https://www.youtube.com/@x",
      "JaVaScRiPt:fetch('//evil.test')",
      "data:text/html,<script>1</script>",
      "file:///C:/Windows/win.ini",
      "ftp://www.youtube.com/@x",
    ]) {
      expect(code(raw), raw).toBe("not_https");
    }
  });

  it("refuses credentials, however they are dressed up", () => {
    expect(code("https://user:pass@www.youtube.com/@x")).toBe("credentials_in_url");
    // The classic: the "host" a reader sees first is only the user name.
    expect(code("https://www.youtube.com@evil.test/@AksharoTestKitchen")).toBe(
      "credentials_in_url",
    );
    expect(code("https://www.youtube.com%40evil.test@evil.test/@x")).toBe("credentials_in_url");
  });

  it("refuses other hosts, look-alikes and near misses", () => {
    for (const raw of [
      "https://evil.test/@AksharoTestKitchen",
      "https://youtube.com.evil.test/@AksharoTestKitchen",
      "https://evil.test/https://www.youtube.com/@x",
      "https://www.youtube.com./@AksharoTestKitchen",
      "https://music.youtube.com/@AksharoTestKitchen",
      "https://studio.youtube.com/channel/" + ID,
      "https://youtu.be/@AksharoTestKitchen",
      "https://www.youtube-nocookie.com/@AksharoTestKitchen",
      // Cyrillic о and а: the URL parser turns these into punycode.
      "https://www.yоutube.com/@AksharoTestKitchen",
      "https://www.youtubе.com/@AksharoTestKitchen",
      // Full-width letters and a backslash that a WHATWG parser reads as a slash.
      "https://ｗｗｗ.youtube.com.evil.test/@x",
      "https://evil.test\\@www.youtube.com/@x",
      "https://www.youtube.com:8443/@AksharoTestKitchen",
      "https://127.0.0.1/@AksharoTestKitchen",
      "https://[::1]/@AksharoTestKitchen",
    ]) {
      expect(code(raw), raw).not.toBeUndefined();
      expect(["not_youtube", "credentials_in_url"], raw).toContain(code(raw));
    }
  });

  it("says a video link is one video, not a channel", () => {
    for (const raw of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/playlist?list=PL123",
    ]) {
      expect(code(raw), raw).toBe("video_not_channel");
    }
  });

  it("refuses paths that are not a channel, and names that are not names", () => {
    for (const raw of [
      "https://www.youtube.com/",
      "https://www.youtube.com/AksharoTestKitchen",
      "https://www.youtube.com/results?search_query=aksharo",
      "https://www.youtube.com/feed/subscriptions",
      "https://www.youtube.com/channel/",
      "https://www.youtube.com/channel/UCshort",
      "https://www.youtube.com/channel/XX" + ID.slice(2),
      "https://www.youtube.com/channel/" + ID + "x",
      "https://www.youtube.com/@ab",
      "https://www.youtube.com/@" + "a".repeat(31),
      "https://www.youtube.com/@with%20space",
      "https://www.youtube.com/@a%2F..%2Fadmin",
      "https://www.youtube.com/@%E0%A4",
      "https://www.youtube.com/@...",
      "https://www.youtube.com/c/..",
      "https://www.youtube.com/c/%2e%2e",
      "https://www.youtube.com/c/",
      "https://www.youtube.com/user/n%C3%A4me",
      "https://www.youtube.com/user/a%3Cscript%3E",
    ]) {
      expect(code(raw), raw).toBe("not_a_channel");
    }
  });

  it("has a sentence for every refusal", () => {
    for (const reason of [
      "not_a_url",
      "not_https",
      "credentials_in_url",
      "not_youtube",
      "video_not_channel",
      "not_a_channel",
    ] as const) {
      // eslint-disable-next-line security/detect-object-injection -- a literal key from the list above
      expect(CHANNEL_URL_MESSAGES[reason].length, reason).toBeGreaterThan(20);
    }
  });
});
