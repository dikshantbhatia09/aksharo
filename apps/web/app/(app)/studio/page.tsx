import Link from "next/link";

import { BRAND } from "@montaj/config";
import { Button, Card, EmptyState } from "@montaj/ui";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Studio" };

/**
 * The shell's landing page until A14 builds Home.
 *
 * A13 owns the frame, not the content: the drop zone, quick-picks and recent
 * projects grid are A14's, and the editor is A15–A17's. What is here is enough
 * to prove the shell renders, navigates and stays accessible.
 */
export default function StudioPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1
          className="font-display text-2xl font-semibold tracking-tight"
          data-testid="studio-heading"
        >
          Studio
        </h1>
        <p className="text-fg-2 text-sm">
          Your workspace in {BRAND.name}. Uploads and projects arrive with A14.
        </p>
      </div>

      <EmptyState
        title="Nothing here yet"
        description="Drop a clip and you will have captions in about a minute. The upload engine lands with the Home and Projects work package."
        action={
          <Button variant="secondary" asChild>
            <Link href="/settings/profile">Set your defaults</Link>
          </Button>
        }
      />

      <Card className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-base font-medium">While you wait</h2>
        <p className="text-fg-2 text-sm">
          Set the languages you speak on camera and decide what we may remember, in{" "}
          <Link href="/settings/languages" className="text-lime-500 rounded-sm hover:underline">
            Languages &amp; defaults
          </Link>{" "}
          and{" "}
          <Link href="/settings/privacy" className="text-lime-500 rounded-sm hover:underline">
            Privacy
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
