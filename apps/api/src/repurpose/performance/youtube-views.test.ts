import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  YouTubeViewReader,
  balancedObject,
  isConsentPage,
  readWatchPage,
} from "./youtube-views.js";
import { PAGE_MAX_BYTES, YouTubeHttpError } from "../automations/youtube-http.js";

import type { YouTubeGate } from "../automations/youtube-channels.js";
import type { YouTubeHttp, YouTubeResponse } from "../automations/youtube-http.js";

/**
 * The reader against a real watch page (trimmed, fetched 2026-09-30 by hand:
 * `test/fixtures/youtube/`) and against variants of it made by changing its
 * player data the way YouTube does for a private, removed, age-gated or
 * refused video. Nothing here reaches YouTube.
 */
const VIDEO = "Zgu97mCGS74";
const PAGE = readFileSync(
  join(__dirname, "..", "..", "..", "test", "fixtures", "youtube", `watch-${VIDEO}.html`),
  "utf8",
);
const MARKER = "var ytInitialPlayerResponse = ";

/** The fixture's player data, as an object to change. */
function playerData(): Record<string, unknown> {
  const start = PAGE.indexOf(MARKER) + MARKER.length;
  const json = balancedObject(PAGE, start);
  if (json === null) throw new Error("the fixture has no player data");
  return JSON.parse(json) as Record<string, unknown>;
}

/** The fixture page with its player data replaced. */
function pageWith(change: (data: Record<string, unknown>) => void): string {
  const start = PAGE.indexOf(MARKER) + MARKER.length;
  const original = balancedObject(PAGE, start) ?? "";
  const data = playerData();
  change(data);
  return PAGE.replace(original, JSON.stringify(data));
}

function refused(status: string, reason: string): string {
  return pageWith((data) => {
    data["playabilityStatus"] = { status, reason };
    delete data["videoDetails"];
    delete data["microformat"];
  });
}

describe("readWatchPage", () => {
  it("reads the view count and the publish time off the real page", () => {
    expect(readWatchPage(PAGE, VIDEO)).toEqual({
      kind: "views",
      views: 123_199,
      publishedAt: new Date("2026-09-22T18:00:37.000Z"),
    });
  });

  it("reads the count when the page sets it on window, as some layouts do", () => {
    const page = PAGE.replace(MARKER, 'window["ytInitialPlayerResponse"] = ');
    expect(readWatchPage(page, VIDEO)).toMatchObject({ kind: "views", views: 123_199 });
  });

  it("is not thrown by braces and quotes inside the page's strings", () => {
    const page = pageWith((data) => {
      const details = data["videoDetails"] as Record<string, unknown>;
      details["shortDescription"] = 'A "quoted" line with } and { and \\ in it';
      details["viewCount"] = "4501";
    });
    expect(readWatchPage(page, VIDEO)).toMatchObject({ kind: "views", views: 4501 });
  });

  it("falls back to the microformat's count, and says so when there is none at all", () => {
    const noDetailsCount = pageWith((data) => {
      delete (data["videoDetails"] as Record<string, unknown>)["viewCount"];
    });
    expect(readWatchPage(noDetailsCount, VIDEO)).toMatchObject({ kind: "views", views: 123_199 });

    const noCount = pageWith((data) => {
      delete (data["videoDetails"] as Record<string, unknown>)["viewCount"];
      const microformat = data["microformat"] as Record<string, Record<string, unknown>>;
      delete microformat["playerMicroformatRenderer"]?.["viewCount"];
    });
    expect(readWatchPage(noCount, VIDEO)).toEqual({
      kind: "unreadable",
      detail: "no view count on the page",
    });
  });

  it("refuses a page about another video", () => {
    expect(readWatchPage(PAGE, "AAAAAAAAAAA")).toEqual({
      kind: "unreadable",
      detail: "the page is about another video",
    });
  });

  it("names a private, removed, age-gated or upcoming video", () => {
    expect(readWatchPage(refused("LOGIN_REQUIRED", "This video is private"), VIDEO)).toEqual({
      kind: "unavailable",
      reason: "private",
    });
    expect(readWatchPage(refused("ERROR", "Video unavailable"), VIDEO)).toEqual({
      kind: "unavailable",
      reason: "removed",
    });
    expect(readWatchPage(refused("LOGIN_REQUIRED", "Sign in to confirm your age"), VIDEO)).toEqual({
      kind: "unavailable",
      reason: "age_restricted",
    });
    expect(readWatchPage(refused("LIVE_STREAM_OFFLINE", "Premieres in 2 hours"), VIDEO)).toEqual({
      kind: "unavailable",
      reason: "upcoming",
    });
  });

  it("reads the bot check as a refusal of this server, not as a video that is gone", () => {
    const wall = refused("LOGIN_REQUIRED", "Sign in to confirm you’re not a bot");
    expect(readWatchPage(wall, VIDEO)).toEqual({ kind: "blocked" });
    const messages = pageWith((data) => {
      data["playabilityStatus"] = {
        status: "LOGIN_REQUIRED",
        messages: ["Sign in to confirm you’re not a bot"],
      };
    });
    expect(readWatchPage(messages, VIDEO)).toEqual({ kind: "blocked" });
  });

  it("tells a consent page and an unusual-traffic page from a page it does not know", () => {
    expect(readWatchPage('<form action="https://consent.youtube.com/save"></form>', VIDEO)).toEqual(
      { kind: "unavailable", reason: "consent" },
    );
    expect(
      readWatchPage("<p>Our systems have detected unusual traffic from your network.</p>", VIDEO),
    ).toEqual({ kind: "blocked" });
    expect(readWatchPage("<html><body>Hello</body></html>", VIDEO)).toEqual({
      kind: "unreadable",
      detail: "no player data on the page",
    });
    expect(readWatchPage(`<script>${MARKER}{"broken": </script>`, VIDEO)).toEqual({
      kind: "unreadable",
      detail: "no player data on the page",
    });
  });
});

