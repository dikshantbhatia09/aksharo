import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PUBLISH_ERROR_BEHAVIOUR,
  PUBLISH_ERROR_CODES,
  ChannelConnectionViewSchema,
  PublishBatchViewSchema,
  PublishCallbackEventSchema,
  PublishDispatchPayloadSchema,
  PublishDispatchResultSchema,
  PublishErrorSchema,
  PublishReconcilePayloadSchema,
  PublishTargetViewSchema,
  findSecretFields,
  isTerminalTargetStatus,
  publishDispatchJobKey,
  publishReconcileJobKey,
} from "./schema.js";

function fixture(name: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as unknown;
}

const TARGET_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";

describe("publishing@1 fixtures", () => {
  it("accepts the documented connection, batch, callback and job examples", () => {
    expect(ChannelConnectionViewSchema.safeParse(fixture("connection.v1.json")).success).toBe(true);
    expect(PublishBatchViewSchema.safeParse(fixture("batch.v1.json")).success).toBe(true);
    expect(PublishCallbackEventSchema.safeParse(fixture("callback.v1.json")).success).toBe(true);
    expect(
      PublishDispatchPayloadSchema.safeParse(fixture("dispatch-payload.v1.json")).success,
    ).toBe(true);
    expect(PublishDispatchResultSchema.safeParse(fixture("dispatch-result.v1.json")).success).toBe(
      true,
    );
  });

  it("round-trips a fixture through parse without changing it", () => {
    const source = fixture("batch.v1.json");
    const parsed = PublishBatchViewSchema.parse(source);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(source);
  });

  it("refuses a URL whose scheme is not https", () => {
    // `z.url()` alone accepts javascript: and data:, and every URL here is either
    // rendered as a link or comes back from a provider.
    const source = fixture("connection.v1.json") as Record<string, unknown>;
    for (const avatarUrl of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "http://example.test/avatar.png",
      "file:///etc/passwd",
    ]) {
      expect(
        ChannelConnectionViewSchema.safeParse({ ...source, avatarUrl }).success,
        avatarUrl,
      ).toBe(false);
    }
    expect(
      ChannelConnectionViewSchema.safeParse({
        ...source,
        avatarUrl: "https://example.test/avatar.png",
      }).success,
    ).toBe(true);
  });

  it("refuses a non-https public post URL on a published target", () => {
    const batch = fixture("batch.v1.json") as { targets: Record<string, unknown>[] };
    expect(
      PublishTargetViewSchema.safeParse({
        ...batch.targets[0],
        status: "published",
        externalUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown schema version", () => {
    const source = fixture("connection.v1.json") as Record<string, unknown>;
    expect(ChannelConnectionViewSchema.safeParse({ ...source, schemaVersion: 2 }).success).toBe(
      false,
    );
  });
});

describe("the token boundary (ADR 0002)", () => {
  it("names every secret-shaped key it finds, at any depth", () => {
    expect(findSecretFields({ accessToken: "x" })).toEqual(["accessToken"]);
    expect(findSecretFields({ a: { b: { refresh_token: "x" } } })).toEqual([
      "a.b.refresh_token",
    ]);
    expect(findSecretFields({ list: [{ apiKey: "x" }] })).toEqual(["list.0.apiKey"]);
    expect(findSecretFields({ displayName: "fine", username: "fine" })).toEqual([]);
  });

  it("refuses a connection payload carrying a provider token", () => {
    const source = fixture("connection.v1.json") as Record<string, unknown>;
    const result = ChannelConnectionViewSchema.safeParse({ ...source, accessToken: "secret" });
    expect(result.success).toBe(false);
  });

  it("refuses a token hidden inside the capability snapshot", () => {
    const source = fixture("connection.v1.json") as Record<string, unknown>;
    const capabilities = { ...(source["capabilities"] as object), refreshToken: "secret" };
    expect(ChannelConnectionViewSchema.safeParse({ ...source, capabilities }).success).toBe(false);
  });
});

describe("publish targets", () => {
  function target(overrides: Record<string, unknown> = {}): unknown {
    const batch = fixture("batch.v1.json") as { targets: Record<string, unknown>[] };
    return { ...batch.targets[0], ...overrides };
  }

  it("refuses a schedule without an instant", () => {
    expect(PublishTargetViewSchema.safeParse(target({ publishMode: "schedule" })).success).toBe(
      false,
    );
  });

  it("refuses an instant on a direct post", () => {
    expect(
      PublishTargetViewSchema.safeParse(target({ scheduledAt: "2026-09-16T04:30:00.000Z" }))
        .success,
    ).toBe(false);
  });

  it("refuses settings belonging to another provider", () => {
    expect(
      PublishTargetViewSchema.safeParse(
        target({ settings: { provider: "threads", surface: "post" } }),
      ).success,
    ).toBe(false);
  });

  it("refuses a published target with nowhere to look at it", () => {
    expect(PublishTargetViewSchema.safeParse(target({ status: "published" })).success).toBe(false);
    expect(
      PublishTargetViewSchema.safeParse(
        target({ status: "published", externalUrl: "https://example.test/p/1" }),
      ).success,
    ).toBe(true);
  });

  it("knows which statuses are terminal", () => {
    expect(isTerminalTargetStatus("published")).toBe(true);
    expect(isTerminalTargetStatus("failed_permanent")).toBe(true);
    expect(isTerminalTargetStatus("cancelled")).toBe(true);
    expect(isTerminalTargetStatus("failed_retryable")).toBe(false);
    expect(isTerminalTargetStatus("processing")).toBe(false);
  });
});

describe("batch mode describes its targets", () => {
  it("rejects a batch that calls itself `now` while a target is scheduled", () => {
    const batch = fixture("batch.v1.json") as Record<string, unknown>;
    expect(PublishBatchViewSchema.safeParse({ ...batch, mode: "now" }).success).toBe(false);
  });
});

describe("safe errors", () => {
  it("gives every code a documented behaviour", () => {
    for (const code of PUBLISH_ERROR_CODES) {
      // eslint-disable-next-line security/detect-object-injection -- `code` comes from the frozen contract list, not from input
      expect(PUBLISH_ERROR_BEHAVIOUR[code]).toBeTypeOf("string");
    }
  });

  it("requires Retry-After on a rate limit and forbids it elsewhere", () => {
    expect(
      PublishErrorSchema.safeParse({
        code: "publishing/rate_limited",
        message: "Instagram is asking us to wait.",
        retryAfterMs: null,
      }).success,
    ).toBe(false);
    expect(
      PublishErrorSchema.safeParse({
        code: "publishing/rate_limited",
        message: "Instagram is asking us to wait.",
        retryAfterMs: 60_000,
      }).success,
    ).toBe(true);
    expect(
      PublishErrorSchema.safeParse({
        code: "publishing/provider_unavailable",
        message: "Instagram is not responding.",
        retryAfterMs: 60_000,
      }).success,
    ).toBe(false);
  });

  it("marks an uncertain outcome as reconcile-first, never retryable", () => {
    expect(PUBLISH_ERROR_BEHAVIOUR["publishing/uncertain_outcome"]).toBe("reconcile_first");
  });

  it("keeps the message short enough to render and rejects a raw provider dump", () => {
    expect(
      PublishErrorSchema.safeParse({
        code: "publishing/content_rejected",
        message: "x".repeat(2_000),
        retryAfterMs: null,
      }).success,
    ).toBe(false);
  });
});

describe("job contracts", () => {
  it("carries an id and nothing else into the queue", () => {
    const parsed = PublishDispatchPayloadSchema.parse(fixture("dispatch-payload.v1.json"));
    expect(Object.keys(parsed).sort()).toEqual(["attemptNo", "publishTargetId", "schemaVersion"]);
  });

  it("refuses a dispatch payload that smuggles copy or a media URL", () => {
    expect(
      PublishDispatchPayloadSchema.safeParse({
        schemaVersion: 1,
        publishTargetId: TARGET_ID,
        attemptNo: 1,
        mediaUrl: "https://example.test/signed",
      }).success,
    ).toBe(false);
  });

  it("refuses a failed result with no error, and a successful one with an error", () => {
    expect(
      PublishDispatchResultSchema.safeParse({
        schemaVersion: 1,
        publishTargetId: TARGET_ID,
        status: "failed_retryable",
        externalPostId: null,
        externalUrl: null,
        error: null,
      }).success,
    ).toBe(false);
    expect(
      PublishDispatchResultSchema.safeParse({
        schemaVersion: 1,
        publishTargetId: TARGET_ID,
        status: "published",
        externalPostId: "ig_1",
        externalUrl: "https://example.test/p/ig_1",
        error: {
          code: "publishing/provider_unavailable",
          message: "n/a",
          retryAfterMs: null,
        },
      }).success,
    ).toBe(false);
  });

  it("refuses to call a target published without its provider reference", () => {
    expect(
      PublishDispatchResultSchema.safeParse({
        schemaVersion: 1,
        publishTargetId: TARGET_ID,
        status: "published",
        externalPostId: null,
        externalUrl: "https://example.test/p/1",
        error: null,
      }).success,
    ).toBe(false);
  });

  it("bounds reconciliation so polling cannot run forever", () => {
    expect(
      PublishReconcilePayloadSchema.safeParse({
        schemaVersion: 1,
        publishTargetId: TARGET_ID,
        checkNo: 101,
      }).success,
    ).toBe(false);
  });

  it("keys one dispatch job per attempt and one reconcile per target", () => {
    expect(publishDispatchJobKey(TARGET_ID, 1)).toBe(`publish.dispatch:${TARGET_ID}:1`);
    expect(publishDispatchJobKey(TARGET_ID, 2)).not.toBe(publishDispatchJobKey(TARGET_ID, 1));
    expect(publishReconcileJobKey(TARGET_ID)).toBe(`publish.reconcile:${TARGET_ID}`);
  });
});
