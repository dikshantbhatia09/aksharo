/**
 * Download page data (A24 brief: "platform detection, SmartScreen/Gatekeeper
 * first-run notes with screenshots placeholders, publisher name field from
 * brand config").
 *
 * No installer exists yet, so every download link is
 * a clearly labelled placeholder rather than a dead link to a file that isn't
 * there.
 */

import { BRAND } from "@montaj/config";

export type DesktopPlatform = "windows" | "macos" | "linux" | "unknown";

export interface PlatformBuild {
  readonly platform: DesktopPlatform;
  readonly label: string;
  readonly fileNote: string;
  readonly firstRunTitle: string;
  readonly firstRunSteps: readonly string[];
}

/** The name a first-run OS prompt (SmartScreen, Gatekeeper) shows as the publisher. */
export const PUBLISHER_NAME = `${BRAND.name} Technologies`;

export const PLATFORM_BUILDS: readonly PlatformBuild[] = [
  {
    platform: "windows",
    label: "Windows",
    fileNote: "Signed .exe installer (in preview) — 64-bit, Windows 10 and later.",
    firstRunTitle: "The first time you run it: Windows SmartScreen",
    firstRunSteps: [
      `Windows may show "Windows protected your PC" the first time — this is normal for a newly released installer.`,
      `Click "More info", then confirm the publisher reads "${PUBLISHER_NAME}".`,
      `Click "Run anyway" to continue installing.`,
    ],
  },
  {
    platform: "macos",
    label: "macOS",
    fileNote: "Notarised .dmg (in preview) — Apple Silicon and Intel.",
    firstRunTitle: "The first time you run it: Gatekeeper",
    firstRunSteps: [
      `macOS may show "Apple could not verify [app] is free of malware" on a very first run before notarisation propagates.`,
      'Open System Settings → Privacy & Security, and click "Open Anyway" next to the Aksharo message.',
      "Confirm in the dialog that follows; this is a one-time step.",
    ],
  },
  {
    platform: "linux",
    label: "Linux",
    fileNote: "AppImage (in preview) — for the local bridge and local-mode features.",
    firstRunTitle: "The first time you run it",
    firstRunSteps: [
      "Mark the AppImage executable (`chmod +x`) and run it directly, or through your distribution's AppImage integration.",
    ],
  },
];

export function detectPlatform(userAgent: string): DesktopPlatform {
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  if (ua.includes("linux") && !ua.includes("android")) return "linux";
  return "unknown";
}

export function platformBuild(platform: DesktopPlatform): PlatformBuild | undefined {
  return PLATFORM_BUILDS.find((entry) => entry.platform === platform);
}
