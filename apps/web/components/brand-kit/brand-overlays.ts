/**
 * The brand kit's overlays as the editor puts them back on a clip (2026-10-02):
 * a person who took the logo or the end card off an Autopilot clip, or wants
 * one on a clip made without the kit, turns it on from the Look tab. Built
 * from the workspace's kit as it is now, by the same builders Autopilot uses.
 */
import {
  brandEndCardOverlay,
  brandLogoOverlay,
  type BrandKitSettings,
  type EndCardOverlay,
  type LogoOverlay,
  type OverlayImage,
  type PassItem,
} from "@montaj/edg";
import { fromAcceptedItems } from "@montaj/timemap";

/**
 * The last `tailMs` of the video as it plays after `items`' accepted cuts, on
 * the source clock; the whole video when it is shorter than that.
 */
export function endCardTail(
  items: readonly PassItem[],
  sourceDurationMs: number,
  tailMs: number,
): { readonly startMs: number; readonly endMs: number } | undefined {
  if (sourceDurationMs <= 0 || tailMs <= 0) return undefined;
  const timeMap = fromAcceptedItems(items, { sourceDurationMs });
  const outputEnd = timeMap.outputDurationMs;
  if (outputEnd <= 0) return undefined;
  const startMs = Math.max(0, Math.round(timeMap.toSource(Math.max(0, outputEnd - tailMs))));
  return startMs < sourceDurationMs ? { startMs, endMs: sourceDurationMs } : undefined;
}

/**
 * The logo in its corner for the whole clip, as the kit places it; `undefined`
 * when the kit has no logo. Turned on by hand, it shows whatever the kit's own
 * "show in a corner" says.
 */
export function editorLogoOverlay(
  settings: BrandKitSettings,
  logo: OverlayImage | undefined,
  id: string,
  durationMs: number,
): LogoOverlay | undefined {
  return brandLogoOverlay({ ...settings, logo: { ...settings.logo, show: true } }, logo, id, {
    startMs: 0,
    endMs: durationMs,
  });
}

/**
 * The kit's end card over the clip's last seconds; `undefined` when it would
 * show nothing (no call to action, handle or logo). Turned on by hand, it
 * shows whether or not the kit adds one to new clips.
 */
export function editorEndCardOverlay(
  settings: BrandKitSettings,
  logo: OverlayImage | undefined,
  id: string,
  items: readonly PassItem[],
  durationMs: number,
): EndCardOverlay | undefined {
  const window = endCardTail(items, durationMs, settings.endCard.durationMs);
  if (window === undefined) return undefined;
  return brandEndCardOverlay(
    { ...settings, endCard: { ...settings.endCard, enabled: true } },
    logo,
    id,
    window,
  );
}
