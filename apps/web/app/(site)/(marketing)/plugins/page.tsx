import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Button, Card, PageHeader } from "@montaj/ui";

import type { Metadata } from "next";

import { assertServerSurfaceEnabled } from "@/content/site/launch-surfaces";
import { AUTH_NAV } from "@/content/site/nav";
import { ACTIVATION_STEPS, ATTRIBUTION_LINE, HOST_SURFACES } from "@/content/site/plugins-data";
import { fetchPluginManifest, type PluginManifestChannelView } from "@/lib/plugin-manifest";

/** `HOST_SURFACES`' ids -> the `/plugins/manifest` channel each surface's install button
 * reads from. "premiere-ae" reads the Premiere UXP channel (the same `.ccx` this card's
 * "Install" step already describes as the primary install path for that surface). */
function manifestChannelFor(surfaceId: string): "premiere-uxp" | "ae-cep" | "resolve-script" {
  return surfaceId === "resolve" ? "resolve-script" : "premiere-uxp";
}

export function generateMetadata(): Metadata {
  assertServerSurfaceEnabled("plugins");
  return {
    title: "Plugins",
    description:
      "Aksharo Panel — works with Adobe Premiere Pro and Adobe After Effects. Aksharo — works with DaVinci Resolve. One credit pool, real timeline items, no per-plugin subscription.",
    alternates: { canonical: "/plugins" },
    openGraph: {
      title: `Plugins — ${BRAND.name}`,
      description: "Aksharo Panel for Premiere Pro and After Effects; Aksharo for DaVinci Resolve.",
      url: "/plugins",
      type: "website",
    },
  };
}

export default async function PluginsPage(): Promise<React.JSX.Element> {
  assertServerSurfaceEnabled("plugins");
  const manifest = await fetchPluginManifest();

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        size="lg"
        title="The same brain, inside your timeline"
        description="No export, no import loop — your transcript, styles and edit passes land as real, editable items in the timeline you already work in."
      />

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        {HOST_SURFACES.map((surface) => {
          const channel: PluginManifestChannelView | undefined =
            manifest?.channels[manifestChannelFor(surface.id)];
          return (
            <Card
              key={surface.id}
              className="flex flex-col gap-4"
              data-testid={`plugin-card-${surface.id}`}
            >
              <h2 className="text-fg-0 text-xl">{surface.productName}</h2>
              <p className="text-fg-1 text-sm leading-relaxed">{surface.summary}</p>
              <dl className="border-border grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-y py-3 text-sm">
                <dt className="text-fg-2">Minimum host version</dt>
                <dd className="text-fg-1">{surface.minimumHostVersion}</dd>
                <dt className="text-fg-2">Install</dt>
                <dd className="text-fg-1">{surface.installNote}</dd>
              </dl>
              <div>
                <h3 className="text-fg-0 text-sm font-medium">Honest capability notes</h3>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {surface.capabilityNotes.map((note) => (
                    <li key={note} className="text-fg-2 text-sm leading-relaxed">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
              {channel?.available && channel.downloadUrl !== null ? (
                <div className="flex flex-col gap-1">
                  <Button asChild variant="secondary" data-testid={`plugin-download-${surface.id}`}>
                    <a href={channel.downloadUrl}>Download v{channel.version}</a>
                  </Button>
                  <p
                    className="text-fg-2 text-xs"
                    data-testid={`plugin-checksum-note-${surface.id}`}
                  >
                    {channel.channel} channel. Verify against{" "}
                    <a href="/legal/checksums">CHECKSUMS.sha256</a>.
                  </p>
                </div>
              ) : (
                <p
                  className="text-fg-2 border-border rounded-sm border border-dashed px-3 py-2 text-sm"
                  data-testid={`plugin-download-placeholder-${surface.id}`}
                >
                  Not available yet.
                </p>
              )}
            </Card>
          );
        })}
      </div>

      <section className="mt-20" aria-labelledby="activation-heading">
        <h2 id="activation-heading" className="text-fg-0 text-xl">
          Three steps to your first caption
        </h2>
        <ol className="mt-6 grid list-none gap-4 p-0 sm:grid-cols-3">
          {ACTIVATION_STEPS.map((step) => (
            <li
              key={step.step}
              className="border-border bg-surface rounded-md border p-5"
              data-testid={`activation-step-${step.step}`}
            >
              <span className="text-fg-2 font-mono text-xs" aria-hidden="true">
                {step.step}
              </span>
              <h3 className="text-fg-0 mt-2 text-base">{step.title}</h3>
              <p className="text-fg-1 mt-2 text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* The page's one filled primary: plugin downloads are secondary so they
          do not compete with it or with each other. */}
      <div className="mt-12">
        <Button variant="primary" size="lg" asChild>
          <Link href={AUTH_NAV.getStarted.href}>Start free — one clean export on us</Link>
        </Button>
      </div>

      <p className="text-fg-2 mt-12 max-w-3xl text-xs" data-testid="plugins-attribution">
        {ATTRIBUTION_LINE}
      </p>
    </div>
  );
}
