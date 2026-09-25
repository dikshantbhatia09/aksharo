"use client";

import { useEffect, useState } from "react";

import {
  detectPlatform,
  PLATFORM_BUILDS,
  type DesktopPlatform,
} from "@/content/site/download-data";

export function usePlatform(): DesktopPlatform {
  const [platform, setPlatform] = useState<DesktopPlatform>("unknown");

  useEffect(() => {
    setPlatform(detectPlatform(window.navigator.userAgent));
  }, []);

  return platform;
}

/** A quick "we think you are on X" banner, pointing at the matching card below. */
export function PlatformBanner(): React.JSX.Element | null {
  const platform = usePlatform();
  const build = PLATFORM_BUILDS.find((entry) => entry.platform === platform);
  if (build === undefined) return null;

  return (
    <p
      className="border-border bg-surface text-fg-1 mt-6 inline-flex rounded-md border px-4 py-2 text-sm"
      data-testid="platform-banner"
      data-detected-platform={platform}
    >
      <span>
        Looks like you are on {build.label} — jump to the{" "}
        <a href={`#${build.platform}`}>{build.label} card below</a>.
      </span>
    </p>
  );
}
