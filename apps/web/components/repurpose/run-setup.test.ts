import { describe, expect, it } from "vitest";

import {
  linkFromSourceDisplay,
  newRunHref,
  recallRunSetup,
  rememberRunSetup,
  setupOf,
  startContextFromParams,
  startFormFromParams,
} from "./run-setup";
import { EMPTY_START_FORM, RECOMMENDED_STYLES } from "./SourceStartForm";

/**
 * "Choose another video" used to open an empty form: the caption look, the
 * languages and the method all had to be picked again, and for a link that only
 * needed fixing, the link was gone too (clips hardening, 2026-09-26).
 */
const STYLE = RECOMMENDED_STYLES[1]?.id ?? RECOMMENDED_STYLES[0]?.id ?? "";

const SETUP = {
  sourceLanguage: "hi",
  outputLanguage: "en",
  scriptMode: "native",
  styleId: STYLE,
  method: "ai" as const,
  requestedCandidates: 7,
  link: "https://www.youtube.com/watch?v=abc",
};

describe("remembering a run's setup", () => {
  it("round-trips through this browser's storage, per run", () => {
    rememberRunSetup("01RUNA", SETUP);
    expect(recallRunSetup("01RUNA")).toEqual(SETUP);
    expect(recallRunSetup("01RUNB")).toBeUndefined();
  });

  it("survives storage it cannot read", () => {
    window.localStorage.setItem("aksharo.repurpose.setups", "{not json");
    expect(recallRunSetup("01RUNA")).toBeUndefined();
  });

  it("never carries the rights confirmation", () => {
    const setup = setupOf({
      ...EMPTY_START_FORM,
      url: " https://youtu.be/x ",
      rightsAttested: true,
    });
    expect(setup).not.toHaveProperty("rightsAttested");
    expect(setup.link).toBe("https://youtu.be/x");
  });
});

describe("newRunHref and startFormFromParams", () => {
  it("hands the setup back to the start form, and the link only when asked", () => {
    const another = startFormFromParams(
      new URL(newRunHref(SETUP, { keepLink: false }), "https://app.test").searchParams,
      undefined,
    );
    expect(another.url).toBe("");
    expect(another.sourceLanguage).toBe("hi");
    expect(another.outputLanguage).toBe("en");
    expect(another.scriptMode).toBe("native");
    expect(another.styleId).toBe(STYLE);
    expect(another.requestedCandidates).toBe(7);
    // Consent is never pre-filled from a URL.
    expect(another.rightsAttested).toBe(false);

    const fix = startFormFromParams(
      new URL(newRunHref(SETUP, { keepLink: true }), "https://app.test").searchParams,
      undefined,
    );
    expect(fix.url).toBe(SETUP.link);
  });

  it("is a plain new form when nothing was remembered", () => {
    expect(newRunHref(undefined, { keepLink: true })).toBe("/repurpose/new");
  });

  // A run this browser never saw (another device, a private window, or one
  // started before setups were remembered) lost its link on "Start again with
  // this video": the form opened on an empty "Paste a link".
  it("carries a link it is given even when no setup was remembered", () => {
    const link = "https://www.youtube.com/watch?v=kE0oUEzVVes";
    const form = startFormFromParams(
      new URL(newRunHref(undefined, { keepLink: true, link }), "https://app.test").searchParams,
      "en",
    );
    expect(form.url).toBe(link);
    expect(form.tab).toBe("link");
    // Only when the link is wanted: "Choose another video" still clears it.
    expect(newRunHref(undefined, { keepLink: false, link })).toBe("/repurpose/new");
    // The link as the person pasted it wins over the one rebuilt from the run.
    const kept = new URL(newRunHref(SETUP, { keepLink: true, link }), "https://app.test");
    expect(kept.searchParams.get("url")).toBe(SETUP.link);
  });

  // A failed upload run's "Upload it again" landed on "Paste a link".
  it("opens the upload tab for a failed upload run, remembered setup or not", () => {
    const { link: _link, ...uploadSetup } = SETUP;
    const again = startFormFromParams(
      new URL(newRunHref(uploadSetup, { keepLink: false, upload: true }), "https://app.test")
        .searchParams,
      undefined,
    );
    expect(again.tab).toBe("upload");
    expect(again.styleId).toBe(STYLE);

    expect(newRunHref(undefined, { keepLink: false, upload: true })).toBe(
      "/repurpose/new?source=upload",
    );
    expect(startFormFromParams(new URLSearchParams("source=upload"), "en").tab).toBe("upload");
  });

  it("stays on the link tab unless asked, and whenever a link is carried", () => {
    expect(startFormFromParams(new URLSearchParams(""), "en").tab).toBe("link");
    expect(
      startFormFromParams(new URLSearchParams("source=upload&url=https%3A%2F%2Fyoutu.be%2Fx"), "en")
        .tab,
    ).toBe("link");
  });

  it("ignores values nobody could have picked, since anyone can craft the URL", () => {
    const form = startFormFromParams(
      new URLSearchParams("style=not-a-style&out=klingon&script=morse&n=999&lang=<script>"),
      "en",
    );
    expect(form.styleId).toBe(EMPTY_START_FORM.styleId);
    expect(form.outputLanguage).toBe(EMPTY_START_FORM.outputLanguage);
    expect(form.scriptMode).toBe(EMPTY_START_FORM.scriptMode);
    expect(form.requestedCandidates).toBe(EMPTY_START_FORM.requestedCandidates);
    expect(form.sourceLanguage).toBe("en");
  });

  it("asks for no AI moments on a manual run", () => {
    const form = startFormFromParams(new URLSearchParams("method=manual&n=5"), "en");
    expect(form.method).toBe("manual");
    expect(form.requestedCandidates).toBe(0);
  });
});

