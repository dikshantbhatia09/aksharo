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
  return <EditorClient projectId={id} />;
}
