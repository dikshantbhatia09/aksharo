import { notFound } from "next/navigation";

import type { Metadata } from "next";

import { AcademyTrackDetail } from "@/components/academy/academy-track-detail";
import { getAcademyTrack } from "@/lib/content/loader";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ trackId: string }>;
}): Promise<Metadata> {
  const { trackId } = await params;
  const track = getAcademyTrack(trackId);
  return { title: track?.title ?? "Academy" };
}

export default async function AcademyTrackPage({
  params,
}: {
  params: Promise<{ trackId: string }>;
}): Promise<React.JSX.Element> {
  const { trackId } = await params;
  const track = getAcademyTrack(trackId);
  if (!track) notFound();
  return <AcademyTrackDetail track={track} />;
}
