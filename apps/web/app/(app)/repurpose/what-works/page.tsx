import { WhatWorksView } from "./what-works-view";

/**
 * `/repurpose/what-works` (2026-10-05): which posted clips did best, and what
 * they share. The route exists whatever the flags say; the view explains
 * itself when `repurpose_performance` is off, because every API route behind
 * it answers 404 then.
 */
export default function WhatWorksPage(): React.JSX.Element {
  return <WhatWorksView />;
}
