import { DRAFT_BANNER } from "@/content/site/legal";

/** The "draft — pending counsel" banner every legal page carries (D66, A00-13). */
export function LegalDraftBanner(): React.JSX.Element {
  return (
    <div
      role="note"
      className="border-warning/40 bg-warning/10 text-fg-0 rounded-md border px-4 py-3 text-sm"
      data-testid="legal-draft-banner"
    >
      <strong className="font-semibold">Draft — pending counsel review.</strong>{" "}
      {DRAFT_BANNER.replace("Draft — pending counsel review. ", "")}
    </div>
  );
}
