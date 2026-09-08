"use client";

/**
 * K04: the rail's "Library" tab.
 *
 * The brief's instruction: check whether a reusable-asset concept already
 * exists before inventing one. Two do, and both are surfaced here as-is —
 * neither is new asset-management work, only a first UI for what the backend
 * already ships:
 *
 * - **Brand assets** (`apps/api/src/exports/brand-assets.controller.ts`): a
 *   workspace's reusable watermark/logo PNGs. Full create/list/delete exists
 *   server-side; `apps/web` had zero callers before this panel
 *   (`brand-assets-endpoints.ts`'s doc comment).
 * - **Recent projects** (`useProjects`, already `@montaj/api-client`'s own
 *   public hook — the same one Home's Recent grid uses) — the closest thing
 *   this app has to Kalakar's "recent videos" shelf.
 *
 * What is genuinely NOT here: a general reusable *media* library (logos are
 * covered; arbitrary reusable clips/images are not — no such concept exists
 * anywhere in the app, `apps/web` or `apps/api`). Inventing one is a bigger
 * feature than this work package's budget; flagged in the final report
 * instead of rushed here.
 */
import { Image as ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useProjects } from "@montaj/api-client";
import { Badge, Button, cn } from "@montaj/ui";

import { MAX_BRAND_ASSET_BYTES, type BrandAssetView } from "./brand-assets-endpoints";
import { useBrandAssets, useCreateBrandAsset, useDeleteBrandAsset } from "./use-brand-assets";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "—";
  return `${Math.round(bytes / 1024)} KB`;
}

export function LibraryPanel({ className }: { readonly className?: string }): React.JSX.Element {
  const assets = useBrandAssets();
  const createAsset = useCreateBrandAsset();
  const deleteAsset = useDeleteBrandAsset();
  const recent = useProjects({ limit: 6 });

  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  async function onFileChosen(file: File): Promise<void> {
    setError(null);
    if (file.type !== "image/png") {
      setError("Brand assets are PNG images only.");
      return;
    }
    if (file.size > MAX_BRAND_ASSET_BYTES) {
      setError(`A brand asset may be at most ${String(MAX_BRAND_ASSET_BYTES / (1024 * 1024))} MB.`);
      return;
    }
    setUploading(true);
    try {
      const ticket = await createAsset.mutateAsync({
        contentType: "image/png",
        sizeBytes: file.size,
      });
      const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": "image/png" },
      });
      if (!put.ok) throw new Error(`The upload failed (HTTP ${String(put.status)}).`);
      await assets.refetch();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload that image.");
    } finally {
      setUploading(false);
    }
  }

  const recentProjects = recent.data?.pages[0]?.items ?? [];

  return (
    <div
      className={cn("flex h-full flex-col gap-4 overflow-y-auto", className)}
      data-testid="library-panel"
    >
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-fg-0 text-sm font-medium">Brand assets</h2>
          <input
            ref={inputRef}
            type="file"
            accept="image/png"
            className="sr-only"
            data-testid="library-brand-asset-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) void onFileChosen(file);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            data-testid="library-upload-brand-asset"
          >
            {uploading ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Upload aria-hidden="true" />
            )}
            Upload logo
          </Button>
        </div>
        <p className="text-fg-2 text-xs">
          Watermarks and logos, reusable across every project — the same library the Export dialog
          draws from.
        </p>

        {error !== null ? (
          <p role="alert" className="text-rejected text-xs" data-testid="library-error">
            {error}
          </p>
        ) : null}

        {assets.isPending ? (
          <p className="text-fg-2 text-xs">Loading…</p>
        ) : assets.isError ? (
          <p className="text-rejected text-xs">Could not load your brand assets.</p>
        ) : assets.data.length === 0 ? (
          <p className="text-fg-2 text-xs">No brand assets yet.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2" data-testid="library-brand-assets-list">
            {assets.data.map((asset) => (
              <BrandAssetTile
                key={asset.id}
                asset={asset}
                onDelete={() => deleteAsset.mutate(asset.id)}
                deleting={deleteAsset.isPending && deleteAsset.variables === asset.id}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-sm font-medium">Recent videos</h2>
        {recent.isPending ? (
          <p className="text-fg-2 text-xs">Loading…</p>
        ) : recentProjects.length === 0 ? (
          <p className="text-fg-2 text-xs">No other projects yet.</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="library-recent-projects">
            {recentProjects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/p/${project.id}`}
                  className="hover:bg-bg-2 flex items-center gap-2 rounded-md p-1.5 text-xs"
                  data-testid="library-recent-project"
                >
                  {project.thumbnailUrl !== undefined ? (
                    // A signed, short-lived thumbnail URL — next/image's remote-pattern
                    // allowlist does not cover it, so a plain <img> is correct here.
                    <img
                      src={project.thumbnailUrl}
                      alt=""
                      className="size-8 shrink-0 rounded-sm object-cover"
                    />
                  ) : (
                    <span className="bg-bg-2 flex size-8 shrink-0 items-center justify-center rounded-sm">
                      <ImageIcon className="text-fg-2 size-4" aria-hidden="true" />
                    </span>
                  )}
                  <span className="text-fg-1 truncate">{project.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BrandAssetTile({
  asset,
  onDelete,
  deleting,
}: {
  readonly asset: BrandAssetView;
  readonly onDelete: () => void;
  readonly deleting: boolean;
}): React.JSX.Element {
  return (
    <li
      className="border-border group relative flex flex-col items-center gap-1 rounded-md border p-2"
      data-testid="library-brand-asset-tile"
    >
      <ImageIcon className="text-fg-2 size-6" aria-hidden="true" />
      <Badge className="text-2xs">{formatBytes(asset.sizeBytes)}</Badge>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={deleting}
        onClick={onDelete}
        aria-label="Delete brand asset"
        className="absolute top-0.5 right-0.5 size-6 opacity-0 group-hover:opacity-100"
      >
        <Trash2 className="size-3" aria-hidden="true" />
      </Button>
    </li>
  );
}
