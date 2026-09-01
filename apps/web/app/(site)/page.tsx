import { BRAND } from "@montaj/config";

import { Button } from "@/components/ui/button";

/**
 * Marketing home — placeholder. A24 builds the real page (live browser caption
 * demo, features, styles gallery, pricing, plugins, downloads).
 */
export default function HomePage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-24">
      <h1 className="text-4xl font-semibold tracking-tight" data-testid="home-heading">
        {BRAND.name}
      </h1>
      <p className="text-muted-foreground text-lg">
        Caption, cut and reframe your video — in the browser, on the desktop, or inside your NLE.
      </p>
      <p className="text-muted-foreground text-sm">
        Placeholder home page scaffolded by A01. Route groups: <code>(site)</code>,{" "}
        <code>(app)</code>, <code>(share)</code>, <code>(admin)</code>.
      </p>
      <div className="flex gap-3">
        <Button>Get started</Button>
        <Button variant="outline">See how it works</Button>
      </div>
    </main>
  );
}
