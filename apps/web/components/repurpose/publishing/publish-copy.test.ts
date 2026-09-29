import { describe, expect, it } from "vitest";

import { ApiError } from "@montaj/api-client";

import {
  PUBLISH_COPY,
  TEXT_LABEL,
  UNAVAILABLE_COPY,
  describePublishError,
  formatClock,
  postStatusLine,
  textLength,
} from "./publish-copy";
import { beginnerSafetyViolations } from "../copy";

import type { PublishPost } from "./use-publishing";

function post(over: Partial<PublishPost>): PublishPost {
  return {
    id: "P1",
    clipId: "C1",
    runId: "R1",
    channel: { id: "CH", name: "Crest Mond", avatarUrl: null },
    provider: "instagram",
    platform: "Instagram",
    shape: "9:16",
    status: "posting",
    state: "ready",
    scheduledAt: null,
    publishedAt: null,
    url: null,
    title: null,
    text: "hello",
    error: null,
    note: null,
    canRetry: false,
    canCancel: true,
    createdAt: "2026-10-01T06:00:00.000Z",
    ...over,
  };
}

describe("posting copy on the run page", () => {
  it("never names the tools behind it", () => {
    const strings: string[] = [];
    for (const value of Object.values(PUBLISH_COPY)) {
      strings.push(typeof value === "function" ? String(value("7:00 pm" as never)) : value);
    }
    strings.push(...Object.values(UNAVAILABLE_COPY));
    for (const label of Object.values(TEXT_LABEL)) strings.push(label.body, label.title ?? "");
    for (const text of strings) {
      expect(beginnerSafetyViolations(text), text).toEqual([]);
    }
  });

  it("says where each post stands in one line", () => {
    expect(postStatusLine(post({ status: "posting" }))).toBe("Posting…");
    expect(
      postStatusLine(post({ status: "posting", note: "Waiting for a free posting slot." })),
    ).toBe("Waiting for a free posting slot.");
    expect(
      postStatusLine(post({ status: "scheduled", scheduledAt: "2026-10-02T13:30:00.000Z" })),
    ).toMatch(/^Scheduled for /);
    expect(
      postStatusLine(
        post({
          status: "failed",
          error: { code: "publishing/x", message: "The account is paused." },
        }),
      ),
    ).toBe("Did not post. The account is paused.");
    expect(postStatusLine(post({ status: "cancelled" }))).toBe("Cancelled");
  });

  it("turns a refusal into a sentence, keeping the API's own for the specific ones", () => {
    const refusal = (code: string, message = "The API said so.") =>
      new ApiError({ code, message, status: 409 });
    expect(
      describePublishError(refusal("publishing/text_invalid", "The X text is too long.")),
    ).toBe("The X text is too long.");
    expect(
      describePublishError(
        refusal("publishing/already_posted", "This clip is already posted on Crest Mond."),
      ),
    ).toBe("This clip is already posted on Crest Mond.");
    // A refusal whose API message may name the service gets a fixed sentence.
    expect(describePublishError(refusal("publishing/not_configured", "Set POSTIZ_API_KEY"))).toBe(
      "Posting to your accounts is not set up yet.",
    );
    expect(describePublishError(refusal("jobs/whatever"))).toBe("That did not work. Try again.");
    expect(describePublishError(new Error("boom"))).toMatch(/could not reach Aksharo/);
  });

  it("counts like X does, and reads a clock", () => {
    expect(textLength("hi https://youtu.be/x", 23)).toBe(3 + 23);
    expect(textLength("hi https://youtu.be/x", null)).toBe(21);
    expect(textLength("नमस्ते", 23)).toBe([..."नमस्ते"].length);
    expect(formatClock("19:00")).toMatch(/^7:00\s?pm$/i);
  });
});
