import type { Metadata } from "next";

import { ShowNotesView } from "@/components/projects/show-notes-view";

export const metadata: Metadata = {
  title: "Show Notes & Timestamps | Aksharo",
  description: "AI-generated show notes, executive summaries, and interactive YouTube timestamps.",
};

export default async function ProjectShowNotesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return <ShowNotesView projectId={id} />;
}

