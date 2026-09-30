import { describe, expect, it } from "vitest";

import {
  AUTOPILOT_SHARE,
  DEFAULT_PEXELS_REQUESTS_PER_HOUR,
  PexelsBudget,
  PexelsClient,
  PexelsError,
  pexelsSetting,
} from "./pexels.client.js";

import type { SafeTransport, SafeTransportRequest } from "../common/net/index.js";

/** A photo in the shape Pexels documents for `GET /v1/search` and `GET /v1/photos/:id`. */
function pexelsPhoto(id: number, width = 3000, height = 4500) {
  const base = `https://images.pexels.com/photos/${String(id)}/pexels-photo-${String(id)}.jpeg`;
  return {
    id,
    width,
    height,
    url: `https://www.pexels.com/photo/taj-mahal-${String(id)}/`,
    photographer: "Asha Rao",
    photographer_url: "https://www.pexels.com/@asha-rao",
    photographer_id: 42,
    avg_color: "#978E82",
    alt: "The Taj Mahal at sunrise",
    liked: false,
    src: {
      original: base,
      large2x: `${base}?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940`,
      large: `${base}?auto=compress&cs=tinysrgb&h=650&w=940`,
      medium: `${base}?auto=compress&cs=tinysrgb&h=350`,
      small: `${base}?auto=compress&cs=tinysrgb&h=130`,
      portrait: `${base}?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800`,
      landscape: `${base}?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200`,
      tiny: `${base}?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280`,
    },
  };
}

interface Reply {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: string | Uint8Array;
}

/** A transport that answers from `route`, and remembers every request it was asked. */
function fakeTransport(route: (request: SafeTransportRequest) => Reply) {
  const asked: SafeTransportRequest[] = [];
  const transport: SafeTransport = async (request) => {
    asked.push(request);
    const reply = route(request);
    const bytes =
      typeof reply.body === "string" ? new TextEncoder().encode(reply.body) : reply.body;
    return {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
      body: (async function* () {
        yield bytes;
      })(),
      destroy: () => undefined,
    };
  };
  return { transport, asked };
}

const resolver = async () => [{ address: "104.18.0.10", family: 4 as const }];

function client(
  route: (request: SafeTransportRequest) => Reply,
  options: { key?: string | null; perHour?: number; now?: () => number } = {},
) {
  const { transport, asked } = fakeTransport(route);
  const pexels = new PexelsClient(
    {
      apiKey: options.key === undefined ? "test-key" : options.key,
      requestsPerHour: options.perHour ?? 150,
    },
    { transport, resolver, ...(options.now === undefined ? {} : { clock: options.now }) },
  );
  return { pexels, asked };
}

describe("pexelsSetting", () => {
  it("is off without a key, and keeps the hourly allowance under Pexels's own", () => {
    expect(pexelsSetting({})).toEqual({
      apiKey: null,
      requestsPerHour: DEFAULT_PEXELS_REQUESTS_PER_HOUR,
    });
    expect(pexelsSetting({ PEXELS_API_KEY: "  k  ", PEXELS_REQUESTS_PER_HOUR: "90" })).toEqual({
      apiKey: "k",
      requestsPerHour: 90,
    });
    expect(pexelsSetting({ PEXELS_API_KEY: "k", PEXELS_REQUESTS_PER_HOUR: "5000" })).toEqual({
      apiKey: "k",
      requestsPerHour: 200,
    });
    expect(pexelsSetting({ PEXELS_REQUESTS_PER_HOUR: "nope" }).requestsPerHour).toBe(
      DEFAULT_PEXELS_REQUESTS_PER_HOUR,
    );
  });
});

describe("PexelsClient.search", () => {
  it("asks api.pexels.com with the key, and reads the documented shape", async () => {
    const { pexels, asked } = client(() => ({
      status: 200,
      body: JSON.stringify({
        page: 1,
        per_page: 2,
        total_results: 2,
        photos: [pexelsPhoto(1), pexelsPhoto(2, 4000, 3000)],
        next_page: "https://api.pexels.com/v1/search/?page=2&per_page=2&query=taj+mahal",
      }),
    }));
    const photos = await pexels.search(
      "taj mahal",
      { orientation: "portrait", perPage: 2 },
      "person",
    );
    expect(photos).toHaveLength(2);
    expect(photos[0]).toEqual({
      id: 1,
      width: 3000,
      height: 4500,
      pageUrl: "https://www.pexels.com/photo/taj-mahal-1/",
      photographer: "Asha Rao",
      photographerUrl: "https://www.pexels.com/@asha-rao",
      alt: "The Taj Mahal at sunrise",
      originalUrl: "https://images.pexels.com/photos/1/pexels-photo-1.jpeg",
      previewUrl:
        "https://images.pexels.com/photos/1/pexels-photo-1.jpeg?auto=compress&cs=tinysrgb&h=350",
    });
    const request = asked[0];
    expect(request?.url.host).toBe("api.pexels.com");
    expect(request?.url.pathname).toBe("/v1/search");
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      query: "taj mahal",
      per_page: "2",
      page: "1",
      orientation: "portrait",
    });
    expect(request?.headers["authorization"]).toBe("test-key");
    expect(request?.address).toBe("104.18.0.10");
  });

  it("refuses without a key, and sends nothing", async () => {
    const { pexels, asked } = client(() => ({ status: 200, body: "{}" }), { key: null });
    expect(pexels.enabled).toBe(false);
    await expect(pexels.search("chai", { perPage: 5 }, "person")).rejects.toMatchObject({
      code: "disabled",
    });
    expect(asked).toEqual([]);
  });

  it("turns an answer it does not understand into 'unavailable', never a crash", async () => {
    const shapes: Reply[] = [
      { status: 200, body: "<html>maintenance</html>" },
      { status: 200, body: JSON.stringify({ photos: [{ id: "x" }] }) },
      { status: 500, body: "{}" },
    ];
    for (const reply of shapes) {
      const { pexels } = client(() => reply);
      await expect(pexels.search("chai", { perPage: 5 }, "person")).rejects.toMatchObject({
        code: "unavailable",
      });
    }
  });

  it("never follows a redirect off api.pexels.com", async () => {
    const { pexels, asked } = client(() => ({
      status: 302,
      headers: { location: "https://evil.example.test/v1/search" },
      body: "",
    }));
    await expect(pexels.search("chai", { perPage: 5 }, "person")).rejects.toBeInstanceOf(
      PexelsError,
    );
    expect(asked.map((request) => request.url.host)).toEqual(["api.pexels.com"]);
  });
});

