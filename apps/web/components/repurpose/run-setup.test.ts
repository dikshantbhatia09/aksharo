import { describe, expect, it } from "vitest";

import { newRunHref, recallRunSetup, rememberRunSetup, setupOf, startFormFromParams } from "./run-setup";
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
    const setup = setupOf({ ...EMPTY_START_FORM, url: " https://youtu.be/x ", rightsAttested: true });
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
