/* eslint-disable security/detect-object-injection -- a test fake indexing its own arrays */
/**
 * A pretend Postiz Public API, behind a `fetch`, for the publishing tests.
 *
 * It answers the five calls the client makes the way Postiz v1.47 does
 * (`apps/backend/src/public-api/routes/v1/public.integrations.controller.ts`),
 * including two of its quirks worth testing against: the key goes in
 * `Authorization` bare, and deleting a post it no longer has is a 500, not a
 * 404 (`getPost` dereferences an empty list). Nothing leaves the process.
 */

export interface FakeIntegration {
  readonly id: string;
  readonly name: string;
  readonly identifier: string;
  readonly picture?: string | null;
  readonly disabled?: boolean;
  readonly profile?: string | null;
}

export interface FakePost {
  readonly id: string;
  readonly integrationId: string;
  readonly identifier: string;
  readonly content: string;
  readonly settings: Record<string, unknown>;
  readonly media: readonly { readonly id: string; readonly path: string }[];
  readonly type: string;
  publishDate: string;
  state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT";
  releaseURL: string | null;
  deleted: boolean;
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

/** One scripted answer for the next call to a path. */
export interface FakeFailure {
  readonly method?: string;
  readonly path: string;
  /** An HTTP status to answer with, or `network` for a connection that breaks. */
  readonly status: number | "network" | "refused" | "timeout";
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** For `/posts`: create the post first, then fail (the "lost answer" case). */
  readonly afterCreate?: boolean;
}

export const FAKE_KEY = "test-postiz-key";
export const FAKE_API_URL = "http://127.0.0.1:4007/api";

export class FakePostiz {
  integrations: FakeIntegration[] = [];
  readonly posts: FakePost[] = [];
  readonly uploads: { id: string; path: string; bytes: number; filename: string; type: string }[] =
    [];
  readonly calls: FakeCall[] = [];
  readonly failures: FakeFailure[] = [];
  /**
   * Per post id, what `GET /analytics/post/{id}` answers (2026-10-05); a post
   * not listed answers `[]`, as Postiz does for a platform with no figures.
   */
  readonly analytics = new Map<string, unknown>();
  /** The `date` (days) each analytics read asked for, in order. */
  readonly analyticsDays: (string | null)[] = [];
  now: () => number = () => Date.now();
  private sequence = 0;

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const prefix = "/api/public/v1";
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const headers = new Headers(init?.headers);
    const raw = init?.body === undefined || init.body === null ? null : init.body;
    const bytes =
      raw === null
        ? null
        : new Uint8Array(
            await new Response(raw as ConstructorParameters<typeof Response>[0]).arrayBuffer(),
          );
    const text = bytes === null ? null : new TextDecoder("latin1").decode(bytes);
    this.calls.push({ method, path, authorization: headers.get("authorization"), body: text });

    if (headers.get("authorization") !== FAKE_KEY) {
      return json(401, { msg: "Invalid API key" });
    }

    const failureAt = this.failures.findIndex(
      (failure) => failure.path === path && (failure.method ?? method) === method,
    );
    const failure = failureAt === -1 ? undefined : this.failures.splice(failureAt, 1)[0];
    if (failure !== undefined && failure.afterCreate !== true) return answerFailure(failure);

    if (method === "GET" && path === "/integrations") {
      return json(
        200,
        this.integrations.map((integration) => ({
          id: integration.id,
          name: integration.name,
          identifier: integration.identifier,
          picture: integration.picture ?? null,
          disabled: integration.disabled ?? false,
          profile: integration.profile ?? null,
        })),
      );
    }

