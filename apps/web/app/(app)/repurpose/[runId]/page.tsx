import { RepurposeRunView } from "./repurpose-run-view";

/**
 * `/repurpose/[runId]` (REP-007) — the resumable workspace. The run id is in the
 * URL precisely so that a refresh, a new tab or a bookmark all resume the same
 * run rather than restarting it.
 */
export default async function RepurposeRunPage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>;
}): Promise<React.JSX.Element> {
  const { runId } = await params;
  return <RepurposeRunView runId={runId} />;
}
