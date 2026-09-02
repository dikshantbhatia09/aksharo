import { EditorClient } from "./editor-client";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Editor" };

/**
 * `/p/{id}` — the editor route (08 §4). A thin server wrapper: `AppLayout`
 * (`app/(app)/layout.tsx`) has already turned away a signed-out visitor, so
 * this only unwraps Next 15's async `params` and hands the project id to the
 * client component that owns the store, the three-column layout and every
 * network call.
 */
export default async function EditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  // D82: Deep clean (DeepFilterNet, cloud) is greyed out with "coming to
  // cloud renders" copy until the worker-ai image build provisions the model
  // weights (X07). Read server-side rather than a `NEXT_PUBLIC_` var — the
  // flag is deployment-wide, not something the client bundle needs to inline.
  const deepCleanEnabled = process.env["AUDIO_DEEP_CLEAN_ENABLED"] === "1";
  return <EditorClient projectId={id} deepCleanEnabled={deepCleanEnabled} />;
}
