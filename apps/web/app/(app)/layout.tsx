import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";

/**
 * Everything signed in lives inside the shell (08 §3). `middleware.ts` has
 * already turned away a request with no session cookie, so this layout can
 * assume there is one and get on with rendering.
 */
export default function AppLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <AppShell>{children}</AppShell>;
}
