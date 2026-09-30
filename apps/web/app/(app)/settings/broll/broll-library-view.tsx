"use client";

import { Search, Upload } from "lucide-react";
import * as React from "react";

import { useSession } from "@montaj/api-client";
import { Button, Card, ConfirmAction, EmptyState, Input, Skeleton, cn } from "@montaj/ui";

import {
  BROLL_CONTENT_TYPES,
  brollFileProblem,
  parseTags,
  useBrollLibrary,
  useDeleteBrollPicture,
  useSaveStockPhoto,
  useStockSearch,
  useUpdateBrollPicture,
  useUploadBrollPicture,
  type BrollPicture,
  type StockOrientation,
  type StockPhoto,
} from "@/components/broll/use-broll-library";
import { SettingsGroup, SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";

/**
 * Settings → B-roll library (2026-10-05): the workspace's own pictures, which
 * a clip cuts away to where the speaker names what they show - Autopilot on a
 * run with "Add B-roll" on, and the editor's B-roll tab. A cutaway is a still
 * picture with a slow push-in or pan (the render draws pictures, not video).
 *
 * Tags are what Autopilot matches a picture on: "taj mahal" is shown where the
 * speaker says the Taj Mahal. A picture's first tag comes from its file's name
 * when that is words, and each can be changed on its card.
 *
 * Stock photos (from Pexels) are offered only when this deployment has them:
 * a search, and "Add to library", which keeps a copy with its photographer's
 * credit. Deleting a picture is confirmed: clips that show it stop showing it.
 *
 * Viewers see the library; only editors change it.
 */

const SELECT_CLASS = "bg-sunken border-neutral-600 text-fg-0 h-9 rounded-sm border px-3 text-sm";

const ORIENTATIONS: readonly { readonly value: StockOrientation | ""; readonly label: string }[] = [
  { value: "portrait", label: "Tall (9:16)" },
  { value: "landscape", label: "Wide (16:9)" },
  { value: "square", label: "Square" },
  { value: "", label: "Any shape" },
];

export function BrollLibraryView(): React.JSX.Element {
  const session = useSession();
  const canEdit = session !== null && session.role !== "viewer";
  const library = useBrollLibrary();
  const upload = useUploadBrollPicture();
  const [uploading, setUploading] = React.useState<{ done: number; of: number } | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const view = library.data;
  const items = view?.items ?? [];
  const full = view !== null && view !== undefined && items.length >= view.limits.maxAssets;

  const choose = async (files: readonly File[]): Promise<void> => {
    setProblem(null);
    const problems: string[] = [];
    setUploading({ done: 0, of: files.length });
    for (const [index, file] of files.entries()) {
      const local = brollFileProblem(file);
      if (local !== null) {
        problems.push(`${file.name}: ${local}`);
      } else {
        try {
          await upload.mutateAsync({ file });
        } catch (error) {
          problems.push(`${file.name}: ${messageForError(error)}`);
        }
      }
      setUploading({ done: index + 1, of: files.length });
    }
    setUploading(null);
    if (problems.length > 0) setProblem(problems.join(" "));
  };

  return (
    <SettingsSection
      title="B-roll library"
      description="Pictures your clips cut away to when you name what they show. Each shows as a still picture with a slow push-in or pan."
      testId="settings-broll"
      actions={
        <>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={BROLL_CONTENT_TYPES.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length > 0) void choose(files);
            }}
            data-testid="broll-upload-input"
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canEdit || uploading !== null || full || view === null}
            onClick={() => inputRef.current?.click()}
            data-testid="broll-upload"
          >
            <Upload aria-hidden="true" strokeWidth={1.75} />
            {uploading === null
              ? "Upload pictures"
              : `Uploading ${String(Math.min(uploading.done + 1, uploading.of))} of ${String(uploading.of)}…`}
          </Button>
        </>
      }
    >
      {library.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : view === null || view === undefined ? (
        <p className="text-fg-2 m-0 text-sm" data-testid="broll-unavailable">
          The B-roll library is not available here yet.
        </p>
      ) : (
        <>
          {problem === null ? null : (
            <p role="alert" className="text-rejected m-0 text-sm" data-testid="broll-error">
              {problem}
            </p>
          )}
          <p className="text-fg-2 m-0 text-sm" aria-live="polite" data-testid="broll-status">
            {!canEdit
              ? "Only editors can change the B-roll library."
              : full
                ? `The library is full (${String(view.limits.maxAssets)} pictures). Delete some to add more.`
                : `${String(items.length)} of ${String(view.limits.maxAssets)} pictures. JPEG, PNG or WebP; large photos are made smaller before they upload.`}
          </p>

          {items.length === 0 ? (
            <EmptyState
              title="No pictures yet"
              description="Upload photos of the places, things and food you talk about, and tag each with the words you say for it."
            />
          ) : (
            <ul
              className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3"
              data-testid="broll-pictures"
            >
              {items.map((picture) => (
                <li key={picture.assetId} className="no-underline">
                  <PictureCard picture={picture} canEdit={canEdit} />
                </li>
              ))}
            </ul>
          )}

          {view.stock.enabled ? <StockSearch canEdit={canEdit && !full} /> : null}
        </>
      )}
    </SettingsSection>
  );
}