    if (method === "POST" && path === "/upload") {
      const type = headers.get("content-type") ?? "";
      if (!type.startsWith("multipart/form-data; boundary=") || text === null) {
        return json(400, { message: "No file provided" });
      }
      const header =
        /Content-Disposition: form-data; name="file"; filename="([^"]*)"\r\nContent-Type: ([^\r]+)\r\n\r\n/.exec(
          text,
        );
      if (header === null) return json(400, { message: "No file provided" });
      const boundary = type.slice("multipart/form-data; boundary=".length);
      const start = (header.index ?? 0) + header[0].length;
      const end = text.lastIndexOf(`\r\n--${boundary}--`);
      this.sequence += 1;
      const upload = {
        id: `media-${String(this.sequence)}`,
        path: `https://postiz.example.com/uploads/2026/10/01/file${String(this.sequence)}.mp4`,
        bytes: end - start,
        filename: header[1] ?? "",
        type: header[2] ?? "",
      };
      this.uploads.push(upload);
      return json(201, {
        id: upload.id,
        name: upload.filename,
        path: upload.path,
        originalName: null,
        thumbnail: null,
        alt: null,
      });
    }

    if (method === "POST" && path === "/posts") {
      const body = JSON.parse(text ?? "{}") as {
        type: string;
        date: string;
        posts: {
          integration: { id: string };
          value: { content: string; image: { id: string; path: string }[] }[];
          settings: Record<string, unknown>;
        }[];
      };
      const created = [];
      for (const post of body.posts) {
        const integration = this.integrations.find((entry) => entry.id === post.integration.id);
        if (integration === undefined) {
          return json(400, { message: `Integration with id ${post.integration.id} not found` });
        }
        this.sequence += 1;
        const row: FakePost = {
          id: `post-${String(this.sequence)}`,
          integrationId: integration.id,
          identifier: integration.identifier,
          content: post.value[0]?.content ?? "",
          settings: post.settings,
          media: post.value[0]?.image ?? [],
          type: body.type,
          publishDate: body.type === "now" ? new Date(this.now()).toISOString() : body.date,
          state: "QUEUE",
          releaseURL: null,
          deleted: false,
        };
        this.posts.push(row);
        created.push({ postId: row.id, integration: integration.id });
      }
      if (failure !== undefined) return answerFailure(failure);
      return json(201, created);
    }

    if (method === "GET" && path === "/posts") {
      const start = Date.parse(url.searchParams.get("startDate") ?? "");
      const end = Date.parse(url.searchParams.get("endDate") ?? "");
      if (Number.isNaN(start) || Number.isNaN(end)) return json(400, { message: "bad dates" });
      return json(200, {
        posts: this.posts
          .filter((post) => !post.deleted)
          .filter((post) => {
            const at = Date.parse(post.publishDate);
            return at >= start && at <= end;
          })
          .map((post) => ({
            id: post.id,
            content: post.content,
            publishDate: post.publishDate,
            releaseURL: post.releaseURL,
            releaseId: null,
            state: post.state,
            group: `group-${post.id}`,
            integration: {
              id: post.integrationId,
              providerIdentifier: post.identifier,
              name: "Account",
              picture: null,
            },
          })),
      });
    }

    const analyticsMatch = /^\/analytics\/post\/([^/]+)$/.exec(path);
    if (method === "GET" && analyticsMatch !== null) {
      this.analyticsDays.push(url.searchParams.get("date"));
      return json(200, this.analytics.get(decodeURIComponent(analyticsMatch[1] ?? "")) ?? []);
    }

    const deleteMatch = /^\/posts\/([^/]+)$/.exec(path);
    if (method === "DELETE" && deleteMatch !== null) {
      const post = this.posts.find(
        (entry) => entry.id === decodeURIComponent(deleteMatch[1] ?? "") && !entry.deleted,
      );
      // Postiz v1.47: a post it does not have is a TypeError, so a 500.
      if (post === undefined)
        return json(500, { statusCode: 500, message: "Internal server error" });
      post.deleted = true;
      return json(200, { id: post.id });
    }

    return json(404, { message: `Cannot ${method} ${path}` });
  };

  /** A post Postiz has, by the order it was created. */
  post(index = 0): FakePost {
    const post = this.posts[index];
    if (post === undefined) throw new Error(`no post ${String(index)}`);
    return post;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function answerFailure(failure: FakeFailure): Promise<Response> {
  if (failure.status === "network") {
    return Promise.reject(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    );
  }
  if (failure.status === "refused") {
    return Promise.reject(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
  }
  if (failure.status === "timeout") {
    return Promise.reject(
      Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
    );
  }
  return Promise.resolve(
    json(failure.status, failure.body ?? { message: "failed" }, failure.headers),
  );
}
