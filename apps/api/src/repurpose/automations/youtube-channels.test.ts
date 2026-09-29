import { describe, expect, it, vi } from "vitest";

import { parseChannelUrl } from "./channel-url.js";
import {
  ChannelLookupError,
  NOT_FOUND_TTL_MS,
  RESOLVED_TTL_MS,
  YouTubeChannelDirectory,
} from "./youtube-channels.js";
import {
  CHANNEL,
  MIXED_FEED,
  OTHER_CHANNEL,
  channelPage,
  feedXml,
} from "./youtube-fixtures.test-support.js";
import {
  FEED_MAX_BYTES,
  PAGE_MAX_BYTES,
  SafeYouTubeHttp,
  YouTubeHttpError,
  isBlockPage,
  staysOnYouTube,
  youtubeUrl,
} from "./youtube-http.js";

import type { YouTubeGate } from "./youtube-channels.js";
import type { YouTubeHttp, YouTubeResponse } from "./youtube-http.js";
import type {
  AddressResolver,
  SafeTransport,
  SafeTransportRequest,
  SafeTransportResponse,
} from "../../common/net/index.js";
import type { SourceGateState } from "../source-gate.js";

/** `www.youtube.com` resolving to a public address, as it does. */
const RESOLVER: AddressResolver = async (hostname) => {
  if (hostname === "www.youtube.com") return [{ address: "142.250.183.14", family: 4 }];
  if (hostname === "consent.youtube.com") return [{ address: "142.250.183.15", family: 4 }];
  throw new Error(`ENOTFOUND ${hostname}`);
};

function reply(
  status: number,
  body = "",
  headers: Record<string, string> = {},
): SafeTransportResponse {
  return {
    status,
    headers,
    body: (async function* stream() {
      if (body !== "") yield new TextEncoder().encode(body);
    })(),
    destroy: () => undefined,
  };
}

function http(...replies: SafeTransportResponse[]) {
  const sent: SafeTransportRequest[] = [];
  const transport = vi.fn<SafeTransport>(async (request) => {
    sent.push(request);
    const next = replies.shift();
    if (next === undefined) throw new Error("no more replies");
    return next;
  });
  return { client: new SafeYouTubeHttp({ resolver: RESOLVER, transport }), sent, transport };
}

async function httpError(run: Promise<unknown>): Promise<YouTubeHttpError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof YouTubeHttpError) return error;
    throw error;
  }
  throw new Error("expected a YouTubeHttpError");
}

