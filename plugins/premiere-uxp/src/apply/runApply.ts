/**
 * Transactions + progress (C06 brief §Scope 6): every apply runs inside one
 * `PremiereHost#transaction` (real adapter: `Project#executeTransaction`), reporting
 * `apply.begin`/`apply.step`/`apply.commit`/`apply.abort` to the bridge so the web studio (or a
 * desktop shell) can show progress and offer cancellation. A thrown step rolls the whole
 * transaction back (host-level) and reports `apply.abort` (bridge-level) with the reason.
 *
 * "Dry-run preview count" (brief §Scope 8, panel UI): `planApply` alone — no host or bridge
 * calls — returns how many items each selected mode would touch, for the checkbox list's count
 * badges before the user commits to an apply.
 */
import type { ApplyMode, EdgPassItemLike, EdgSegmentLike } from "./types.js";
import type { BridgeClient } from "../bridge/client.js";
import type { PremiereHost } from "../host/premiere.js";

export interface ApplyPlanInput {
  readonly segments: readonly EdgSegmentLike[];
  readonly items: readonly EdgPassItemLike[];
  readonly alphaOverlayCount: number;
  readonly hasCleanedAudio: boolean;
}

/** One count per selectable mode, for the panel's dry-run preview badges. */
export type ApplyPlanCounts = Readonly<Record<ApplyMode, number>>;

export function planApply(input: ApplyPlanInput): ApplyPlanCounts {
  const visibleSegments = input.segments.filter((s) => !s.hidden).length;
  const acceptedOf = (kind: EdgPassItemLike["kind"]): number =>
    input.items.filter((item) => item.kind === kind && item.state === "accepted").length;
  return {
    transcript: visibleSegments,
    mogrtCaptions: visibleSegments,
    alphaOverlay: input.alphaOverlayCount,
    srtToBin: visibleSegments > 0 ? 1 : 0,
    cuts: acceptedOf("cut"),
    zooms: acceptedOf("zoom"),
    audio: input.hasCleanedAudio ? 1 : 0,
    // D09: accepted sfx/music items (regardless of licence — a refused item still counts here so
    // the panel can show "3 selected, 1 cloud-render-only" rather than silently under-counting)
    // and accepted title items (CONTRACTS §2 amendment: text-fx rides the `title` kind).
    sfxMusic: acceptedOf("sfx") + acceptedOf("music"),
    titles: acceptedOf("title"),
  };
}

export interface RunApplyInput {
  readonly projectId: string;
  readonly modes: readonly ApplyMode[];
  readonly itemIds: readonly string[];
  /** Runs the actual host mutations for the selected modes; thrown errors abort + roll back. */
  step: (mode: ApplyMode, index: number) => Promise<void>;
}

export interface RunApplyResult {
  readonly transactionId: string;
  readonly appliedSteps: number;
}

/**
 * Wraps `input.step` for every selected mode in one `host.transaction`, reporting
 * `apply.begin`/`apply.step`/`apply.commit` (success) or `apply.abort` (failure) to the bridge.
 */
export async function runApply(
  host: PremiereHost,
  bridge: BridgeClient,
  input: RunApplyInput,
): Promise<RunApplyResult> {
  const { transactionId } = await bridge.call("apply.begin", {
    projectId: input.projectId,
    hostApp: "premiere",
    itemIds: [...input.itemIds],
  });

  try {
    await host.transaction(`apply:${transactionId}`, async () => {
      for (let i = 0; i < input.modes.length; i += 1) {
        // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
        const mode = input.modes[i];
        if (mode === undefined) continue;
        await input.step(mode, i);
        const { accepted } = await bridge.call("apply.step", {
          transactionId,
          step: i,
          payload: { mode },
        });
        if (!accepted) {
          throw new Error(`apply.step rejected for mode "${mode}" (step ${i})`);
        }
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await bridge.call("apply.abort", { transactionId, reason });
    throw error;
  }

  const commitResult = await bridge.call("apply.commit", { transactionId });
  return { transactionId, appliedSteps: commitResult.appliedSteps };
}
