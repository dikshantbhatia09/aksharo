import { TeamView } from "./team-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Team" };

export default function TeamPage(): React.JSX.Element {
  return <TeamView />;
}
