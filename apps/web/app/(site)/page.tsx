import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Button } from "@montaj/ui";

/**
 * Marketing home — placeholder. A24 builds the real page (live browser caption
 * demo, features, styles gallery, pricing, plugins, downloads). A13 only moved
 * it onto the real design tokens and pointed the two calls to action at the auth
 * pages it now owns.
 */
export default function HomePage(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-24">
      <h1 className="font-display text-4xl font-semibold tracking-tight" data-testid="home-heading">
        {BRAND.name}
      </h1>
      <p className="text-fg-1 text-lg">
        Caption, cut and reframe your video — in the browser, on the desktop, or inside your NLE.
      </p>
      <p className="text-fg-2 text-sm">
        Placeholder home page scaffolded by A01. Route groups: <code>(site)</code>,{" "}
        <code>(app)</code>, <code>(share)</code>, <code>(admin)</code>.
      </p>
      <div className="flex gap-3">
        <Button variant="primary" asChild>
          <Link href="/signup">Get started</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