describe("linkFromSourceDisplay", () => {
  // The display the API writes for a YouTube run (`youtubeResult` in its
  // `source-url.ts`), as production's own runs carry it.
  it("rebuilds the canonical link from a YouTube run's display", () => {
    expect(linkFromSourceDisplay("youtube.com · kE0oUEzVVes")).toBe(
      "https://www.youtube.com/watch?v=kE0oUEzVVes",
    );
    expect(linkFromSourceDisplay(" youtube.com · a-b_c123XYZ ")).toBe(
      "https://www.youtube.com/watch?v=a-b_c123XYZ",
    );
  });

  it("gives no link for anything else, rather than a guess", () => {
    for (const display of [
      null,
      undefined,
      "",
      "My holiday.mp4",
      "cdn.example.com/video.mp4",
      "youtube.com · short",
      "youtube.com · kE0oUEzVVes&list=PL1",
      "evil.com · kE0oUEzVVes",
    ]) {
      expect(linkFromSourceDisplay(display), String(display)).toBeUndefined();
    }
  });
});

/**
 * Plan limits (2026-09-27): the spoken language may be "Detect automatically"
 * (`auto`), a link may carry where its window starts, and a too-long run's
 * "Pick where to start" hands the link, the video's length and the cursor to
 * "Start at".
 */
