import type { Metadata } from "next";

import { AcademyTrackList } from "@/components/academy/academy-track-list";
import { loadAcademyTracks } from "@/lib/content/loader";


export const metadata: Metadata = { title: "Academy" };

/**
 * `/academy` — the outcome-based tracks list (brief §1). Content (title,
 * outcome, steps) is read server-side from MDX at request time; live
 * progress per track is fetched client-side from `GET /academy/progress`
 * (per-workspace, per-user).
 */
export default function AcademyPage(): React.JSX.Element {
  const tracks = loadAcademyTracks();
  return <AcademyTrackList tracks={tracks} />;
}
