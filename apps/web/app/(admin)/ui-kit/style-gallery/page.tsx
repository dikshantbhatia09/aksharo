import type { Metadata } from "next";

import { StyleGallery } from "@/components/editor/panels/StyleGallery";


export const metadata: Metadata = { title: "Style gallery — UI kit" };

/**
 * The right-hand panel's working harness: pick a style, change its colours,
 * look and animation, and watch the ops the editor would send.
 *
 * It used to be the whole of `/studio/styles`, which meant a signed-in user
 * reaching "Styles" from the rail got a developer tool with a JSON op log
 * beside it. `/studio/styles` is now the catalogue the premium canvas
 * specifies; the harness lives here with the rest of the UI kit, where a
 * review page belongs, and `e2e/style-preview.spec.ts` drives it here.
 */
export default function StyleGalleryUiKitPage(): React.JSX.Element {
  return (
    <main className="min-h-dvh p-6">
      <h1 className="font-display mb-4 text-2xl tracking-tight" data-testid="styles-heading">
        Style gallery harness
      </h1>
      <StyleGallery />
    </main>
  );
}