describe("SafeYouTubeHttp: one host, no detours", () => {
  it("asks www.youtube.com for the path, anonymously: no cookie, an honest agent", async () => {
    const { client, sent } = http(
      reply(200, "<feed/>", { "content-type": "application/atom+xml" }),
    );
    const response = await client.get(`/feeds/videos.xml?channel_id=${CHANNEL}`, FEED_MAX_BYTES);
    expect(response).toMatchObject({ status: 200, contentType: "application/atom+xml" });
    expect(response.body.toString("utf8")).toBe("<feed/>");

    const [request] = sent;
    expect(request?.url.toString()).toBe(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
    );
    expect(request?.address).toBe("142.250.183.14");
    expect(request?.headers["host"]).toBe("www.youtube.com");
    expect(request?.headers["user-agent"]).toMatch(/Aksharo/);
    expect(Object.keys(request?.headers ?? {}).map((key) => key.toLowerCase())).not.toContain(
      "cookie",
    );
  });

  it("builds only paths on the one host, never a URL from elsewhere", () => {
    expect(youtubeUrl("/@AksharoTestKitchen").toString()).toBe(
      "https://www.youtube.com/@AksharoTestKitchen",
    );
    for (const path of [
      "https://evil.test/x",
      "//evil.test/x",
      "evil.test/x",
      "/\\evil.test/x",
      "",
    ]) {
      expect(() => youtubeUrl(path), path).toThrow(YouTubeHttpError);
    }
  });

  it("follows a redirect that stays on www.youtube.com", async () => {
    const { client, sent } = http(
      reply(301, "", { location: "https://www.youtube.com/@AksharoTestKitchen" }),
      reply(200, "page"),
    );
    const response = await client.get("/c/AksharoKitchen", PAGE_MAX_BYTES);
    expect(response.status).toBe(200);
    expect(sent.map((request) => request.url.toString())).toEqual([
      "https://www.youtube.com/c/AksharoKitchen",
      "https://www.youtube.com/@AksharoTestKitchen",
    ]);
  });

  it("refuses every redirect off the host, without contacting it", async () => {
    for (const location of [
      "https://consent.youtube.com/m?continue=x",
      "http://www.youtube.com/@AksharoTestKitchen",
      "https://www.youtube.com:8443/@x",
      "https://user:pw@www.youtube.com/@x",
      "https://evil.test/",
      "https://www.google.com/sorry/index?continue=x",
    ]) {
      const { client, transport } = http(reply(302, "", { location }));
      const error = await httpError(client.get("/@AksharoTestKitchen", PAGE_MAX_BYTES));
      expect(error.code, location).toBe("off_host_redirect");
      expect(error.location).toBe(new URL(location).toString());
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it("stops reading past the byte cap, and says so", async () => {
    const { client } = http(reply(200, "x".repeat(2_048)));
    const error = await httpError(client.get("/@AksharoTestKitchen", 1_024));
    expect(error.code).toBe("too_large");
  });

  it("reports a transport failure as a network error, never a raw socket error", async () => {
    const transport = vi.fn<SafeTransport>(async () => {
      throw new Error("ECONNRESET");
    });
    const client = new SafeYouTubeHttp({ resolver: RESOLVER, transport });
    expect((await httpError(client.get("/@x", PAGE_MAX_BYTES))).code).toBe("network");
  });

  it("refuses when www.youtube.com resolves to this machine", async () => {
    const transport = vi.fn<SafeTransport>(async () => reply(200, "never"));
    const client = new SafeYouTubeHttp({
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      transport,
    });
    expect((await httpError(client.get("/@x", PAGE_MAX_BYTES))).code).toBe("network");
    expect(transport).not.toHaveBeenCalled();
  });

  it("knows its own host and Google's block page", () => {
    expect(staysOnYouTube(new URL("https://www.youtube.com/@x"))).toBe(true);
    expect(staysOnYouTube(new URL("https://youtube.com/@x"))).toBe(false);
    expect(isBlockPage("https://www.google.com/sorry/index?continue=1")).toBe(true);
    expect(isBlockPage("https://google.com/sorry/")).toBe(true);
    expect(isBlockPage("https://consent.youtube.com/m")).toBe(false);
    expect(isBlockPage("https://evil.test/sorry")).toBe(false);
    expect(isBlockPage(undefined)).toBe(false);
  });
});

/** A fake YouTube: canned answers per path, and a record of what was asked. */
function fakeYouTube(answers: Record<string, YouTubeResponse | YouTubeHttpError>) {
  const asked: string[] = [];
  const client: YouTubeHttp = {
    get: async (path) => {
      asked.push(path);
      // eslint-disable-next-line security/detect-object-injection -- a test's own table
      const answer = answers[path];
      if (answer === undefined) return { status: 404, body: Buffer.from(""), contentType: null };
      if (answer instanceof YouTubeHttpError) throw answer;
      return answer;
    },
  };
  return { client, asked };
}

function ok(body: string): YouTubeResponse {
  return { status: 200, body: Buffer.from(body, "utf8"), contentType: "text/html" };
}

function fakeGate(state: SourceGateState = { openUntil: null, trips: 0 }) {
  const trips: number[] = [];
  const gate: YouTubeGate & { current: SourceGateState } = {
    current: state,
    state: async () => gate.current,
    trip: async (now = 0) => {
      trips.push(now);
      gate.current = { openUntil: now + 15 * 60_000, trips: gate.current.trips + 1 };
      return now + 15 * 60_000;
    },
  };
  return { gate, trips };
}

function parsed(raw: string) {
  const result = parseChannelUrl(raw);
  if (!result.ok) throw new Error(result.code);
  return result.channel;
}

const FEED_PATH = `/feeds/videos.xml?channel_id=${CHANNEL}`;

async function lookupError(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ChannelLookupError) return error.code;
    throw error;
  }
  throw new Error("expected a ChannelLookupError");
}

describe("YouTubeChannelDirectory", () => {
  it("resolves a handle from its page, and a channel id from its feed", async () => {
    const { client, asked } = fakeYouTube({
      "/@AksharoTestKitchen": ok(channelPage()),
      [FEED_PATH]: ok(MIXED_FEED),
    });
    const directory = new YouTubeChannelDirectory(client, fakeGate().gate);

    await expect(
      directory.resolve(parsed("https://www.youtube.com/@AksharoTestKitchen")),
    ).resolves.toEqual({
      channelId: CHANNEL,
      title: "Aksharo Test Kitchen & Friends",
      handle: "AksharoTestKitchen",
    });
    await expect(
      directory.resolve(parsed(`https://www.youtube.com/channel/${CHANNEL}`)),
    ).resolves.toEqual({
      channelId: CHANNEL,
      title: "Aksharo Test Kitchen",
      handle: null,
    });
    expect(asked).toEqual(["/@AksharoTestKitchen", FEED_PATH]);
  });

  it("remembers what a link resolved to, and that a channel does not exist", async () => {
    let now = 1_000_000;
    const { client, asked } = fakeYouTube({ "/@AksharoTestKitchen": ok(channelPage()) });
    const directory = new YouTubeChannelDirectory(client, fakeGate().gate, () => now);
    const link = parsed("https://www.youtube.com/@AksharoTestKitchen");
    const missing = parsed("https://www.youtube.com/@NobodyHere");

    await directory.resolve(link);
    await directory.resolve(parsed("https://m.youtube.com/@aksharotestkitchen/videos"));
    expect(asked).toEqual(["/@AksharoTestKitchen"]);
    now += RESOLVED_TTL_MS + 1;
    await directory.resolve(link);
    expect(asked).toHaveLength(2);

    expect(await lookupError(directory.resolve(missing))).toBe("not_found");
    expect(await lookupError(directory.resolve(missing))).toBe("not_found");
    expect(asked.filter((path) => path === "/@NobodyHere")).toHaveLength(1);
    now += NOT_FOUND_TTL_MS + 1;
    expect(await lookupError(directory.resolve(missing))).toBe("not_found");
    expect(asked.filter((path) => path === "/@NobodyHere")).toHaveLength(2);
  });

  it("reads nothing while the gate is open or half-open", async () => {
    for (const state of [
      { openUntil: Date.now() + 60_000, trips: 1 },
      { openUntil: null, trips: 2 },
    ]) {
      const { client, asked } = fakeYouTube({ [FEED_PATH]: ok(MIXED_FEED) });
      const directory = new YouTubeChannelDirectory(client, fakeGate(state).gate);
      expect(await lookupError(directory.uploads(CHANNEL))).toBe("busy");
      expect(await lookupError(directory.resolve(parsed("https://www.youtube.com/@x_y")))).toBe(
        "busy",
      );
      expect(asked).toEqual([]);
    }
  });

  it("trips the gate on a 429 or Google's block page, for the downloads too", async () => {
    const limited = fakeYouTube({
      [FEED_PATH]: { status: 429, body: Buffer.from(""), contentType: null },
    });
    const first = fakeGate();
    const directory = new YouTubeChannelDirectory(limited.client, first.gate, () => 5_000);
    expect(await lookupError(directory.uploads(CHANNEL))).toBe("busy");
    expect(first.trips).toEqual([5_000]);
    // The next read waits for the gate instead of asking again.
    expect(await lookupError(directory.uploads(CHANNEL))).toBe("busy");
    expect(limited.asked).toHaveLength(1);

    const sorry = fakeYouTube({
      [FEED_PATH]: new YouTubeHttpError(
        "off_host_redirect",
        "redirected",
        "https://www.google.com/sorry/index?continue=x",
      ),
    });
    const second = fakeGate();
    await lookupError(new YouTubeChannelDirectory(sorry.client, second.gate).uploads(CHANNEL));
    expect(second.trips).toHaveLength(1);

    // A consent page is not a block: nothing is tripped.
    const consent = fakeYouTube({
      [FEED_PATH]: new YouTubeHttpError(
        "off_host_redirect",
        "redirected",
        "https://consent.youtube.com/m",
      ),
    });
    const third = fakeGate();
    expect(
      await lookupError(new YouTubeChannelDirectory(consent.client, third.gate).uploads(CHANNEL)),
    ).toBe("unavailable");
    expect(third.trips).toEqual([]);
  });

  it("says what went wrong with a feed: gone, down, or not a feed of this channel", async () => {
    const answers = (response: YouTubeResponse) =>
      new YouTubeChannelDirectory(fakeYouTube({ [FEED_PATH]: response }).client, fakeGate().gate);
    expect(
      await lookupError(
        answers({ status: 404, body: Buffer.from(""), contentType: null }).uploads(CHANNEL),
      ),
    ).toBe("not_found");
    expect(
      await lookupError(
        answers({ status: 503, body: Buffer.from(""), contentType: null }).uploads(CHANNEL),
      ),
    ).toBe("unavailable");
    expect(await lookupError(answers(ok("<html>not a feed</html>")).uploads(CHANNEL))).toBe(
      "unreadable",
    );
    expect(
      await lookupError(answers(ok(feedXml([], { channelId: OTHER_CHANNEL }))).uploads(CHANNEL)),
    ).toBe("unreadable");
    expect(await lookupError(answers(ok(MIXED_FEED)).uploads("UCnot-an-id"))).toBe("unreadable");
  });

  it("refuses a page that does not say which channel it is", async () => {
    const { client } = fakeYouTube({
      "/@AksharoTestKitchen": ok("<html><head><title>Before you continue</title></head></html>"),
    });
    const directory = new YouTubeChannelDirectory(client, fakeGate().gate);
    expect(
      await lookupError(directory.resolve(parsed("https://www.youtube.com/@AksharoTestKitchen"))),
    ).toBe("unreadable");
  });
});
