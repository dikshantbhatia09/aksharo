import { RepurposeNewView } from "./repurpose-new-view";

/**
 * `/repurpose/new` (REP-008). The route exists whatever the flag says; the API
 * answers 404 while `repurpose_flow` is off, and the form surfaces that as
 * "not available" rather than an error — one gate, server-side, not two.
 */
export default function RepurposeNewPage(): React.JSX.Element {
  return <RepurposeNewView />;
}
