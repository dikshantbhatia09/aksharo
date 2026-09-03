/**
 * Local-mode gating (brief C04 §4): "the `localMode` entitlement (Starter+)
 * checked in the desktop before enabling."
 *
 * The desktop shell never resolves a workspace entitlement itself — the
 * hosted web app already does that (`apps/api/src/workspaces/
 * entitlement.service.ts`) and is the one signed-in session running in
 * `mainWindow`. This module is the seam the web app's plan tier is handed
 * across at (`desktop:local-set-plan`, `src/main/index.ts`), and the pure
 * predicate every local IPC handler is guarded by. Fails closed: until the
 * web app has reported a plan, local mode stays disabled (`plan === null`),
 * never "enabled until told otherwise".
 */
import { hasLocalMode, type PlanTier } from "@montaj/config";

export function createLocalModeGate(initial: PlanTier | null = null): {
  currentPlan(): PlanTier | null;
  setPlan(plan: PlanTier): void;
  isEnabled(): boolean;
} {
  let plan = initial;
  return {
    currentPlan: () => plan,
    setPlan: (value: PlanTier) => {
      plan = value;
    },
    isEnabled: () => plan !== null && hasLocalMode(plan),
  };
}
