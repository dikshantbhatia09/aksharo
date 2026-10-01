import { ExampleRunViewPage } from "./example-run-view";

/**
 * `/repurpose/example` (2026-10-01, OpusClip's "try a sample project"): the
 * finished run the owner chose, read only, for any signed-in person. A static
 * segment, so Next resolves it before `/repurpose/[runId]`. The route exists
 * whatever is set; the view says so plainly when no example is.
 */
export default function RepurposeExamplePage(): React.JSX.Element {
  return <ExampleRunViewPage />;
}
