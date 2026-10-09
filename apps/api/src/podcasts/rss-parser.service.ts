import { Injectable, Logger } from "@nestjs/common";
import { XMLParser } from "fast-xml-parser";

export interface ParsedPodcastChapter {
  readonly title: string;
  readonly startSec: number;
  readonly endSec?: number;
}

export interface ParsedPodcastEpisode {
  readonly guid: string;
  readonly title: string;
  readonly audioUrl: string;
  readonly durationSec?: number;
  readonly publishedAt: Date;
  readonly description?: string;
  readonly summary?: string;
  readonly chapters: readonly ParsedPodcastChapter[];
}

export interface ParsedPodcastFeed {
  readonly title: string;
  readonly author?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly lastBuildDate?: Date;
  readonly link?: string;
  readonly episodes: readonly ParsedPodcastEpisode[];
}

/**
 * RSS 2.0 XML Parser for podcast feeds (Pillar 1 §06).
 * Handles iTunes extensions (<itunes:*>), Podlove Simple Chapters (<psc:*>),
 * and embedded show-note chapter timestamps.
 */
@Injectable()
export class RssParserService {
  private readonly logger = new Logger(RssParserService.name);
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    cdataPropName: "__cdata",
    trimValues: true,
    parseTagValue: false,
    isArray: (name) => name === "item" || name === "chapter" || name === "psc:chapter",
  });

  /**
   * Parse raw RSS XML into strongly-typed feed structure.
   */
  parseFeed(xmlContent: string): ParsedPodcastFeed {
    const startTime = performance.now();
    if (!xmlContent || typeof xmlContent !== "string") {
      throw new Error("RSS feed content is empty or invalid");
    }

    // Safety guard against massive XML payloads (15MB limit)
    if (xmlContent.length > 15 * 1024 * 1024) {
      throw new Error("RSS feed XML exceeds maximum allowed size (15MB)");
    }

    let parsed: any;
    try {
      parsed = this.parser.parse(xmlContent);
    } catch (err: any) {
      this.logger.error(`Failed to parse RSS XML: ${err?.message}`);
      throw new Error(`Malformed RSS XML: ${err?.message}`);
    }

    const channel = parsed?.rss?.channel || parsed?.channel;
    if (!channel) {
      throw new Error("Invalid RSS feed structure: <channel> element not found");
    }

    const title = this.extractString(channel.title) || "Untitled Podcast";
    const author =
      this.extractString(channel["itunes:author"]) ||
      this.extractString(channel["itunes:owner"]?.["itunes:name"]) ||
      this.extractString(channel.author) ||
      undefined;

    const description =
      this.extractString(channel.description) ||
      this.extractString(channel["itunes:summary"]) ||
      undefined;

    let imageUrl: string | undefined = undefined;
    if (channel["itunes:image"]?.["@_href"]) {
      imageUrl = channel["itunes:image"]["@_href"];
    } else if (channel.image?.url) {
      imageUrl = this.extractString(channel.image.url);
    }

    const lastBuildDateRaw = channel.lastBuildDate || channel.pubDate;
    const lastBuildDate = this.parseDate(lastBuildDateRaw);

    const link = this.extractString(channel.link) || undefined;

    const rawItems: any[] = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    const episodes: ParsedPodcastEpisode[] = [];

    for (const item of rawItems) {
      const episode = this.parseItem(item);
      if (episode) {
        episodes.push(episode);
      }
    }

    const durationMs = performance.now() - startTime;
    this.logger.debug(
      `Parsed RSS feed "${title}" (${episodes.length} episodes) in ${durationMs.toFixed(1)}ms`,
    );

    return {
      title,
      author,
      description,
      imageUrl,
      lastBuildDate,
      link,
      episodes,
    };
  }

  private parseItem(item: any): ParsedPodcastEpisode | null {
    if (!item) return null;

    // 1. Audio / Video enclosure URL
    const enclosure = item.enclosure;
    let audioUrl = "";
    if (enclosure && enclosure["@_url"]) {
      audioUrl = enclosure["@_url"];
    } else if (Array.isArray(enclosure)) {
      const mediaEnclosure = enclosure.find((e: any) =>
        e["@_type"]?.includes("audio") || e["@_type"]?.includes("video") || e["@_url"]?.endsWith(".mp3"),
      );
      audioUrl = mediaEnclosure ? mediaEnclosure["@_url"] : enclosure[0]["@_url"];
    }

    if (!audioUrl) {
      // Check for <link> or media:content if enclosure is omitted
      if (item["media:content"]?.["@_url"]) {
        audioUrl = item["media:content"]["@_url"];
      } else if (typeof item.link === "string" && (item.link.endsWith(".mp3") || item.link.endsWith(".m4a"))) {
        audioUrl = item.link;
      }
    }

    if (!audioUrl) {
      // Items without media enclosure cannot be repurposed
      return null;
    }

    // 2. GUID
    let guid = "";
    if (item.guid) {
      if (typeof item.guid === "string") {
        guid = item.guid;
      } else if (item.guid["#text"]) {
        guid = item.guid["#text"];
      }
    }
    if (!guid) {
      guid = audioUrl;
    }

    // 3. Title
    const title =
      this.extractString(item.title) ||
      this.extractString(item["itunes:title"]) ||
      "Untitled Episode";

    // 4. Publication Date
    const publishedAt = this.parseDate(item.pubDate) || new Date();

    // 5. Duration
    const durationRaw = item["itunes:duration"] || item.duration;
    const durationSec = this.parseDuration(durationRaw);

    // 6. Description & Summary
    const description =
      this.extractString(item.description) ||
      this.extractString(item["content:encoded"]) ||
      undefined;

    const summary =
      this.extractString(item["itunes:summary"]) ||
      this.extractString(item["itunes:subtitle"]) ||
      undefined;

    // 7. Chapters extraction (Podlove Simple Chapters + show notes timestamps)
    const chapters = this.extractChapters(item, description, summary);

    return {
      guid: guid.trim(),
      title: title.trim(),
      audioUrl: audioUrl.trim(),
      durationSec,
      publishedAt,
      description,
      summary,
      chapters,
    };
  }

  /**
   * Parse durations in formats: "1820", "30:20" (MM:SS), "01:30:20" (HH:MM:SS), or seconds.
   */
  parseDuration(duration: any): number | undefined {
    if (duration === undefined || duration === null) return undefined;
    if (typeof duration === "number" && !isNaN(duration)) return duration > 0 ? duration : undefined;

    const str = String(duration).trim();
    if (!str) return undefined;

    if (/^\d+(\.\d+)?$/.test(str)) {
      const num = parseFloat(str);
      return num > 0 ? Math.round(num * 100) / 100 : undefined;
    }

    const parts = str.split(":").map((p) => parseFloat(p));
    if (parts.some((p) => isNaN(p))) return undefined;

    if (parts.length === 2) {
      // MM:SS
      const [min, sec] = parts;
      if (min === undefined || sec === undefined) return undefined;
      return min * 60 + sec;
    } else if (parts.length === 3) {
      // HH:MM:SS
      const [hrs, min, sec] = parts;
      if (hrs === undefined || min === undefined || sec === undefined) return undefined;
      return hrs * 3600 + min * 60 + sec;
    }

    return undefined;
  }

  /**
   * Parse publication or build dates safely.
   */
  private parseDate(val: any): Date | undefined {
    if (!val) return undefined;
    const text = typeof val === "string" ? val : val["#text"] || String(val);
    const date = new Date(text.trim());
    return isNaN(date.getTime()) ? undefined : date;
  }

  private extractString(val: any): string | undefined {
    if (val === undefined || val === null) return undefined;
    if (typeof val === "string") return val.trim();
    if (typeof val === "number") return String(val);
    if (typeof val === "object") {
      if (val["#text"] !== undefined) return String(val["#text"]).trim();
      if (val["__cdata"] !== undefined) return String(val["__cdata"]).trim();
      if (val["#cdata-section"] !== undefined) return String(val["#cdata-section"]).trim();
      if (val["_"] !== undefined) return String(val["_"]).trim();
    }
    return undefined;
  }

  /**
   * Extract chapters from Podlove Simple Chapters XML (<psc:chapters>) or
   * timestamp lines in the show notes/description.
   */
  private extractChapters(item: any, description?: string, summary?: string): ParsedPodcastChapter[] {
    const chapters: ParsedPodcastChapter[] = [];

    // Check Podlove chapters: <psc:chapters> or <podcast:chapters>
    const pscChapters = item["psc:chapters"]?.["psc:chapter"] || item.chapters?.chapter;
    if (Array.isArray(pscChapters) && pscChapters.length > 0) {
      for (const ch of pscChapters) {
        const title = ch["@_title"] || ch.title || "Chapter";
        const startSec = this.parseDuration(ch["@_start"] || ch.start);
        if (startSec !== undefined) {
          chapters.push({ title: String(title).trim(), startSec });
        }
      }
    }

    if (chapters.length > 0) {
      return this.normalizeChapters(chapters);
    }

    // Extract timestamped lines from description or summary
    const combinedNotes = `${description || ""}\n${summary || ""}`;
    const parsedFromText = this.parseTimestampedChaptersFromText(combinedNotes);
    return this.normalizeChapters(parsedFromText);
  }

  /**
   * Parse chapters from text matching:
   * "00:00 - Intro\n04:30 - Discussion"
   * or inline "[02:15] Viral Hooks [10:30] Retention Curves"
   * or "(01:23) Why Founders Fail"
   */
  parseTimestampedChaptersFromText(text: string): ParsedPodcastChapter[] {
    if (!text) return [];

    const results: ParsedPodcastChapter[] = [];
    const regex = /(?:^|\s|[([<])(\d{1,2}:\d{2}(?::\d{2})?)(?:[)\]>])?(?:\s*[\-–—:]\s*|\s+)/gm;
    let match: RegExpExecArray | null;
    const matches: Array<{ timeStr: string; matchEnd: number; nextStartLimit: number }> = [];

    while ((match = regex.exec(text)) !== null) {
      if (match[1]) {
        matches.push({
          timeStr: match[1],
          matchEnd: match.index + match[0].length,
          nextStartLimit: match.index,
        });
      }
    }

    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      if (!cur) continue;
      const next = matches[i + 1];
      const startSec = this.parseDuration(cur.timeStr);
      if (startSec === undefined) continue;

      let rawTitle = next
        ? text.slice(cur.matchEnd, next.nextStartLimit)
        : text.slice(cur.matchEnd);

      // Take first line if multiline
      let title = rawTitle.split(/\r?\n/)[0]?.trim() || "";
      title = title.replace(/^[\s\-–—:]+/, "").replace(/[\s\-–—:[\]()<>]+$/, "").trim();

      if (title.length > 0) {
        results.push({ title, startSec });
      }
    }

    return results;
  }

  /**
   * Sort chapters by startSec and compute endSec boundary.
   */
  private normalizeChapters(chapters: ParsedPodcastChapter[]): ParsedPodcastChapter[] {
    if (chapters.length === 0) return [];

    const sorted = [...chapters].sort((a, b) => a.startSec - b.startSec);
    // Deduplicate identical timestamps
    const unique: ParsedPodcastChapter[] = [];
    for (const ch of sorted) {
      const prev = unique[unique.length - 1];
      if (!prev || prev.startSec !== ch.startSec) {
        unique.push(ch);
      }
    }

    return unique.map((ch, idx) => {
      const next = unique[idx + 1];
      return {
        title: ch.title,
        startSec: ch.startSec,
        endSec: next ? next.startSec : undefined,
      };
    });
  }
}
