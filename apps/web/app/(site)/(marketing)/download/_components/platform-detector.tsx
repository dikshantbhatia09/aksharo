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
      className="border-lime-500/40 bg-lime-500/10 text-fg-0 mx-auto mt-6 max-w-md rounded-full border px-4 py-2 text-center text-sm"
      data-testid="platform-banner"
      data-detected-platform={platform}
    >
      Looks like you are on {build.label} — jump to the {build.label} card below.
    </p>
  );
}
