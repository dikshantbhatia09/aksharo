import { describe, expect, it } from "vitest";
import { RssParserService } from "./rss-parser.service.js";

describe("RssParserService", () => {
  const service = new RssParserService();

  const buzzsproutXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Tech Founder Show</title>
    <link>https://www.buzzsprout.com/123456</link>
    <description>Weekly conversations with tech founders.</description>
    <itunes:author>Jane Doe</itunes:author>
    <itunes:image href="https://assets.buzzsprout.com/artwork.jpg" />
    <lastBuildDate>Tue, 06 Oct 2026 12:00:00 GMT</lastBuildDate>
    <item>
      <title>Episode 42: Scaling to $10M ARR with Deep Learning</title>
      <guid isPermaLink="false">Buzzsprout-12345678</guid>
      <pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate>
      <enclosure url="https://www.buzzsprout.com/123456/episodes/12345678.mp3" length="45123984" type="audio/mpeg" />
      <itunes:duration>00:45:12</itunes:duration>
      <itunes:summary>In this episode we discuss scaling infrastructure...</itunes:summary>
      <description><![CDATA[Timestamps:
00:00 - Introduction & Hook
04:30 - First $1M ARR Playbook
18:45 - Building with AI Models
35:10 - Fundraising & Lessons
42:00 - Outro & Resources]]></description>
    </item>
  </channel>
</rss>`;

  const libsynXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>SaaS Velocity</title>
    <itunes:author>John Smith</itunes:author>
    <image>
      <url>https://ssl-static.libsyn.com/p/assets/cover.jpg</url>
    </image>
    <item>
      <title>Ep 101: The Future of Short-Form Video</title>
      <guid>https://traffic.libsyn.com/secure/saasvelocity/ep101.mp3</guid>
      <pubDate>Sun, 04 Oct 2026 14:00:00 GMT</pubDate>
      <enclosure url="https://traffic.libsyn.com/secure/saasvelocity/ep101.mp3" length="38210400" type="audio/mpeg"/>
      <itunes:duration>2540</itunes:duration>
      <itunes:summary>Why vertical video dominates marketing.</itunes:summary>
      <description>Show notes: [02:15] Viral Hooks [10:30] Retention Curves</description>
    </item>
  </channel>
</rss>`;

  const podloveXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:psc="http://podlove.org/simple-chapters">
  <channel>
    <title>Engineering Pod</title>
    <item>
      <title>Ep 50: Distributed Systems</title>
      <guid>ep-50</guid>
      <pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate>
      <enclosure url="https://media.example.com/ep50.mp3" type="audio/mpeg" />
      <itunes:duration>3600</itunes:duration>
      <psc:chapters>
        <psc:chapter start="00:00:00" title="Intro" />
        <psc:chapter start="00:15:30" title="Consensus Protocols" />
        <psc:chapter start="00:45:00" title="Raft vs Paxos" />
      </psc:chapters>
    </item>
  </channel>
</rss>`;

  it("parses Buzzsprout feed metadata and episodes correctly", () => {
    const feed = service.parseFeed(buzzsproutXml);
    expect(feed.title).toBe("The Tech Founder Show");
    expect(feed.author).toBe("Jane Doe");
    expect(feed.imageUrl).toBe("https://assets.buzzsprout.com/artwork.jpg");
    expect(feed.episodes).toHaveLength(1);

    const ep = feed.episodes[0];
    expect(ep).toBeDefined();
    if (!ep) return;
    expect(ep.title).toBe("Episode 42: Scaling to $10M ARR with Deep Learning");
    expect(ep.guid).toBe("Buzzsprout-12345678");
    expect(ep.audioUrl).toBe("https://www.buzzsprout.com/123456/episodes/12345678.mp3");
    expect(ep.durationSec).toBe(45 * 60 + 12);
    expect(ep.chapters).toHaveLength(5);
    expect(ep.chapters[0]).toEqual({
      title: "Introduction & Hook",
      startSec: 0,
      endSec: 4 * 60 + 30,
    });
    expect(ep.chapters[1]).toEqual({
      title: "First $1M ARR Playbook",
      startSec: 4 * 60 + 30,
      endSec: 18 * 60 + 45,
    });
  });

  it("parses Libsyn feed with numeric itunes:duration and bracketed chapters", () => {
    const feed = service.parseFeed(libsynXml);
    expect(feed.title).toBe("SaaS Velocity");
    expect(feed.author).toBe("John Smith");
    expect(feed.imageUrl).toBe("https://ssl-static.libsyn.com/p/assets/cover.jpg");
    expect(feed.episodes).toHaveLength(1);

    const ep = feed.episodes[0];
    expect(ep).toBeDefined();
    if (!ep) return;
    expect(ep.guid).toBe("https://traffic.libsyn.com/secure/saasvelocity/ep101.mp3");
    expect(ep.durationSec).toBe(2540);
    expect(ep.chapters).toHaveLength(2);
    expect(ep.chapters[0]?.startSec).toBe(2 * 60 + 15);
    expect(ep.chapters[0]?.title).toBe("Viral Hooks");
  });

  it("parses Podlove Simple Chapters (<psc:chapters>)", () => {
    const feed = service.parseFeed(podloveXml);
    expect(feed.episodes).toHaveLength(1);
    const ep = feed.episodes[0];
    expect(ep).toBeDefined();
    if (!ep) return;
    expect(ep.chapters).toHaveLength(3);
    expect(ep.chapters[0]?.title).toBe("Intro");
    expect(ep.chapters[1]?.title).toBe("Consensus Protocols");
    expect(ep.chapters[1]?.startSec).toBe(15 * 60 + 30);
    expect(ep.chapters[1]?.endSec).toBe(45 * 60);
  });

  it("meets latency SLA <= 800ms", () => {
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      service.parseFeed(buzzsproutXml);
    }
    const totalMs = performance.now() - start;
    const avgMs = totalMs / 50;
    expect(avgMs).toBeLessThan(100); // Easily beats 800ms SLA
  });

  it("handles malformed XML gracefully", () => {
    expect(() => service.parseFeed("Not XML")).toThrow(/Invalid RSS feed/);
  });
});