function http(answer: YouTubeResponse | Error): YouTubeHttp & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
}

function gate(state: { openUntil: number | null; trips: number } = { openUntil: null, trips: 0 }) {
  return {
    state: vi.fn(async () => state),
    trip: vi.fn(async () => Date.now() + 15 * 60_000),
  } satisfies YouTubeGate;
}

function page(status: number, body: string): YouTubeResponse {
  return { status, body: Buffer.from(body, "utf8"), contentType: "text/html" };
}

describe("YouTubeViewReader", () => {
  it("asks for the watch page on the one host, within the page cap", async () => {
    const client = http(page(200, PAGE));
    const doors = gate();
    const reader = new YouTubeViewReader(client, doors);
    expect(await reader.read(VIDEO)).toMatchObject({ kind: "views", views: 123_199 });
    expect(client.get).toHaveBeenCalledWith(`/watch?v=${VIDEO}`, PAGE_MAX_BYTES);
    expect(doors.trip).not.toHaveBeenCalled();
  });

  it("asks nothing while the gate is open or half-open", async () => {
    for (const state of [
      { openUntil: Date.now() + 60_000, trips: 1 },
      { openUntil: null, trips: 1 },
    ]) {
      const client = http(page(200, PAGE));
      expect(await new YouTubeViewReader(client, gate(state)).read(VIDEO)).toEqual({
        kind: "busy",
      });
      expect(client.get).not.toHaveBeenCalled();
    }
  });

  it("trips the gate on a 429, the unusual-traffic redirect and the bot wall", async () => {
    const answers: (YouTubeResponse | Error)[] = [
      page(429, "slow down"),
      new YouTubeHttpError(
        "off_host_redirect",
        "redirected",
        "https://www.google.com/sorry/index?continue=https://www.youtube.com/watch",
      ),
      page(200, refused("LOGIN_REQUIRED", "Sign in to confirm you're not a bot")),
    ];
    for (const answer of answers) {
      const doors = gate();
      expect(await new YouTubeViewReader(http(answer), doors).read(VIDEO)).toEqual({
        kind: "blocked",
      });
      expect(doors.trip).toHaveBeenCalledTimes(1);
    }
  });

  it("does not trip the gate for a consent page, a missing video or a broken connection", async () => {
    const cases: [YouTubeResponse | Error, unknown][] = [
      [
        new YouTubeHttpError(
          "off_host_redirect",
          "redirected",
          "https://consent.youtube.com/m?continue=x",
        ),
        { kind: "unavailable", reason: "consent" },
      ],
      [page(404, "Not Found"), { kind: "unavailable", reason: "removed" }],
      [page(500, "oops"), { kind: "failed", detail: "the page answered 500" }],
      [new YouTubeHttpError("timeout", "slow"), { kind: "failed", detail: "timeout" }],
      [new Error("socket hang up"), { kind: "failed", detail: "network" }],
    ];
    for (const [answer, expected] of cases) {
      const doors = gate();
      expect(await new YouTubeViewReader(http(answer), doors).read(VIDEO)).toEqual(expected);
      expect(doors.trip).not.toHaveBeenCalled();
    }
  });

  it("refuses an id that is not a video id without asking", async () => {
    const client = http(page(200, PAGE));
    expect(await new YouTubeViewReader(client, gate()).read("../../etc")).toEqual({
      kind: "unreadable",
      detail: "not a video id",
    });
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("isConsentPage", () => {
  it("knows YouTube's consent host and nothing else", () => {
    expect(isConsentPage("https://consent.youtube.com/m?continue=x")).toBe(true);
    expect(isConsentPage("https://www.google.com/sorry/index")).toBe(false);
    expect(isConsentPage("not a url")).toBe(false);
    expect(isConsentPage(undefined)).toBe(false);
  });
});
