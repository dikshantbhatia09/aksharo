import { describe, expect, it } from "vitest";

import { postizSetting } from "./postiz-env.js";
import { FAKE_API_URL, FAKE_KEY, FakePostiz } from "./postiz-fake.test-support.js";
import { PostizClient, multipartVideo, retryAfterMsOf, uploadTimeoutMs } from "./postiz.client.js";
import { PostizError } from "./postiz.errors.js";

function client(fake: FakePostiz, env: NodeJS.ProcessEnv = {}): PostizClient {
  return new PostizClient({
    setting: postizSetting({ POSTIZ_API_KEY: FAKE_KEY, POSTIZ_API_URL: FAKE_API_URL, ...env }),
    fetch: fake.fetch as typeof fetch,
    sleep: async () => undefined,
  });
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function failureOf(work: Promise<unknown>): Promise<PostizError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof PostizError) return error;
    throw error;
  }
  throw new Error("expected a PostizError");
}

describe("PostizClient", () => {
  it("lists channels with the key in Authorization as it is, under /public/v1", async () => {
    const fake = new FakePostiz();
    fake.integrations = [
      {
        id: "int-ig",
        name: "Crest Mond",
        identifier: "instagram-standalone",
        profile: "crestmond",
      },
    ];
    const list = await client(fake).listIntegrations();
    expect(list).toEqual([
      expect.objectContaining({
        id: "int-ig",
        identifier: "instagram-standalone",
        profile: "crestmond",
      }),
    ]);
    expect(fake.calls[0]).toMatchObject({
      method: "GET",
      path: "/integrations",
      authorization: FAKE_KEY,
    });
  });

  it("uploads an MP4 as one multipart `file` part labelled video/mp4, streamed", async () => {
    const fake = new FakePostiz();
    const bytes = "\u0000\u0000\u0000\u0018ftypmp42 video bytes";
    const media = await client(fake).uploadVideo({
      body: stream(bytes),
      filename: 'Money "tips"-9x16.mp4',
      sizeBytes: bytes.length,
    });
    expect(media).toEqual({
      id: "media-1",
      path: "https://postiz.example.com/uploads/2026/10/01/file1.mp4",
    });
    expect(fake.uploads[0]).toMatchObject({
      type: "video/mp4",
      filename: "Money tips-9x16.mp4",
      bytes: bytes.length,
    });
  });

  it("creates a post with the channel, the HTML text, the uploaded video and its settings", async () => {
    const fake = new FakePostiz();
    fake.integrations = [{ id: "int-yt", name: "Channel", identifier: "youtube" }];
    const at = new Date("2026-10-02T13:30:00Z");
    const { postId } = await client(fake).createPost({
      type: "schedule",
      date: at,
      integrationId: "int-yt",
      identifier: "youtube",
      contentHtml: "<p>Hello</p>",
      media: { id: "media-1", path: "https://postiz.example.com/uploads/a.mp4" },
      settings: { title: "T", type: "public" },
    });
    expect(postId).toBe("post-1");
    const sent = JSON.parse(fake.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent).toEqual({
      type: "schedule",
      date: at.toISOString(),
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: "int-yt" },
          value: [
            {
              content: "<p>Hello</p>",
              image: [{ id: "media-1", path: "https://postiz.example.com/uploads/a.mp4" }],
            },
          ],
          settings: { title: "T", type: "public", __type: "youtube" },
        },
      ],
    });
  });

  it("reads a window of posts and deletes one", async () => {
    const fake = new FakePostiz();
    fake.integrations = [{ id: "int-x", name: "X", identifier: "x" }];
    const api = client(fake);
    await api.createPost({
      type: "schedule",
      date: new Date("2026-10-02T13:30:00Z"),
      integrationId: "int-x",
      identifier: "x",
      contentHtml: "<p>Hi</p>",
      media: { id: "m", path: "https://postiz.example.com/uploads/m.mp4" },
      settings: {},
    });
    const posts = await api.listPosts(
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-03T00:00:00Z"),
    );
    expect(posts).toEqual([
      expect.objectContaining({
        id: "post-1",
        state: "QUEUE",
        publishDate: "2026-10-02T13:30:00.000Z",
      }),
    ]);
    await expect(api.deletePost("post-1")).resolves.toBe("deleted");
    expect(
      await api.listPosts(new Date("2026-10-01T00:00:00Z"), new Date("2026-10-03T00:00:00Z")),
    ).toEqual([]);
  });

  it("reads one post's analytics, once, with the window in days", async () => {
    const fake = new FakePostiz();
    const figures = [{ label: "Views", data: [{ total: "4820", date: "2026-10-05" }] }];
    fake.analytics.set("post/9", figures);
    await expect(client(fake).postAnalytics("post/9", 30)).resolves.toEqual(figures);
    expect(fake.calls).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/analytics/post/post%2F9",
        authorization: FAKE_KEY,
      }),
    ]);
    expect(fake.analyticsDays).toEqual(["30"]);

    // Never retried: the key's hourly allowance is shared with posting.
    fake.failures.push({ method: "GET", path: "/analytics/post/p1", status: "network" });
    expect((await failureOf(client(fake).postAnalytics("p1", 7))).kind).toBe("network");
    expect(fake.calls.filter((call) => call.path === "/analytics/post/p1")).toHaveLength(1);

    fake.failures.push({
      method: "GET",
      path: "/analytics/post/p2",
      status: 429,
      headers: { "retry-after": "120" },
    });
    expect(await failureOf(client(fake).postAnalytics("p2", 7))).toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 120_000,
    });
  });

  describe("errors", () => {
    it("says a refused key is unauthorized, and never includes the key", async () => {
      const fake = new FakePostiz();
      const api = new PostizClient({
        setting: postizSetting({ POSTIZ_API_KEY: "wrong-key", POSTIZ_API_URL: FAKE_API_URL }),
        fetch: fake.fetch as typeof fetch,
      });
      const error = await failureOf(api.listIntegrations());
      expect(error.kind).toBe("unauthorized");
      expect(error.uncertain).toBe(false);
      expect(`${error.message} ${error.detail ?? ""}`).not.toContain("wrong-key");
    });

    it("carries Postiz's limit and its Retry-After on a 429", async () => {
      const fake = new FakePostiz();
      fake.failures.push({
        method: "POST",
        path: "/posts",
        status: 429,
        headers: { "retry-after": "120" },
      });
      const error = await failureOf(
        client(fake).createPost({
          type: "now",
          date: new Date(),
          integrationId: "i",
          identifier: "x",
          contentHtml: "<p>a</p>",
          media: { id: "m", path: "https://p.example/m.mp4" },
          settings: {},
        }),
      );
      expect(error.kind).toBe("rate_limited");
      expect(error.retryAfterMs).toBe(120_000);
      expect(error.uncertain).toBe(false);
    });

    it("keeps Postiz's own reason for a refused post, for the log", async () => {
      const fake = new FakePostiz();
      fake.failures.push({
        method: "POST",
        path: "/posts",
        status: 400,
        body: {
          statusCode: 400,
          provider: "x",
          name: "X",
          message: "post is too long, please fix it",
        },
      });
      const error = await failureOf(
        client(fake).createPost({
          type: "now",
          date: new Date(),
          integrationId: "i",
          identifier: "x",
          contentHtml: "<p>a</p>",
          media: { id: "m", path: "https://p.example/m.mp4" },
          settings: {},
        }),
      );
      expect(error).toMatchObject({
        kind: "bad_request",
        detail: "post is too long, please fix it",
      });
    });

    it("calls a lost answer uncertain, and a refused connection certain", async () => {
      const fake = new FakePostiz();
      fake.integrations = [{ id: "i", name: "X", identifier: "x" }];
      fake.failures.push({ method: "POST", path: "/posts", status: 502, afterCreate: true });
      const post = {
        type: "now" as const,
        date: new Date(),
        integrationId: "i",
        identifier: "x",
        contentHtml: "<p>a</p>",
        media: { id: "m", path: "https://p.example/m.mp4" },
        settings: {},
      };
      const lost = await failureOf(client(fake).createPost(post));
      expect(lost.kind).toBe("server");
      expect(lost.uncertain).toBe(true);
      // It did land: this is exactly why nothing may re-send it blindly.
      expect(fake.posts).toHaveLength(1);

      fake.failures.push({ method: "POST", path: "/posts", status: "refused" });
      const refused = await failureOf(client(fake).createPost(post));
      expect(refused).toMatchObject({ kind: "unreachable", uncertain: false });
    });

    it("retries a read once, and never a write", async () => {
      const fake = new FakePostiz();
      fake.failures.push({ method: "GET", path: "/integrations", status: "network" });
      await expect(client(fake).listIntegrations()).resolves.toEqual([]);
      expect(fake.calls.filter((call) => call.path === "/integrations")).toHaveLength(2);

      fake.failures.push({ method: "POST", path: "/upload", status: 503 });
      const error = await failureOf(
        client(fake).uploadVideo({ body: stream("x"), filename: "a.mp4", sizeBytes: 1 }),
      );
      expect(error.kind).toBe("server");
      expect(fake.calls.filter((call) => call.path === "/upload")).toHaveLength(1);
    });

    it("stops calling a Postiz that keeps failing, for a minute", async () => {
      const fake = new FakePostiz();
      let now = 1_000_000;
      const api = new PostizClient({
        setting: postizSetting({ POSTIZ_API_KEY: FAKE_KEY, POSTIZ_API_URL: FAKE_API_URL }),
        fetch: fake.fetch as typeof fetch,
        sleep: async () => undefined,
        now: () => now,
      });
      for (let index = 0; index < 3; index += 1) {
        fake.failures.push({ method: "POST", path: "/upload", status: "refused" });
        await failureOf(api.uploadVideo({ body: stream("x"), filename: "a.mp4", sizeBytes: 1 }));
      }
      const before = fake.calls.length;
      const open = await failureOf(api.listIntegrations());
      expect(open.kind).toBe("unreachable");
      expect(fake.calls).toHaveLength(before);
      now += 61_000;
      await expect(api.listIntegrations()).resolves.toEqual([]);
    });

    it("refuses a success answer it cannot read", async () => {
      const fake = new FakePostiz();
      fake.failures.push({
        method: "GET",
        path: "/integrations",
        status: 200,
        body: { not: "a list" },
      });
      const error = await failureOf(client(fake).listIntegrations());
      expect(error.kind).toBe("malformed");
    });

    it("sends nothing at all when no key is set", async () => {
      const fake = new FakePostiz();
      const api = new PostizClient({
        setting: postizSetting({}),
        fetch: fake.fetch as typeof fetch,
      });
      expect(api.configured).toBe(false);
      const error = await failureOf(api.listIntegrations());
      expect(error.kind).toBe("not_configured");
      expect(fake.calls).toHaveLength(0);
    });
  });
});

describe("helpers", () => {
  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMsOf("30", 0)).toBe(30_000);
    expect(retryAfterMsOf(new Date(90_000).toUTCString(), 0)).toBe(90_000);
    expect(retryAfterMsOf(null, 0)).toBeNull();
    expect(retryAfterMsOf("soon", 0)).toBeNull();
  });

  it("gives a larger upload a longer deadline, within reason", () => {
    expect(uploadTimeoutMs(10 * 1024 * 1024)).toBe(80_000);
    expect(uploadTimeoutMs(10 * 1024 * 1024 * 1024)).toBe(20 * 60_000);
  });

  it("wraps a stream as one multipart part without reading it all first", async () => {
    const body = multipartVideo(stream("abc"), "B", 'a"b.mp4');
    const text = await new Response(body).text();
    expect(text).toBe(
      '--B\r\nContent-Disposition: form-data; name="file"; filename="ab.mp4"\r\n' +
        "Content-Type: video/mp4\r\n\r\nabc\r\n--B--\r\n",
    );
  });
});