describe("the hourly allowance", () => {
  it("keeps a third of it for people: Autopilot stops at two thirds", () => {
    let now = 0;
    const budget = new PexelsBudget(9, () => now);
    const autopilot = Math.floor(9 * AUTOPILOT_SHARE);
    for (let call = 0; call < autopilot; call += 1) expect(budget.take("autopilot")).toBe(true);
    expect(budget.take("autopilot")).toBe(false);
    for (let call = autopilot; call < 9; call += 1) expect(budget.take("person")).toBe(true);
    expect(budget.take("person")).toBe(false);
    // An hour later the calls have aged out.
    now = 60 * 60_000;
    expect(budget.take("autopilot")).toBe(true);
  });

  it("pauses every call after a 429, and until the month's reset when none are left", async () => {
    let now = Date.UTC(2026, 9, 5, 10);
    const reset = Math.floor(Date.UTC(2026, 10, 1) / 1_000);
    let reply: Reply = { status: 429, body: "{}" };
    const { pexels, asked } = client(() => reply, { now: () => now });
    await expect(pexels.search("chai", { perPage: 5 }, "person")).rejects.toMatchObject({
      code: "busy",
    });
    await expect(pexels.search("chai", { perPage: 5 }, "person")).rejects.toMatchObject({
      code: "busy",
    });
    expect(asked).toHaveLength(1);

    now += 16 * 60_000;
    reply = {
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
      body: JSON.stringify({ photos: [] }),
    };
    await expect(pexels.search("chai", { perPage: 5 }, "person")).resolves.toEqual([]);
    now += 24 * 60 * 60_000;
    await expect(pexels.search("chai", { perPage: 5 }, "person")).rejects.toMatchObject({
      code: "busy",
    });
    expect(asked).toHaveLength(2);
    expect(pexels.budget.pausedUntil).toBe(reset * 1_000);
  });
});

describe("PexelsClient.photo and download", () => {
  it("reads a photo by id, and its bytes from images.pexels.com at a bounded size", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const { pexels, asked } = client((request) =>
      request.url.host === "api.pexels.com"
        ? { status: 200, body: JSON.stringify(pexelsPhoto(77, 3000, 4500)) }
        : { status: 200, headers: { "content-type": "image/jpeg" }, body: jpeg },
    );
    const photo = await pexels.photo(77, "person");
    expect(asked[0]?.url.pathname).toBe("/v1/photos/77");
    const bytes = await pexels.download(photo, 2560, 8 * 1024 * 1024);
    expect(bytes).toEqual(jpeg);
    const download = asked[1];
    expect(download?.url.host).toBe("images.pexels.com");
    // At exactly the photo's shape, the long side cut to 2560; the key is never sent there.
    expect(Object.fromEntries(download?.url.searchParams ?? [])).toMatchObject({
      w: "1707",
      h: "2560",
    });
    expect(download?.headers["authorization"]).toBeUndefined();
  });

  it("refuses a photo whose file is anywhere but images.pexels.com", async () => {
    const { pexels, asked } = client(() => ({ status: 200, body: "{}" }));
    const photo = {
      id: 1,
      width: 100,
      height: 100,
      pageUrl: "",
      photographer: "",
      photographerUrl: "",
      alt: "",
      originalUrl: "https://169.254.169.254/latest/meta-data",
      previewUrl: "",
    };
    await expect(pexels.download(photo, 2560, 1_000)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(asked).toEqual([]);
  });

  it("says a photo Pexels does not have is not found", async () => {
    const { pexels } = client(() => ({ status: 404, body: "{}" }));
    await expect(pexels.photo(5, "person")).rejects.toMatchObject({ code: "not_found" });
  });
});
