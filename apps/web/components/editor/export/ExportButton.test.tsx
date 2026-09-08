import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";

import { ExportButton } from "./ExportButton";

import { renderWithProviders } from "@/test/harness";

/**
 * Issue #6 ("Export button does nothing"): the toolbar button is
 * `ExportButton`, not `ExportDialog` directly — every other test in this
 * directory mounts the dialog already `open`, which would miss a regression
 * in the button's own click-to-open wiring. This closes that gap.
 */
describe("<ExportButton />", () => {
  it("opens the dialog on click when a primary media id is present", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ExportButton
        projectId="01JCPR0JECT000000000000000"
        primaryMediaId="01JCMEDIA00000000000000000"
        projection={{} as EdgProjection}
        catalogue={new Map()}
        registry={{} as FontRegistry}
        shaper={{} as Shaper}
      />,
    );

    expect(screen.queryByTestId("export-dialog")).toBeNull();
    await user.click(screen.getByTestId("editor-export-open"));
    expect(screen.getByTestId("export-dialog")).toBeInTheDocument();
  });

  it("stays disabled with no primary media, so the dialog never opens", () => {
    renderWithProviders(
      <ExportButton
        projectId="01JCPR0JECT000000000000000"
        primaryMediaId={undefined}
        projection={{} as EdgProjection}
        catalogue={new Map()}
        registry={{} as FontRegistry}
        shaper={{} as Shaper}
      />,
    );

    expect(screen.getByTestId("editor-export-open")).toBeDisabled();
  });
});
