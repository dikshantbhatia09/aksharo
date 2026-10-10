import { describe, expect, it } from "vitest";

import {
  defaultPostText,
  fullEpisodeUrl,
  hashtagsIn,
  problemWithText,
  readCopy,
  textLength,
  xLength,
} from "./post-text.js";

const EPISODE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("fullEpisodeUrl", () => {
  it("builds the canonical watch link from a YouTube fingerprint only", () => {
    expect(fullEpisodeUrl("youtube:dQw4w9WgXcQ")).toBe(EPISODE);
    expect(fullEpisodeUrl("url:https://cdn.example.com/a.mp4")).toBeNull();
    expect(fullEpisodeUrl("youtube:not-an-id")).toBeNull();
    expect(fullEpisodeUrl(null)).toBeNull();
  });
});

describe("defaultPostText with an empty copy", () => {
  // The copy is filled by a separate step that may not have run: `{}`.
  const words = { title: "Why most people never save", copy: {}, sourceUrl: EPISODE };

  it("uses the clip's title and the full-episode link, and invents no hashtags", () => {
    const instagram = defaultPostText("instagram", words);
    expect(instagram).toEqual({
      title: null,
      body: `Why most people never save\n\nWatch the full episode: ${EPISODE}`,
    });
    expect(hashtagsIn(instagram.body)).toEqual([]);
  });

  it("gives YouTube a title of its own", () => {
    expect(defaultPostText("youtube", words)).toEqual({
      title: "Why most people never save",
      body: `Watch the full episode: ${EPISODE}`,
    });
  });

  it("says nothing about an episode for an uploaded video", () => {
    expect(defaultPostText("linkedin", { ...words, sourceUrl: null }).body).toBe(
      "Why most people never save",
    );
  });
});

describe("defaultPostText with the clip's copy", () => {
  const copy = {
    summary: "Three habits that decide whether you ever save.",
    hook: "Stop doing this with your salary",
    cta: "Follow for more",
    hashtags: ["#money", "#savings", "#finance", "#india", "#salary", "#tips", "not-a-tag"],
    locale: "hi-Latn",
    title: "The salary mistake",
    platforms: {
      youtube: {
        title: "The salary mistake nobody talks about",
        description: "Watch till the end.",
      },
      x: { text: "Your salary is not the problem." },
    },
  };
  const words = { title: "Clip 3", copy, sourceUrl: EPISODE };

  it("reads each field on its own and drops anything that is not a hashtag", () => {
    expect(readCopy(copy).hashtags).toHaveLength(6);
    expect(readCopy({ hashtags: "nope", platforms: [] }).hashtags).toEqual([]);
  });

  it("writes Instagram's caption from the hook, the summary, the link and five hashtags", () => {
    expect(defaultPostText("instagram", words).body).toBe(
      [
        "Stop doing this with your salary",
        "Three habits that decide whether you ever save.",
        `Watch the full episode: ${EPISODE}`,
        "#money #savings #finance #india #salary",
      ].join("\n\n"),
    );
  });

  it("uses a platform's own copy as written, adding the episode link when it is missing", () => {
    expect(defaultPostText("youtube", words)).toEqual({
      title: "The salary mistake nobody talks about",
      body: `Watch till the end.\n\nWatch the full episode: ${EPISODE}`,
    });
    expect(defaultPostText("x", words).body).toBe(
      `Your salary is not the problem.\n\nWatch the full episode: ${EPISODE}`,
    );
  });

  it("keeps LinkedIn and X to their hashtag budgets", () => {
    expect(hashtagsIn(defaultPostText("linkedin", words).body)).toHaveLength(3);
    const threads = defaultPostText("threads", words).body;
    expect(hashtagsIn(threads).length).toBeLessThanOrEqual(1);
  });

  it("reads platform-tailored copy from socialPack when present", () => {
    const packWords = {
      title: "Base title",
      copy: {
        summary: "Base summary",
        hook: "Base hook",
        cta: "Base cta",
        hashtags: ["#money"],
        locale: "en",
        socialPack: {
          youtube: {
            title: "Scaling to $1M ARR #Shorts",
            description: "Deep dive into SaaS growth.",
            tags: ["Shorts", "SaaS"],
          },
          instagram: {
            caption: "Stop doing this in 2026 🛑",
            callToAction: "Save this reel",
            hashtags: ["#startups", "#saas"],
          },
          tiktok: {
            caption: "Brutal truth about startups #fyp",
            hashtags: ["#fyp"],
          },
          linkedin: {
            postText: "Strategic problem -> framework -> question.",
            hashtags: ["#leadership"],
          },
          twitter: {
            tweetText: "Most founders get customer acquisition wrong.",
          },
        },
      },
      sourceUrl: null,
    };

    const parsed = readCopy(packWords.copy);
    expect(parsed.platform.youtube.title).toBe("Scaling to $1M ARR #Shorts");
    expect(parsed.platform.instagram).toBe("Stop doing this in 2026 🛑");
    expect(parsed.platform.tiktok).toBe("Brutal truth about startups #fyp");
    expect(parsed.platform.linkedin).toBe("Strategic problem -> framework -> question.");
    expect(parsed.platform.x).toBe("Most founders get customer acquisition wrong.");

    const ytPost = defaultPostText("youtube", packWords);
    expect(ytPost.title).toBe("Scaling to $1M ARR #Shorts");
    expect(ytPost.body).toBe("Deep dive into SaaS growth.");

    const tweetPost = defaultPostText("x", packWords);
    expect(tweetPost.body).toBe("Most founders get customer acquisition wrong.");
  });
});

describe("fitting X's 280", () => {
  it("counts a link as 23 and Latin or Hindi as one", () => {
    expect(xLength(`hi ${EPISODE}`)).toBe(3 + 23);
    expect(xLength("नमस्ते")).toBe([..."नमस्ते"].length);
    expect(xLength("你好")).toBe(4);
  });

  it("shortens the words, never the link, to fit", () => {
    const long = "word ".repeat(120).trim();
    const text = defaultPostText("x", { title: long, copy: {}, sourceUrl: EPISODE });
    expect(textLength("x", text.body)).toBeLessThanOrEqual(280);
    expect(text.body.endsWith(`Watch the full episode: ${EPISODE}`)).toBe(true);
    expect(text.body).toContain("…");
  });
});

describe("problemWithText", () => {
  it("refuses empty text, text past the limit, and a YouTube video without a title", () => {
    expect(problemWithText("instagram", { title: null, body: "   " })).toBe(
      "Write something for Instagram.",
    );
    expect(problemWithText("x", { title: null, body: "a".repeat(281) })).toBe(
      "The X text is too long: 280 characters at most.",
    );
    expect(problemWithText("youtube", { title: "", body: "ok" })).toBe(
      "Give the YouTube video a title.",
    );
    expect(problemWithText("youtube", { title: "t".repeat(101), body: "ok" })).toBe(
      "The YouTube title is too long: 100 characters at most.",
    );
    expect(problemWithText("youtube", { title: "Fine", body: "ok" })).toBeNull();
  });
});
