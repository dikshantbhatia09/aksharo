import { BRAND } from "@montaj/config";
import { Button, Card } from "@montaj/ui";

import { PlatformBanner } from "./_components/platform-detector";

import type { DesktopPlatform } from "@/content/site/download-data";
import type { Metadata } from "next";

import { PLATFORM_BUILDS, PUBLISHER_NAME } from "@/content/site/download-data";
import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";
import { fetchPluginManifest } from "@/lib/plugin-manifest";

export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("desktop");
  return {
    title: "Download",
    description: `Download ${BRAND.name} Desktop for Windows, macOS and Linux.`,
    alternates: { canonical: "/download" },
    openGraph: {
      title: `Download — ${BRAND.name}`,
      description: `${BRAND.name} Desktop for Windows, macOS and Linux.`,
      url: "/download",
      type: "website",
    },
  };
}

/** Which `manifest.desktop.downloadUrl` key a `download-data.ts` platform maps to (Linux has
 * no per-OS key in the manifest yet -- the API's `desktop` schema is win/mac/linux, but no
 * channel manifest publishes a Linux artifact until an AppImage build exists, C10 scope). */
function manifestKeyFor(platform: DesktopPlatform): "win" | "mac" | "linux" | undefined {
  if (platform === "windows") return "win";
  if (platform === "macos") return "mac";
  if (platform === "linux") return "linux";
  return undefined;
}

export default async function DownloadPage(): Promise<React.JSX.Element> {
  assertServerSurfaceEnabled("desktop");
  const manifest = await fetchPluginManifest();
  const desktop = manifest?.desktop;

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <header className="text-center">
        <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight sm:text-5xl">
          {BRAND.name} Desktop
        </h1>
        <p className="text-fg-1 mt-4 text-lg">
          A native local engine for on-device transcription, audio clean and render — for
          zero-upload workflows and offline-friendly projects.
        </p>
        <p className="text-fg-2 mt-2 text-sm">
          Published by <span data-testid="publisher-name">{PUBLISHER_NAME}</span>
        </p>
        {desktop?.available && (
          <p className="text-fg-2 mt-1 text-xs" data-testid="download-version">
            Version {desktop.version} — {desktop.channel} channel
            {desktop.notes ? ` — ${desktop.notes}` : ""}. Checksums:{" "}
            <a className="underline" href="/legal/checksums" data-testid="checksums-link">
              CHECKSUMS.sha256
            </a>
          </p>
        )}
      </header>

      <PlatformBanner />

      <div className="mt-12 grid gap-6 sm:grid-cols-3">
        {PLATFORM_BUILDS.map((build) => {
          const key = manifestKeyFor(build.platform);
          // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
          const href = key ? (desktop?.downloadUrl[key] ?? null) : null;
          return (
            <Card
              key={build.platform}
              id={build.platform}
              className="flex flex-col gap-3"
              data-testid={`download-card-${build.platform}`}
            >
              <h2 className="text-fg-0 text-lg font-semibold">{build.label}</h2>
              <p className="text-fg-2 text-xs">{build.fileNote}</p>
              {href !== null ? (
                <Button asChild variant="primary" data-testid={`download-button-${build.platform}`}>
                  <a href={href}>Download for {build.label}</a>
                </Button>
              ) : (
                <p
                  className="border-border text-fg-2 rounded-md border px-3 py-2 text-xs"
                  data-testid={`download-placeholder-${build.platform}`}
                >
                  Download link placeholder — the signed installer ships with C10.
                </p>
              )}
              <div>
                <h3 className="text-fg-0 text-sm font-medium">{build.firstRunTitle}</h3>
                <ol className="text-fg-1 mt-2 flex list-decimal flex-col gap-1.5 pl-4 text-xs">
                  {build.firstRunSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <p
                  className="text-fg-2 mt-3 text-xs italic"
                  data-testid={`download-screenshot-placeholder-${build.platform}`}
                >
                  Screenshot placeholder — first-run dialog capture pending a signed build.
                </p>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
