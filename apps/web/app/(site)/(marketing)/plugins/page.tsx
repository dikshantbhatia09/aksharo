import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Button, Card } from "@montaj/ui";

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
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <header className="mx-auto max-w-3xl text-center">
        <h1 className="font-display text-fg-0 text-4xl font-semibold tracking-tight sm:text-5xl">
          The same brain, inside your timeline
        </h1>
        <p className="text-fg-1 mt-4 text-lg">
          No export, no import loop — your transcript, styles and edit passes land as real, editable
          items in the timeline you already work in.
        </p>
      </header>

      <div className="mt-14 grid gap-6 lg:grid-cols-2">
        {HOST_SURFACES.map((surface) => {
          const channel: PluginManifestChannelView | undefined =
            manifest?.channels[manifestChannelFor(surface.id)];
          return (
            <Card
              key={surface.id}
              className="flex flex-col gap-4"
              data-testid={`plugin-card-${surface.id}`}
            >
              <h2 className="text-fg-0 text-xl font-semibold">{surface.productName}</h2>
              <p className="text-fg-1 text-sm leading-relaxed">{surface.summary}</p>
              <dl className="text-fg-2 flex flex-col gap-1 text-xs">
                <div>
                  <dt className="inline font-medium">Minimum host version: </dt>
                  <dd className="inline">{surface.minimumHostVersion}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Install: </dt>
                  <dd className="inline">{surface.installNote}</dd>
                </div>
              </dl>
              <div>
                <h3 className="text-fg-0 text-sm font-medium">Honest capability notes</h3>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {surface.capabilityNotes.map((note) => (
                    <li key={note} className="text-fg-2 text-xs leading-relaxed">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
              {channel?.available && channel.downloadUrl !== null ? (
                <div className="flex flex-col gap-1">
                  <Button asChild variant="primary" data-testid={`plugin-download-${surface.id}`}>
                    <a href={channel.downloadUrl}>Download v{channel.version}</a>
                  </Button>
                  <p
                    className="text-fg-2 text-xs"
                    data-testid={`plugin-checksum-note-${surface.id}`}
                  >
                    {channel.channel} channel. Verify against{" "}
                    <a className="underline" href="/legal/checksums">
                      CHECKSUMS.sha256
                    </a>
                    .
                  </p>
                </div>
              ) : (
                <p
                  className="text-fg-2 border-border rounded-md border px-3 py-2 text-xs"
                  data-testid={`plugin-download-placeholder-${surface.id}`}
                >
                  Download link placeholder — the signed, distributable build ships with C10.
                </p>
              )}
            </Card>
          );
        })}
      </div>

      <section className="mt-20" aria-labelledby="activation-heading">
        <h2 id="activation-heading" className="font-display text-fg-0 text-2xl font-semibold">
          Three steps to your first caption
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {ACTIVATION_STEPS.map((step) => (
            <div key={step.step} data-testid={`activation-step-${step.step}`}>
              <span className="text-lime-500 font-mono text-2xl">{step.step}</span>
              <h3 className="text-fg-0 mt-2 font-semibold">{step.title}</h3>
              <p className="text-fg-1 mt-2 text-sm leading-relaxed">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-16 flex justify-center">
        <Button variant="primary" size="lg" asChild>
          <Link href={AUTH_NAV.getStarted.href}>Start free — one clean export on us</Link>
        </Button>
      </div>

      <p className="text-fg-2 mt-16 max-w-3xl text-xs" data-testid="plugins-attribution">
        {ATTRIBUTION_LINE}
      </p>
    </div>
  );
}
