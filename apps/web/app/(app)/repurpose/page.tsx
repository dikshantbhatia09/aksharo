import { RepurposeIndexView } from "./repurpose-index-view";

/**
 * `/repurpose` — where the rail's "Clips pipeline" entry lands.
 *
 * The route exists whatever the flag says; the view renders an explanation
 * rather than a broken screen when `repurpose_flow` is off for the workspace,
 * because every API route behind it answers 404 in that case.
 */
export default function RepurposePage(): React.JSX.Element {
  return <RepurposeIndexView />;
}
