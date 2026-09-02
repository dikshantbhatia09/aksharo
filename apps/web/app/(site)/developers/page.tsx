import { DevelopersDocs } from "./developers-docs";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API docs",
  description: "The Aksharo public API: projects, transcripts, exports, jobs and webhooks.",
};

export default function DevelopersDocsPage(): React.JSX.Element {
  return <DevelopersDocs />;
}
