import { describe, expect, it } from "vitest";

import { MAX_COUNT } from "./metrics.js";
import { parsePostizAnalytics } from "./postiz-analytics.js";

/** The shape Postiz documents for `GET /public/v1/analytics/post/{postId}`. */
const DOCUMENTED = [
  {
    label: "Likes",
    data: [{ total: "150", date: "2025-01-01" }],
    percentageChange: 16.7,
  },
  { label: "Views", data: [{ total: "4820", date: "2025-01-01" }], percentageChange: 3.1 },
  { label: "Comments", data: [{ total: "12", date: "2025-01-01" }], percentageChange: 0 },
  { label: "Shares", data: [{ total: "9", date: "2025-01-01" }], percentageChange: 0 },
];

describe("parsePostizAnalytics", () => {
  it("reads the documented answer into the four numbers", () => {
    expect(parsePostizAnalytics(DOCUMENTED)).toEqual({
      counts: { views: 4820, likes: 150, comments: 12, shares: 9 },
      extra: {},
    });
  });

  it("sums a series, as Postiz's own view reads one", () => {
    const answer = [
      {
        label: "Views",
        data: [
          { total: "100", date: "2025-01-01" },
          { total: "250", date: "2025-01-02" },
          { total: 50, date: "2025-01-03" },
        ],
      },
    ];
    expect(parsePostizAnalytics(answer)?.counts.views).toBe(400);
  });

  it("finds each number by the platform's own name for it", () => {
    // X: impressions stand for views, retweets for shares, replies for comments.
    const x = [
      { label: "Impressions", data: [{ total: "9000", date: "2025-01-01" }] },
      { label: "Likes", data: [{ total: "300", date: "2025-01-01" }] },
      { label: "Retweets", data: [{ total: "40", date: "2025-01-01" }] },
      { label: "Replies", data: [{ total: "25", date: "2025-01-01" }] },
      { label: "Quotes", data: [{ total: "4", date: "2025-01-01" }] },
      { label: "Bookmarks", data: [{ total: "18", date: "2025-01-01" }] },
    ];
    expect(parsePostizAnalytics(x)).toEqual({
      counts: { views: 9000, likes: 300, comments: 25, shares: 40 },
      extra: { Quotes: 4, Bookmarks: 18 },
    });
    // A page with both says views with its views, and keeps impressions aside.
    const both = [
      { label: "Impressions", data: [{ total: "9000" }] },
      { label: "Video Views", data: [{ total: "2100" }] },
      { label: "Reactions", data: [{ total: "80" }] },
    ];
    expect(parsePostizAnalytics(both)).toEqual({
      counts: { views: 2100, likes: 80, comments: null, shares: null },
      extra: { Impressions: 9000 },
    });
  });

  it("leaves out a rate, which a sum of counts would misrepresent", () => {
    const answer = [
      { label: "Views", data: [{ total: "1000" }] },
      { label: "Engagement", average: true, data: [{ total: "4.5" }, { total: "5.5" }] },
    ];
    expect(parsePostizAnalytics(answer)).toEqual({
      counts: { views: 1000, likes: null, comments: null, shares: null },
      extra: {},
    });
  });

  it("reads odd shapes: a wrapper, capitals, commas, an inline total", () => {
    const answer = {
      analytics: [
        { label: "  LIKES ", data: [{ total: "1,234" }] },
        { name: "views", total: 5_000 },
      ],
    };
    expect(parsePostizAnalytics(answer)?.counts).toEqual({
      views: 5000,
      likes: 1234,
      comments: null,
      shares: null,
    });
  });

  it("skips what does not read rather than guessing at it", () => {
    const answer = [
      { label: "Views", data: [{ total: "12k" }, { total: -5 }, { total: null }, "junk"] },
      { label: "Likes", data: "not a list" },
      { data: [{ total: "5" }] },
      { label: "", data: [{ total: "5" }] },
      null,
      "Views",
      { label: "Comments", data: [{ total: "7" }] },
    ];
    expect(parsePostizAnalytics(answer)).toEqual({
      counts: { views: null, likes: null, comments: 7, shares: null },
      extra: {},
    });
  });

  it("caps a count at what the column holds", () => {
    const answer = [{ label: "Views", data: [{ total: String(MAX_COUNT) }, { total: "10" }] }];
    expect(parsePostizAnalytics(answer)?.counts.views).toBe(MAX_COUNT);
  });

  it("keeps a label that names an object's prototype as data", () => {
    const answer = [{ label: "__proto__", data: [{ total: "3" }] }];
    const parsed = parsePostizAnalytics(answer);
    expect(Object.getPrototypeOf(parsed?.extra)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed?.extra ?? {}, "__proto__")).toBe(true);
  });

  it("reads an empty list as no numbers, and anything else as not an answer", () => {
    expect(parsePostizAnalytics([])).toEqual({
      counts: { views: null, likes: null, comments: null, shares: null },
      extra: {},
    });
    expect(parsePostizAnalytics({ message: "not found" })).toBeNull();
    expect(parsePostizAnalytics("Views: 10")).toBeNull();
    expect(parsePostizAnalytics(null)).toBeNull();
  });
});
