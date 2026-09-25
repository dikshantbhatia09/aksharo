import { TriangleAlert } from "lucide-react";

import { DRAFT_BANNER } from "@/content/site/legal";

/** The "draft — pending counsel" banner every legal page carries (D66, A00-13). */
export function LegalDraftBanner(): React.JSX.Element {
  return (
    <div
      role="note"
      className="border-warning/40 bg-warning/10 text-fg-0 flex gap-3 rounded-md border px-4 py-3 text-sm"
      data-testid="legal-draft-banner"
    >
      {/* A warning signal (not decoration): the icon and the bold lead carry the
          meaning alongside the hue. */}
      <TriangleAlert
        aria-hidden="true"
        className="text-warning mt-0.5 size-4 shrink-0"
        strokeWidth={1.75}
      />
      <p>
        <strong className="font-semibold">Draft — pending counsel review.</strong>{" "}
        {DRAFT_BANNER.replace("Draft — pending counsel review. ", "")}
      </p>
    </div>
  );
}
