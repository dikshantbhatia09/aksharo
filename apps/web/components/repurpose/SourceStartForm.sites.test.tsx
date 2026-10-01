import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { DETAIL_COPY } from "./copy";
import { linkSite, linkSitesPhrase, normaliseSourceLink } from "./source-link";
import {
  EMPTY_START_FORM,
  SourceStartForm,
  validateStartForm,
  type StartFormValue,
} from "./SourceStartForm";

/**
 * Vimeo, Google Drive and Dropbox links on the start form (2026-10-01): which
 * site a link is on, the copy that names the sites a workspace can use, and
 * the form's own answer to a site that is still off. The API's parser stays
 * the control (`apps/api/src/repurpose/source-url.ts`).
 */

describe("linkSite", () => {
  it("names each site by its host, however the link was pasted", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
      ["https://youtu.be/dQw4w9WgXcQ", "youtube"],
      ["vimeo.com/76979871", "vimeo"],
      ["http://player.vimeo.com/video/76979871", "vimeo"],
      ["https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view", "gdrive"],
      ["Here it is https://www.dropbox.com/s/abc123xyz/talk.mp4?dl=0", "dropbox"],
      ["https://DROPBOX.com/scl/fi/a1b2c3d4e5/talk.mp4?rlkey=k1k2k3k4k5", "dropbox"],
    ];
    for (const [pasted, site] of cases) {
      expect(linkSite(normaliseSourceLink(pasted)), pasted).toBe(site);
    }
  });

  it("is not fooled by a lookalike host, and names nothing else", () => {
    for (const link of [
      "https://vimeo.com.example.test/76979871",
      "https://example.test/vimeo.com/76979871",
      "https://docs.google.com/document/d/x/edit",
      "https://dl.dropboxusercontent.com/s/abc/talk.mp4",
      "https://www.dailymotion.com/video/x7tgad0",
      "http://vimeo.com/76979871",
      "not a link",
    ]) {
      expect(linkSite(link), link).toBeNull();
    }
  });

  it("names the sites a workspace can use, in plain words", () => {
    expect(linkSitesPhrase(false)).toBe("A YouTube link");
    expect(linkSitesPhrase(true)).toBe("A YouTube, Vimeo, Google Drive or Dropbox link");
  });
});

describe("start form validation for other video sites", () => {
  const link = (url: string): StartFormValue => ({
    ...EMPTY_START_FORM,
    tab: "link",
    url,
    rightsAttested: true,
  });

  it("accepts a Vimeo, Drive or Dropbox link while those sites are on", () => {
    for (const url of [
      "vimeo.com/76979871",
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view",
      "https://www.dropbox.com/s/abc123xyz/talk.mp4",
    ]) {
      expect(validateStartForm(link(url), { otherSites: true }).url, url).toBeUndefined();
    }
  });

  it("answers in the API's words while they are off, and leaves YouTube alone", () => {
    expect(validateStartForm(link("vimeo.com/76979871")).url).toBe(
      "Links from that site are not available yet. Paste a YouTube link, or upload the video file.",
    );
    expect(validateStartForm(link("youtu.be/dQw4w9WgXcQ")).url).toBeUndefined();
    // Any other host is still the API's to answer, as before.
    expect(validateStartForm(link("https://media.test/v.mp4")).url).toBeUndefined();
  });

  it("asks for a link to one video, naming Vimeo only when it is on", () => {
    expect(validateStartForm(link("not a link"), { otherSites: true }).url).toMatch(/vimeo\.com/);
    expect(validateStartForm(link("not a link")).url).not.toMatch(/vimeo/);
  });
});

describe("<SourceStartForm /> copy for other video sites", () => {
  function Harness({
    otherSites,
    url = "",
  }: {
    readonly otherSites?: boolean;
    readonly url?: string;
  }): React.JSX.Element {
    const [value, setValue] = React.useState<StartFormValue>({ ...EMPTY_START_FORM, url });
    return (
      <SourceStartForm
        value={value}
        onChange={setValue}
        onSubmit={() => undefined}
        {...(otherSites === undefined ? {} : { otherSites })}
      />
    );
  }

  it("names every site the workspace can use", () => {
    const { unmount } = render(<Harness otherSites />);
    expect(screen.getByText(/A YouTube, Vimeo, Google Drive or Dropbox link\./)).toBeTruthy();
    unmount();
    render(<Harness />);
    expect(screen.getByText(/^A YouTube link\./)).toBeTruthy();
  });

  it("says a link on another site is processed from its start", () => {
    render(<Harness otherSites url="https://vimeo.com/76979871" />);
    expect(screen.getByText(DETAIL_COPY.windowLine(undefined, true))).toBeTruthy();
    expect(DETAIL_COPY.windowLine(undefined, true)).toMatch(/from the start/);
    expect(DETAIL_COPY.windowLine(undefined)).toMatch(/most-replayed/);
  });
});
