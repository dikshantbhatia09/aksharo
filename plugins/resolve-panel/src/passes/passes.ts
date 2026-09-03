/**
 * `passes.list` (brief item 1: "Passes review summary with 'Apply in Resolve'"). Fetches the
 * loopback server's proxy of `GET /projects/{id}/edg/passes`
 * (`plugins/resolve/aksharo_core_app/passes.py`) verbatim — this module only types the shape
 * the panel renders, matching the API's `PassSummaryListDto`.
 */
import type { ResolveRpcClient } from "../rpc/client.js";

export interface PassItemSummary {
  readonly itemId: string;
  readonly kind: string;
  readonly state: string;
}

export interface PassSummary {
  readonly passId: string;
  readonly type: string;
  readonly items: readonly PassItemSummary[];
}

export interface PassesListResult {
  readonly passes: readonly PassSummary[];
}

export async function fetchPasses(client: ResolveRpcClient): Promise<PassesListResult> {
  return client.call<PassesListResult>("passes.list", {});
}

/** Accepted item ids across every pass — what "Apply in Resolve" sends to `runApply`. */
export function acceptedItemIds(result: PassesListResult): string[] {
  return result.passes.flatMap((pass) =>
    pass.items.filter((item) => item.state === "accepted").map((item) => item.itemId),
  );
}