/** One picture: what it is, the words it is matched on, and where it came from. */
function PictureCard({
  picture,
  canEdit,
}: {
  readonly picture: BrollPicture;
  readonly canEdit: boolean;
}): React.JSX.Element {
  const update = useUpdateBrollPicture();
  const remove = useDeleteBrollPicture();
  const saved = picture.tags.join(", ");
  const [tags, setTags] = React.useState(saved);
  const [problem, setProblem] = React.useState<string | null>(null);
  React.useEffect(() => {
    setTags(saved);
  }, [saved]);
  const changed = parseTags(tags).join(", ") !== saved;
  const tagsId = `broll-tags-${picture.assetId}`;

  return (
    <Card className="flex h-full flex-col gap-3" data-testid={`broll-picture-${picture.assetId}`}>
      <div className="bg-sunken aspect-video overflow-hidden rounded-md">
        <img
          src={picture.url}
          alt={picture.title ?? picture.tags.join(", ")}
          className="size-full object-cover"
          loading="lazy"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-fg-0 m-0 truncate text-sm font-medium">
          {picture.title ?? "Untitled picture"}
        </p>
        <p className="text-fg-2 m-0 text-xs">
          {`${String(picture.width)} × ${String(picture.height)} px`}
          {picture.credit === null ? null : (
            <>
              {" · Photo by "}
              <a
                href={picture.credit.photographerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg-1 underline"
              >
                {picture.credit.photographer}
              </a>
              {" on "}
              <a
                href={picture.credit.pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg-1 underline"
              >
                Pexels
              </a>
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={tagsId} className="text-fg-1 text-xs font-medium">
          Tags
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={tagsId}
            value={tags}
            placeholder="taj mahal, agra"
            disabled={!canEdit}
            onChange={(event) => {
              setTags(event.target.value);
            }}
            data-testid={`broll-tags-${picture.assetId}`}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canEdit || !changed || update.isPending}
            onClick={() => {
              setProblem(null);
              update.mutate(
                { assetId: picture.assetId, tags: parseTags(tags) },
                {
                  onError: (error) => {
                    setProblem(messageForError(error));
                  },
                },
              );
            }}
            data-testid={`broll-tags-save-${picture.assetId}`}
          >
            Save
          </Button>
        </div>
        {problem === null ? null : (
          <p role="alert" className="text-rejected m-0 text-xs">
            {problem}
          </p>
        )}
      </div>
      <div className="mt-auto flex justify-end">
        <ConfirmAction
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!canEdit || remove.isPending}
              data-testid={`broll-delete-${picture.assetId}`}
            >
              Delete
            </Button>
          }
          title="Delete this picture?"
          description="It is deleted for good. Clips that show it stop showing it; videos already made keep it."
          confirmLabel="Delete picture"
          confirmTestId={`broll-delete-confirm-${picture.assetId}`}
          onConfirm={() => {
            setProblem(null);
            remove.mutate(picture.assetId, {
              onError: (error) => {
                setProblem(messageForError(error));
              },
            });
          }}
        />
      </div>
    </Card>
  );
}

/** Stock photos (Pexels): a search, and a copy of any of them kept in the library. */
function StockSearch({ canEdit }: { readonly canEdit: boolean }): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [orientation, setOrientation] = React.useState<StockOrientation | "">("portrait");
  const search = useStockSearch(query, orientation === "" ? undefined : orientation, true);
  const save = useSaveStockPhoto();
  const [saved, setSaved] = React.useState<ReadonlySet<number>>(new Set());
  const [problem, setProblem] = React.useState<string | null>(null);

  const add = (photo: StockPhoto): void => {
    setProblem(null);
    save.mutate(
      { photoId: photo.id, tags: parseTags(query) },
      {
        onSuccess: () => {
          setSaved((current) => new Set([...current, photo.id]));
        },
        onError: (error) => {
          setProblem(messageForError(error));
        },
      },
    );
  };

  return (
    <SettingsGroup
      title="Stock photos"
      description="Search free stock photos and keep the ones you like in your library, tagged with what you searched for."
      testId="broll-stock"
    >
      <Card className="flex flex-col gap-3">
        <form
          className="flex flex-wrap items-center gap-2"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
          }}
        >
          <label htmlFor="broll-stock-query" className="sr-only">
            Search stock photos
          </label>
          <Input
            id="broll-stock-query"
            value={draft}
            placeholder="masala chai, mumbai skyline"
            className="min-w-0 flex-1"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            data-testid="broll-stock-query"
          />
          <label htmlFor="broll-stock-shape" className="sr-only">
            Shape
          </label>
          <select
            id="broll-stock-shape"
            className={SELECT_CLASS}
            value={orientation}
            onChange={(event) => {
              setOrientation(event.target.value as StockOrientation | "");
            }}
            data-testid="broll-stock-shape"
          >
            {ORIENTATIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={draft.trim().length < 2}
            data-testid="broll-stock-search"
          >
            <Search aria-hidden="true" strokeWidth={1.75} />
            Search
          </Button>
        </form>
        {problem === null && !search.isError ? null : (
          <p role="alert" className="text-rejected m-0 text-sm" data-testid="broll-stock-error">
            {problem ?? messageForError(search.error)}
          </p>
        )}
        {search.isFetching ? <Skeleton className="h-32 w-full" /> : null}
        {search.data === undefined || search.isFetching ? null : search.data.photos.length === 0 ? (
          <p className="text-fg-2 m-0 text-sm">No photos found. Try other words.</p>
        ) : (
          <ul
            className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4"
            data-testid="broll-stock-results"
          >
            {search.data.photos.map((photo) => (
              <li key={photo.id} className="flex flex-col gap-2 no-underline">
                <div className="bg-sunken aspect-[3/4] overflow-hidden rounded-md">
                  <img
                    src={photo.previewUrl}
                    alt={photo.alt === "" ? `Photo by ${photo.photographer}` : photo.alt}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                </div>
                <p className="text-fg-2 m-0 truncate text-xs">
                  {"By "}
                  <a
                    href={photo.photographerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-fg-1 underline"
                  >
                    {photo.photographer}
                  </a>
                </p>
                <Button
                  type="button"
                  variant={saved.has(photo.id) ? "ghost" : "secondary"}
                  size="sm"
                  disabled={!canEdit || saved.has(photo.id) || save.isPending}
                  onClick={() => {
                    add(photo);
                  }}
                  data-testid={`broll-stock-add-${String(photo.id)}`}
                >
                  {saved.has(photo.id) ? "In your library" : "Add to library"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className={cn("text-fg-2 m-0 text-xs")}>
          {"Photos provided by "}
          <a
            href="https://www.pexels.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-1 underline"
          >
            Pexels
          </a>
          .
        </p>
      </Card>
    </SettingsGroup>
  );
}