describe("the start and the detected language through the query string", () => {
  it("carries 'Detect automatically' back to the form, which a language tag check refused", () => {
    const href = newRunHref({ ...SETUP, sourceLanguage: "auto" }, { keepLink: true });
    const form = startFormFromParams(new URL(href, "https://app.test").searchParams, "en");
    expect(form.sourceLanguage).toBe("auto");
  });

  it("remembers a link run's start, and hands it back with the link only", () => {
    const setup = setupOf({
      ...EMPTY_START_FORM,
      url: "https://youtu.be/dQw4w9WgXcQ",
      startAt: "12:10",
    });
    expect(setup.startMs).toBe(730_000);

    const kept = new URL(newRunHref(setup, { keepLink: true }), "https://app.test").searchParams;
    expect(kept.get("start")).toBe("12:10");
    expect(startFormFromParams(kept, undefined).startAt).toBe("12:10");
    // Another video starts from nothing.
    const another = new URL(newRunHref(setup, { keepLink: false }), "https://app.test");
    expect(another.searchParams.get("start")).toBeNull();
    // An upload has no window, so no start is remembered for it.
    expect(
      setupOf({ ...EMPTY_START_FORM, tab: "upload", url: "https://youtu.be/x", startAt: "1:00" })
        .startMs,
    ).toBeUndefined();
  });

  it("drops a start that is not a time, since anyone can craft the URL", () => {
    const params = new URLSearchParams("url=https%3A%2F%2Fyoutu.be%2Fx&start=soon");
    expect(startFormFromParams(params, "en").startAt).toBe("");
    // And one without a link is about no video at all.
    expect(startFormFromParams(new URLSearchParams("start=1:00"), "en").startAt).toBe("");
  });

  it("sends 'Pick where to start' with the link, the length and the cursor, setup or not", () => {
    const link = "https://www.youtube.com/watch?v=kE0oUEzVVes";
    const href = newRunHref(undefined, {
      keepLink: true,
      link,
      pickStart: true,
      lengthMs: 2_077_000,
    });
    const params = new URL(href, "https://app.test").searchParams;
    expect(params.get("url")).toBe(link);
    // The length is that link's, so it travels with the link it belongs to.
    expect(startContextFromParams(params)).toEqual({
      focusStartAt: true,
      knownLength: { link, durationMs: 2_077_000 },
    });
  });

  it("ignores a length nobody could have sent, a length with no link, and a pick with no link", () => {
    expect(startContextFromParams(new URLSearchParams("len=2077000"))).toEqual({
      focusStartAt: false,
    });
    expect(startContextFromParams(new URLSearchParams("url=x&pick=start&len=-5"))).toEqual({
      focusStartAt: true,
    });
    expect(
      startContextFromParams(new URLSearchParams(`url=x&len=${String(48 * 3_600_000)}`)),
    ).toEqual({ focusStartAt: false });
    expect(startContextFromParams(new URLSearchParams("pick=start"))).toEqual({
      focusStartAt: false,
    });
  });
});

/**
 * Steering (2026-09-29): a run's topic, clip length and skips go back to the
 * form with the rest of its setup, and only for a run whose moments we picked.
 */
describe("steering through the query string", () => {
  it("remembers what a run was steered with, and hands it back to the form", () => {
    const setup = setupOf({
      ...EMPTY_START_FORM,
      url: "https://youtu.be/dQw4w9WgXcQ",
      topic: " money habits ",
      clipLength: "long",
      skipIntro: "2",
      skipOutro: "0.5",
    });
    expect(setup).toMatchObject({
      topic: "money habits",
      clipLength: "long",
      skipIntroMs: 120_000,
      skipOutroMs: 30_000,
    });

    const form = startFormFromParams(
      new URL(newRunHref(setup, { keepLink: false }), "https://app.test").searchParams,
      "en",
    );
    expect(form).toMatchObject({
      topic: "money habits",
      clipLength: "long",
      skipIntro: "2",
      skipOutro: "0.5",
    });
  });

  it("carries none of it for a run whose person picked the moments", () => {
    const setup = setupOf({
      ...EMPTY_START_FORM,
      method: "manual",
      requestedCandidates: 0,
      topic: "money habits",
    });
    expect(setup).not.toHaveProperty("topic");
    expect(setup).not.toHaveProperty("clipLength");
  });

  it("ignores lengths and skips nobody could have picked", () => {
    const form = startFormFromParams(
      new URLSearchParams(`clip=epic&skipStart=45&skipEnd=-1&about=${"y".repeat(300)}`),
      "en",
    );
    expect(form.clipLength).toBe(EMPTY_START_FORM.clipLength);
    expect(form.skipIntro).toBe("");
    expect(form.skipOutro).toBe("");
    expect(form.topic).toHaveLength(200);
  });
});
