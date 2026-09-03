/**
 * "Apply in Resolve" (brief item 1): drives the loopback server's `apply.begin`/`apply.step`/
 * `apply.commit`/`apply.abort` methods (`plugins/resolve/aksharo_core_app/server.py`'s
 * `register`, wired by the script to `cuts.py`/`zooms.py`/`captions.py`). Unlike C05a's
 * `runApply.ts`, this panel does not itself run a host transaction — the script already runs
 * inside Resolve and does the actual timeline mutation per step; this module only drives the
 * transaction state machine and aborts on the first rejected/failed step.
 */
import type { ResolveRpcClient } from "../rpc/client.js";

export interface RunApplyInput {
  readonly projectId: string;
  readonly itemIds: readonly string[];
}

export interface RunApplyResult {
  readonly transactionId: string;
  readonly appliedSteps: number;
}

export async function runApply(
  client: ResolveRpcClient,
  input: RunApplyInput,
): Promise<RunApplyResult> {
  const { transactionId } = await client.call<{ transactionId: string }>("apply.begin", {
    projectId: input.projectId,
    hostApp: "resolve",
    itemIds: [...input.itemIds],
  });

  try {
    for (let i = 0; i < input.itemIds.length; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const itemId = input.itemIds[i];
      const { accepted } = await client.call<{ accepted: boolean }>("apply.step", {
        transactionId,
        step: i,
        payload: { itemId },
      });
      if (!accepted) {
        throw new Error(`apply.step rejected for item "${itemId}" (step ${i})`);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await client.call("apply.abort", { transactionId, reason });
    throw error;
  }

  const commitResult = await client.call<{ appliedSteps: number }>("apply.commit", {
    transactionId,
  });
  return { transactionId, appliedSteps: commitResult.appliedSteps };
}
