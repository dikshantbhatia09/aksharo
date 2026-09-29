import { AutomationsView } from "./automations-view";

/**
 * `/repurpose/automations` (2026-10-02): channel automations. The route exists
 * whatever the flags say; the view explains itself rather than showing a broken
 * screen when `repurpose_automations` is off, because every API route behind it
 * answers 404 then.
 */
export default function AutomationsPage(): React.JSX.Element {
  return <AutomationsView />;
}
