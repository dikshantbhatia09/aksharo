import { describe, expect, it } from "vitest";

import { parseChannelFeed } from "./channel-feed.js";
import { channelFromPage } from "./channel-page.js";
import { XmlParseError, decodeEntities, parseXml } from "./safe-xml.js";
import {
  BILLION_LAUGHS,
  CHANNEL,
  EXTERNAL_DTD,
  EXTERNAL_ENTITY,
  MIXED_FEED,
  OTHER_CHANNEL,
  channelPage,
  feedXml,
} from "./youtube-fixtures.test-support.js";

function xmlError(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof XmlParseError) return error.code;
    throw error;
  }
}

describe("parseXml: nothing is ever expanded", () => {
  it("refuses the billion laughs outright, before reading a single element", () => {
    const started = Date.now();
    expect(xmlError(() => parseXml(BILLION_LAUGHS))).toBe("dtd_refused");
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("refuses an external entity and an external DTD, whatever their case", () => {
    expect(xmlError(() => parseXml(EXTERNAL_ENTITY))).toBe("dtd_refused");
    expect(xmlError(() => parseXml(EXTERNAL_DTD))).toBe("dtd_refused");
    // An entity declaration with no DOCTYPE around it is not let through either.
    expect(xmlError(() => parseXml('<a><!ENTITY x "y"></a>'))).toBe("dtd_refused");
  });

  it("leaves an undeclared entity as written, and decodes only the five and numbers", () => {
    const root = parseXml(
      '<t a="&quot;q&quot; &amp; &#x41;&#66;">&secret; &lt;b&gt; &nbsp; &#0; &#xD800;</t>',
    );
    expect(root.attrs["a"]).toBe('"q" & AB');
    expect(root.text).toBe("&secret; <b> &nbsp; &#0; &#xD800;");
    expect(decodeEntities("&#x10FFFF;&#x110000;&apos;")).toBe("\u{10FFFF}&#x110000;'");
  });

  it("bounds size, depth, elements and attributes", () => {
    expect(xmlError(() => parseXml("<a/>", { maxChars: 3 }))).toBe("too_large");
    expect(xmlError(() => parseXml("<a>".repeat(40) + "</a>".repeat(40)))).toBe("too_deep");
    expect(xmlError(() => parseXml(`<a>${"<b/>".repeat(50)}</a>`, { maxElements: 20 }))).toBe(
      "too_many_nodes",
    );
    const many = Array.from({ length: 40 }, (_, i) => `a${String(i)}="1"`).join(" ");
    expect(xmlError(() => parseXml(`<a ${many}/>`))).toBe("malformed");
  });

  it("refuses what is not well-formed rather than guessing", () => {
    for (const bad of [
      "",
      "just text",
      "<a>",
      "<a></b>",
      "<a/><b/>",
      "<a x=1/>",
      '<a x="1"y="2"/>',
      '<a x="1" x="2"/>',
      '<a x="<"/>',
      "<a><![CDATA[never closes</a>",
      "<a><!-- never closes</a>",
      "<1a/>",
      "text<a/>",
    ]) {
      expect(
        xmlError(() => parseXml(bad)),
        bad,
      ).toBe("malformed");
    }
  });

  it("keeps CDATA as text, skips comments and instructions, and resolves namespaces", () => {
    const root = parseXml(
      '﻿<?xml version="1.0"?><!-- c --><r xmlns="urn:a" xmlns:p="urn:p"><p:x q="1"><![CDATA[<raw & text>]]></p:x><y xmlns="">z</y></r>',
    );
    expect(root.ns).toBe("urn:a");
    const [x, y] = root.children;
    expect(x).toMatchObject({ local: "x", ns: "urn:p", text: "<raw & text>" });
    expect(y).toMatchObject({ local: "y", ns: null, text: "z" });
  });

  it("reads a large flat document in one pass", () => {
    const big = `<a>${"<b>x</b>".repeat(15_000)}</a>`;
    const started = Date.now();
    expect(parseXml(big).children).toHaveLength(15_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("parseChannelFeed", () => {
  it("reads every entry, newest first, with its title decoded", () => {
    const feed = parseChannelFeed(MIXED_FEED);
    expect(feed.channelId).toBe(CHANNEL);
    expect(feed.title).toBe("Aksharo Test Kitchen");
    expect(feed.entries.map((entry) => entry.videoId)).toEqual([
      "vid00000005",
      "vid00000004",
      "vid00000003",
      "vid00000002",
      "vid00000001",
    ]);
    const episode = feed.entries.find((entry) => entry.videoId === "vid00000003");
    expect(episode).toMatchObject({
      title: "Episode 41 & the market — full talk",
      publishedAt: new Date("2026-10-01T08:00:00Z"),
      link: "https://www.youtube.com/watch?v=vid00000003",
      isShort: false,
      views: 1520,
    });
  });

  it("marks Shorts by their link and by their tag, and a premiere by its missing views", () => {
    const byId = new Map(
      parseChannelFeed(MIXED_FEED).entries.map((entry) => [entry.videoId, entry]),
    );
    expect(byId.get("vid00000005")?.isShort).toBe(true); // linked to /shorts/
    expect(byId.get("vid00000002")?.isShort).toBe(true); // "#Shorts" in the title
    expect(byId.get("vid00000004")).toMatchObject({ isShort: false, views: 0 });
    expect(byId.get("vid00000001")?.isShort).toBe(false);
  });

  it("reads the channel id with or without its UC", () => {
    const bare = feedXml([], { bareChannelId: true });
    expect(parseChannelFeed(bare).channelId).toBe(CHANNEL);
  });

  it("skips entries it cannot vouch for rather than failing the feed", () => {
    const feed = parseChannelFeed(
      feedXml([
        { videoId: "tooShort", title: "x", published: "2026-10-01T00:00:00Z" },
        { videoId: "vid00000009", title: "no date", published: "yesterday" },
        { videoId: "vid00000008", title: "fine", published: "2026-10-01T00:00:00Z", views: 3 },
        { videoId: "vid00000008", title: "a repeat", published: "2026-10-01T00:00:00Z" },
      ]),
    );
    expect(feed.entries.map((entry) => entry.videoId)).toEqual(["vid00000008"]);
    expect(feed.entries[0]?.title).toBe("fine");
  });

  it("refuses a malicious feed and anything that is not an Atom feed", () => {
    expect(() => parseChannelFeed(BILLION_LAUGHS)).toThrow(XmlParseError);
    expect(() => parseChannelFeed(EXTERNAL_ENTITY)).toThrow(XmlParseError);
    expect(() => parseChannelFeed("<html><body>Sorry</body></html>")).toThrow(/not an Atom feed/);
    expect(() => parseChannelFeed('<rss version="2.0"><channel/></rss>')).toThrow(XmlParseError);
  });
});

describe("channelFromPage", () => {
  it("reads the channel id and its name from the page's head", () => {
    expect(channelFromPage(channelPage())).toEqual({
      channelId: CHANNEL,
      title: "Aksharo Test Kitchen & Friends",
    });
  });

  it("never takes a featured channel from the page's data for the page's own", () => {
    // The data names two other channels before anything else could.
    const page = channelFromPage(channelPage({ omitHeadIds: true }));
    expect(page?.channelId).toBe(CHANNEL);
  });

  it("refuses a head that names two different channels", () => {
    expect(
      channelFromPage(channelPage({ ogUrl: `https://www.youtube.com/channel/${OTHER_CHANNEL}` })),
    ).toBeNull();
  });

  it("ignores ids on other hosts, and says nothing about a page with no channel", () => {
    expect(
      channelFromPage(
        channelPage({
          canonical: `https://evil.test/channel/${OTHER_CHANNEL}`,
          rss: `https://evil.test/feeds/videos.xml?channel_id=${OTHER_CHANNEL}`,
          ogUrl: `https://www.youtube.com/channel/${CHANNEL}`,
        }),
      )?.channelId,
    ).toBe(CHANNEL);
    expect(
      channelFromPage("<html><head><title>Oops</title></head><body></body></html>"),
    ).toBeNull();
    expect(channelFromPage("")).toBeNull();
  });

  it("falls back to the <title> without its '- YouTube'", () => {
    const html = channelPage().replace(/<meta property="og:title"[^>]*>/, "");
    expect(channelFromPage(html)?.title).toBe("Aksharo Test Kitchen");
  });
});
