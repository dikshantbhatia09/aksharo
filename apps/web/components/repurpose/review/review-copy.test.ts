import { describe, expect, it } from "vitest";

import { ApiError } from "@montaj/api-client";

import {
  APPROVAL_SETTING_COPY,
  REVIEW_COPY,
  REVIEW_STATE_LABEL,
  SHARE_COPY,
  actorName,
  clipClock,
  describeReviewError,
  listWords,
  shapeWords,
  sinceWords,
  uncoveredNote,
} from "./review-copy";

import { CLIENT_COPY } from "@/app/(share)/share/review/[token]/client-review";
import { beginnerSafetyViolations } from "@/components/repurpose/copy";

/** Every string a copy table holds, functions called with a sample. */
function sentences(table: object): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") {
      out.push(String((value as (...args: unknown[]) => unknown)(3, 1)));
    } else if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  walk(table);
  return out;
}

describe("clip review copy", () => {
  it("never names a tool, a queue or a codename", () => {
    for (const table of [
      REVIEW_COPY,
      REVIEW_STATE_LABEL,
      SHARE_COPY,
      APPROVAL_SETTING_COPY,
      CLIENT_COPY,
    ]) {
      for (const text of sentences(table)) {
        expect(beginnerSafetyViolations(text), text).toEqual([]);
      }
    }
  });

  it("names shapes as a person does, and lists them in a sentence", () => {
    expect(shapeWords("9:16")).toBe("vertical (9:16)");
    expect(shapeWords("1:1")).toBe("square (1:1)");
    expect(listWords(["a"])).toBe("a");
    expect(listWords(["a", "b", "c"])).toBe("a, b and c");
    expect(uncoveredNote(["16:9"])).toBe(
      "The wide (16:9) video was made after this approval. It is not posted until it is approved too.",
    );
    expect(uncoveredNote(["4:5", "1:1"])).toMatch(/^The 4:5 and square \(1:1\) videos were/);
  });

  it("says who decided: a member, a client (named or not), or Aksharo", () => {
    const base = { userId: null, link: null };
    expect(actorName({ ...base, kind: "member", name: "Asha" })).toBe("Asha");
    expect(actorName({ ...base, kind: "member", name: null })).toBe("A former member");
    expect(actorName({ ...base, kind: "client", name: "Priya" })).toBe("Client: Priya");
    expect(actorName({ ...base, kind: "client", name: " " })).toBe("A client");
    expect(actorName({ ...base, kind: "system", name: null })).toBe("Aksharo");
  });

  it("writes times as a clip's clock and as 'how long ago'", () => {
    expect(clipClock(0)).toBe("0:00");
    expect(clipClock(72_900)).toBe("1:12");
    const now = Date.parse("2026-10-03T06:00:00Z");
    expect(sinceWords("2026-10-03T05:55:00Z", now)).toBe("5 minutes ago");
    expect(sinceWords("2026-10-02T06:00:00Z", now)).toBe("yesterday");
    expect(sinceWords(null, now)).toBe("");
  });

  it("uses the API's own sentence for the refusals it writes for people", () => {
    const refusal = (code: string, message: string, status = 409): ApiError =>
      new ApiError({ code, message, status });
    expect(
      describeReviewError(
        refusal("review/forbidden", "Only an owner or admin can approve a clip."),
      ),
    ).toBe("Only an owner or admin can approve a clip.");
    expect(describeReviewError(refusal("review/clip_not_found", "internal", 404))).toBe(
      "That clip is no longer here.",
    );
    expect(describeReviewError(refusal("network/unreachable", "", 0))).toMatch(/could not reach/);
    expect(describeReviewError(new Error("boom"))).toMatch(/could not reach/);
  });
});
