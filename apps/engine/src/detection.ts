import type { EngineBackendKind, LatencyTier } from "@montaj/engine-client";

/**
 * Backend and latency-tier detection (brief §2; `05-system-architecture.md`
 * §7: "Local latency tiers (5-minute clip): A Apple Silicon ≥16GB ≤60s · B
 * Windows ≥8 cores/16GB + GPU ≤90s · C 4-8 cores/8GB, small model ≤120s ·
 * D <8GB local disabled"). Pure function of an injected `SystemInfo` so tests
 * can exercise every branch without touching real hardware — the brief's own
 * "Reality" section: this host has no GPU toolchain guarantee, so detection
 * must be provably correct from data, not from actually finding a GPU here.
 */

export interface SystemInfo {
  readonly platform: NodeJS.Platform;
  readonly cores: number;
  readonly ramGb: number;
  /** Apple Silicon only: whether the installed CoreML model exists on disk. */
  readonly coreMlModelPresent?: boolean;
  /** macOS only: Metal-capable GPU (true for every Apple Silicon Mac). */
  readonly hasMetal?: boolean;
  /** Windows/Linux: a Vulkan-capable GPU driver was found. */
  readonly hasVulkan?: boolean;
  /** Windows/Linux: `nvidia-smi` reported a CUDA-capable device. */
  readonly hasCuda?: boolean;
}

export interface DetectionResult {
  readonly backend: EngineBackendKind;
  readonly tier: LatencyTier;
  readonly tierReason: string;
}

/**
 * macOS -> Metal+CoreML when the CoreML model exists, else Metal alone (still
 * reported as `metal-coreml` since whisper.cpp's Metal path is always used on
 * Apple Silicon; the CoreML *encoder* is the optional speed-up). Windows/Linux
 * -> Vulkan default, CUDA pack when both a CUDA device is reported and the
 * pack is present (approximated here by `hasCuda`, since the pack presence is
 * a model-manager concern the caller resolves before calling this). CPU is the
 * universal fallback.
 */
export function detectBackend(info: SystemInfo): DetectionResult {
  const tier = detectTier(info);
  if (info.platform === "darwin" && info.hasMetal === true) {
    return { backend: "metal-coreml", tier: tier.tier, tierReason: tier.reason };
  }
  if (info.hasCuda === true) {
    return { backend: "cuda", tier: tier.tier, tierReason: tier.reason };
  }
  if (info.hasVulkan === true) {
    return { backend: "vulkan", tier: tier.tier, tierReason: tier.reason };
  }
  return { backend: "cpu", tier: tier.tier, tierReason: tier.reason };
}

function detectTier(info: SystemInfo): { tier: LatencyTier; reason: string } {
  if (info.ramGb < 8) {
    return { tier: "D", reason: "under 8 GB RAM: local engine disabled, cloud with banner" };
  }
  if (info.platform === "darwin" && info.hasMetal === true && info.ramGb >= 16) {
    return { tier: "A", reason: "Apple Silicon, >=16GB RAM" };
  }
  const hasGpu = info.hasVulkan === true || info.hasCuda === true;
  if (info.platform === "win32" && info.cores >= 8 && info.ramGb >= 16 && hasGpu) {
    return { tier: "B", reason: ">=8 cores, >=16GB RAM, GPU present" };
  }
  if (info.cores >= 4 && info.ramGb >= 8) {
    return { tier: "C", reason: "4-8 cores/8GB: small model" };
  }
  return { tier: "D", reason: "below the C floor (4 cores/8GB): local engine disabled" };
}
