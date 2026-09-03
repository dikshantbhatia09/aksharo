import { cpus, totalmem } from "node:os";

import { detectBackend, type DetectionResult, type SystemInfo } from "../src/detection.js";

/**
 * The machine profile the report is filed under (brief scope item 3: "the
 * harness records the machine profile ... and the tier C03a computed;
 * mismatches flagged"). Reuses `detectBackend` from `../src/detection.ts`
 * (C03a, read-only from this bench harness) rather than re-deriving the tier
 * table — the same function `apps/engine/src/main.ts` calls for `/health`, so
 * a mismatch here is a real signal, not a second implementation drifting from
 * the first.
 */
export interface MachineProfile {
  readonly platform: NodeJS.Platform;
  readonly cores: number;
  readonly ramGb: number;
  readonly detection: DetectionResult;
  /** A short, filename-safe label for the report path, e.g. `win32-8c-16gb-vulkan`. */
  readonly slug: string;
}

export function currentMachineProfile(overrides: Partial<SystemInfo> = {}): MachineProfile {
  const info: SystemInfo = {
    platform: process.platform,
    cores: cpus().length,
    ramGb: totalmem() / 1024 ** 3,
    hasMetal: process.platform === "darwin",
    ...overrides,
  };
  const detection = detectBackend(info);
  const ramGbRounded = Math.round(info.ramGb);
  const slug = `${info.platform}-${String(info.cores)}c-${String(ramGbRounded)}gb-${detection.backend}`;
  return { platform: info.platform, cores: info.cores, ramGb: info.ramGb, detection, slug };
}
