import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { StyleDoc } from "@montaj/caption-styles";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";

import { ExportDialog } from "./ExportDialog";
import { SubtitlesTab } from "./SubtitlesTab";

import { renderWithProviders } from "@/test/harness";

const PROJECT_ID = "01JCPR0JECT000000000000000";

function makeProjection(styleId = "punch-pop"): EdgProjection {
  return {
    canvas: { width: 1080, height: 1920 },
    styles: { defaultStyleId: styleId },
    segments: [],
    words: [],
  } as unknown as EdgProjection;
}

function makeCatalogue(styles: Partial<StyleDoc>[]): ReadonlyMap<string, StyleDoc> {
  return new Map(styles.map((s) => [s.id ?? "unknown", s as StyleDoc]));
}

describe("<ExportDialog /> video track & ASS parity gates (WEB-012 / CORE-019)", () => {
  it("disables the Video export option and displays the refusal reason when hasVideo is false", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportDialog
        open
        onOpenChange={() => undefined}
        projectId={PROJECT_ID}
        projection={makeProjection()}
        catalogue={makeCatalogue([{ id: "punch-pop", name: "Punch Pop", assExportable: true }])}
        registry={{} as FontRegistry}
        shaper={{} as Shaper}
        hasVideo={false}
      />,
    );

    // Video tab trigger is disabled
    const videoTab = screen.getByTestId("export-tab-video");
    expect(videoTab).toBeDisabled();

    // Default tab switches to subtitles when video is unavailable
    expect(screen.getByTestId("export-tab-subtitles")).toHaveAttribute("data-state", "active");

    // Clicking video tab anyway does not switch active tab
    await user.click(videoTab);
    expect(screen.getByTestId("export-tab-subtitles")).toHaveAttribute("data-state", "active");

    // The refusal reason is displayed
    expect(screen.getByTestId("export-no-video-reason")).toHaveTextContent(
      "Cannot export a video from an audio-only source.",
    );
  });

  it("stops offering ASS subtitle export for styles whose assExportable is false", async () => {
    const user = userEvent.setup();
    const nonAssStyles = [
      "editorial-ghost-type",
      "editorial-keyword-zoom",
      "editorial-stack",
    ] as const;

    for (const styleId of nonAssStyles) {
      const { unmount } = renderWithProviders(
        <ExportDialog
          open
          onOpenChange={() => undefined}
          projectId={PROJECT_ID}
          projection={makeProjection(styleId)}
          catalogue={makeCatalogue([
            { id: styleId, name: styleId, assExportable: false },
          ])}
          registry={{} as FontRegistry}
          shaper={{} as Shaper}
          hasVideo={true}
        />,
      );

      await user.click(screen.getByTestId("export-tab-subtitles"));

      // ASS option must not be offered in the format list
      expect(screen.queryByTestId("export-subtitle-format-ass")).toBeNull();

      // SRT and VTT remain available
      expect(screen.getByTestId("export-subtitle-format-srt")).toBeInTheDocument();
      expect(screen.getByTestId("export-subtitle-format-vtt")).toBeInTheDocument();

      unmount();
    }
  });

  it("offers ASS subtitle export when the style is assExportable", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportDialog
        open
        onOpenChange={() => undefined}
        projectId={PROJECT_ID}
        projection={makeProjection("punch-pop")}
        catalogue={makeCatalogue([
          { id: "punch-pop", name: "Punch Pop", assExportable: true },
        ])}
        registry={{} as FontRegistry}
        shaper={{} as Shaper}
        hasVideo={true}
      />,
    );

    await user.click(screen.getByTestId("export-tab-subtitles"));
    expect(screen.getByTestId("export-subtitle-format-ass")).toBeInTheDocument();
  });
});

describe("<SubtitlesTab /> assExportable prop unit tests", () => {
  it("omits the ASS option when assExportable is false", () => {
    renderWithProviders(
      <SubtitlesTab
        value={{ formats: ["srt"], scripts: ["roman"] }}
        onChange={() => undefined}
        disabled={false}
        assExportable={false}
      />,
    );

    expect(screen.queryByTestId("export-subtitle-format-ass")).toBeNull();
    expect(screen.getByTestId("ass-export-unsupported-note")).toBeInTheDocument();
  });

  it("includes the ASS option when assExportable is true", () => {
    renderWithProviders(
      <SubtitlesTab
        value={{ formats: ["srt"], scripts: ["roman"] }}
        onChange={() => undefined}
        disabled={false}
        assExportable={true}
      />,
    );

    expect(screen.getByTestId("export-subtitle-format-ass")).toBeInTheDocument();
  });
});
