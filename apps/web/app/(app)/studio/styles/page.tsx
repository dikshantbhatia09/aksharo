import { StyleGallery } from "@/components/editor/panels/StyleGallery";

/**
 * The style catalogue, drawn by the real renderer.
 *
 * A15 mounts the same `RightPanel` beside the editor canvas and feeds it the
 * workspace catalogue from the API; this page mounts it against the system
 * styles, which is what makes the panel and the preview reviewable before the
 * editor exists.
 */
export default function StylesPage(): React.JSX.Element {
  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-white">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight" data-testid="styles-heading">
        Caption styles
      </h1>
      <StyleGallery />
    </main>
  );
}
