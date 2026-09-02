import { MemoryView } from "./memory-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "What Aksharo learned" };

export default function MemorySettingsPage(): React.JSX.Element {
  return <MemoryView />;
}
