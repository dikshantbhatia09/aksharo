"use client";

/**
 * A guest's page (2026-10-05): the clips a podcaster shared with their guest,
 * for someone with the link and no account - usually on a phone.
 *
 *   * **Built for a thumb.** One column at most 28rem wide, each clip's video
 *     full width, and a bar fixed to the bottom of the screen with the clip in
 *     view's video as one 48 px "Download video" - the page's one primary.
 *   * **Everything to repost.** Under each clip: every shape with and without
 *     captions, the words to post (a caption for anywhere, then each
 *     platform's) with Copy buttons, the images, and other languages when the
 *     team shared them. The episode's own posts close the page.
 *   * **Only what was shared.** The page shows the clips on the link and the
 *     run's title, nothing of the team or its workspace. Files are signed on
 *     each view and the page asks again every few minutes; a playing video
 *     keeps its address (`useStableUrl`).
 *   * **Counted, never blocked.** A download tells the team it started, and
 *     is never held up waiting for that.
 */
import { Download, RefreshCw } from "lucide-react";
import * as React from "react";

import { isApiError } from "@montaj/api-client";
import { Button, PageHeader } from "@montaj/ui";

import { IMAGE_LABELS, tooLongFor } from "@/components/repurpose/ClipFormats";
import { CopyTextButton } from "@/components/repurpose/copy-text";
import { FORMAT_TARGETS, type ImageFileId } from "@/components/repurpose/formats";
import { clipClock } from "@/components/repurpose/review/review-copy";
import { useStableUrl } from "@/components/repurpose/use-stable-url";
import { GRIEVANCE_OFFICER } from "@/content/site/legal";
import {
  useCountGuestDownload,
  useGuestPage,
  type GuestClip,
  type GuestDownload,
  type GuestPost,
  type GuestShape,
  type GuestVideo,
} from "@/lib/guest/guest-page";

export const GUEST_COPY = Object.freeze({
  loading: "Opening your clips…",
  eyebrow: "Clips to share",
  greeting: (name: string | null): string =>
    `${name === null ? "" : `Hi ${name}. `}These clips are ready to post: download a video, copy its words, and share it wherever you like.`,
  until: (date: string): string => `This link works until ${date}.`,
  none: "No clips are ready to download yet. Check back soon.",
  comingSoon: (count: number): string =>
    count === 1
      ? "1 more clip is not ready to download yet. Check back soon."
      : `${String(count)} more clips are not ready to download yet. Check back soon.`,
  position: (index: number, total: number): string => `Clip ${String(index)} of ${String(total)}`,
  videoLabel: (title: string): string => `${title}, video`,
  videos: "Videos",
  shapeName: Object.freeze({
    "9:16": "Vertical 9:16",
    "4:5": "Portrait 4:5",
    "1:1": "Square 1:1",
    "16:9": "Landscape 16:9",
  }) as Readonly<Record<GuestShape, string>>,
  fits: (platforms: string): string => `For ${platforms}`,
  tooLong: (limits: string): string => `Too long for: ${limits}.`,
  download: "Download",
  withoutCaptions: "Without captions",
  downloadVideo: "Download video",
  downloadClean: "Download video without captions",
  downloadNamed: (what: string, title: string): string => `Download ${what}: ${title}`,
  words: "Words to post",
  title: "Title",
  caption: "Caption",
  perPlatform: "Text for each platform",
  platform: Object.freeze({
    instagram: "Instagram caption",
    youtubeTitle: "YouTube title",
    youtubeDescription: "YouTube description",
    tiktok: "TikTok caption",
    facebook: "Facebook post",
    linkedin: "LinkedIn post",
    x: "X post",
  }),
  images: (count: number): string => `Images (${String(count)})`,
  slide: (index: number): string => `Slide ${String(index)}`,
  otherLanguages: (names: string): string => `Other languages: ${names}`,
  episode: "About the whole episode",
  episodeHint: "Posts about the full conversation, to share with a link to it.",
  linkedin: "LinkedIn post",
  xThread: "X thread",
  xPost: (index: number, total: number): string => `Post ${String(index)} of ${String(total)}`,
  wholeThread: "the whole thread",
  madeWith: "Made with Aksharo",
  grievance: "Grievance officer:",
  downloadRegion: "Download the clip in view",
  goneTitle: "These clips are not available",
  gone: Object.freeze({
    revoked: "This link was turned off by the people who sent it.",
    expired: "This link has expired.",
    missing: "This link does not exist.",
    unreachable: "We could not reach your clips. Check your connection and try again.",
  }),
  askForNew: "Ask the person who sent it for a new link.",
  tryAgain: "Try again",
});

/** The CSS aspect of a shape's video. */
const ASPECT_CLASS: Readonly<Record<GuestShape, string>> = Object.freeze({
  "9:16": "aspect-[9/16] max-h-[75dvh]",
  "4:5": "aspect-[4/5]",
  "1:1": "aspect-square",
  "16:9": "aspect-video",
});

function dateWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long" }).format(date);
}

/** "Instagram, Facebook, YouTube and TikTok": where a shape's video can go. */
export function shapeFits(shape: GuestShape): string {
  const platforms = [
    ...new Set(
      FORMAT_TARGETS.filter(
        (target) => target.file.kind === "video" && target.file.shape === shape,
      ).map((target) => target.platform),
    ),
  ];
  if (platforms.length <= 1) return platforms[0] ?? "";
  return `${platforms.slice(0, -1).join(", ")} and ${platforms.at(-1) ?? ""}`;
}

/** The one video the bar downloads: captions on, vertical first. */
export function mainDownload(
  clip: GuestClip,
): { readonly url: string; readonly shape: GuestShape; readonly captioned: boolean } | null {
  const vertical = [
    ...clip.videos.filter((video) => video.shape === "9:16"),
    ...clip.videos.filter((video) => video.shape !== "9:16"),
  ];
  for (const video of vertical) {
    if (video.url !== null) return { url: video.url, shape: video.shape, captioned: true };
  }
  for (const video of vertical) {
    if (video.cleanUrl !== null)
      return { url: video.cleanUrl, shape: video.shape, captioned: false };
  }
  return null;
}

function Gone({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const code = isApiError(error) ? error.code : "";
  const message =
    code === "guest/link_revoked"
      ? GUEST_COPY.gone.revoked
      : code === "guest/link_expired"
        ? GUEST_COPY.gone.expired
        : isApiError(error) && error.status === 404
          ? GUEST_COPY.gone.missing
          : GUEST_COPY.gone.unreachable;
  const final = isApiError(error) && error.status >= 400 && error.status < 500;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-12">
      <PageHeader
        title={GUEST_COPY.goneTitle}
        description={<span data-testid="guest-page-gone">{message}</span>}
      />
      {final ? (
        <p className="m-0 text-sm text-fg-2">{GUEST_COPY.askForNew}</p>
      ) : (
        <div>
          <Button variant="secondary" size="lg" onClick={onRetry}>
            <RefreshCw strokeWidth={1.75} aria-hidden="true" />
            {GUEST_COPY.tryAgain}
          </Button>
        </div>
      )}
    </main>
  );
}

export function GuestPageView({ token }: { readonly token: string }): React.JSX.Element {
  const page = useGuestPage(token);
  const count = useCountGuestDownload(token);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const cards = React.useRef(new Map<string, HTMLLIElement>());
  const clips = React.useMemo(() => page.data?.clips ?? [], [page.data]);

  // The clip in view is the one the bar downloads.
  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || clips.length === 0) return;
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset["clipId"];
          if (id !== undefined) ratios.set(id, entry.intersectionRatio);
        }
        let best: string | null = null;
        let bestRatio = 0;
        for (const [id, ratio] of ratios) {
          if (ratio > bestRatio) {
            best = id;
            bestRatio = ratio;
          }
        }
        if (best !== null) setActiveId(best);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const element of cards.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [clips]);

  const counted: Counted = (download) => () => {
    count.mutate(download);
  };

  if (page.isPending) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <p className="text-sm text-fg-2" role="status">
          {GUEST_COPY.loading}
        </p>
      </main>
    );
  }
  if (page.isError) {
    return (
      <Gone
        error={page.error}
        onRetry={() => {
          void page.refetch();
        }}
      />
    );
  }

  const data = page.data;
  const active = clips.find((clip) => clip.id === activeId) ?? clips[0];
  const activeIndex = active === undefined ? -1 : clips.indexOf(active);
  const main = active === undefined ? null : mainDownload(active);

  return (
    <main
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 pt-8 pb-40"
      data-testid="guest-page"
    >
      <PageHeader
        eyebrow={GUEST_COPY.eyebrow}
        title={<span data-testid="guest-page-title">{data.title}</span>}
        description={
          <span data-testid="guest-page-greeting">{GUEST_COPY.greeting(data.guestName)}</span>
        }
      />
      <p className="m-0 -mt-3 text-xs text-fg-2">{GUEST_COPY.until(dateWords(data.expiresAt))}</p>

      {clips.length === 0 ? (
        <p className="m-0 text-sm text-fg-1" data-testid="guest-page-empty">
          {GUEST_COPY.none}
        </p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-8 p-0">
          {clips.map((clip, index) => (
            <ClipCard
              key={clip.id}
              clip={clip}
              index={index + 1}
              total={clips.length}
              active={active?.id === clip.id}
              counted={counted}
              onActive={() => {
                setActiveId(clip.id);
              }}
              register={(element) => {
                if (element === null) cards.current.delete(clip.id);
                else cards.current.set(clip.id, element);
              }}
            />
          ))}
        </ol>
      )}

      {data.comingSoon > 0 && clips.length > 0 ? (
        <p className="m-0 text-sm text-fg-1" role="status" data-testid="guest-coming-soon">
          {GUEST_COPY.comingSoon(data.comingSoon)}
        </p>
      ) : null}

      {data.episode === null ? null : <EpisodePosts episode={data.episode} />}

      <footer className="flex flex-col gap-2 border-t border-border pt-5 text-xs text-fg-2">
        <a
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="self-start rounded-sm text-fg-1 underline underline-offset-4 hover:text-fg-0"
          data-testid="guest-made-with"
        >
          {GUEST_COPY.madeWith}
        </a>
        <p className="m-0">
          {GUEST_COPY.grievance}{" "}
          <a
            href={`mailto:${GRIEVANCE_OFFICER.email}`}
            className="rounded-sm text-fg-1 underline underline-offset-4 hover:text-fg-0"
          >
            {GRIEVANCE_OFFICER.email}
          </a>
        </p>
      </footer>

      {active === undefined || main === null ? null : (
        <div
          role="region"
          aria-label={GUEST_COPY.downloadRegion}
          className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]"
          data-testid="guest-download-bar"
        >
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            <p className="m-0 truncate text-xs text-fg-2" data-testid="guest-download-target">
              {GUEST_COPY.position(activeIndex + 1, clips.length)} ·{" "}
              <span className="text-fg-1">{active.title}</span>
            </p>
            <Button variant="primary" size="lg" className="h-12 w-full" asChild>
              <a
                href={main.url}
                download
                className="no-underline"
                onClick={counted({
                  clipId: active.id,
                  file: main.captioned ? "video" : "clean",
                  shape: main.shape,
                })}
                data-testid="guest-download-main"
              >
                <Download strokeWidth={1.75} aria-hidden="true" />
                {main.captioned ? GUEST_COPY.downloadVideo : GUEST_COPY.downloadClean}
              </a>
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

type Counted = (download: GuestDownload) => () => void;

function ClipCard({
  clip,
  index,
  total,
  active,
  counted,
  onActive,
  register,
}: {
  readonly clip: GuestClip;
  readonly index: number;
  readonly total: number;
  readonly active: boolean;
  readonly counted: Counted;
  readonly onActive: () => void;
  readonly register: (element: HTMLLIElement | null) => void;
}): React.JSX.Element {
  // The page is asked again every few minutes and signs the video afresh; a
  // playing video must not restart because of it.
  const src = useStableUrl(clip.player?.url);
  const player = clip.player;

  return (
    <li
      ref={register}
      data-clip-id={clip.id}
      className={`flex scroll-mt-4 flex-col gap-4 rounded-md border bg-surface p-3 ${active ? "border-border-hover" : "border-border"}`}
      data-testid={`guest-clip-${clip.id}`}
      data-active={active}
      onPointerDown={onActive}
      onFocus={onActive}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-2xs text-fg-2">
          {GUEST_COPY.position(index, total)}
          {clip.durationMs === null ? "" : ` · ${clipClock(clip.durationMs)}`}
        </span>
        <h2 className="m-0 text-base font-semibold text-fg-0">{clip.title}</h2>
      </div>

      {player === null || src === undefined ? null : (
        <div className="overflow-hidden rounded-sm bg-ink">
          <video
            src={src}
            controls
            playsInline
            preload={player.posterUrl === null ? "metadata" : "none"}
            {...(player.posterUrl === null ? {} : { poster: player.posterUrl })}
            aria-label={GUEST_COPY.videoLabel(clip.title)}
            className={`w-full object-contain ${ASPECT_CLASS[player.shape]}`}
            data-testid={`guest-video-${clip.id}`}
          />
        </div>
      )}

      <Words clip={clip} />

      <VideoList
        clip={clip}
        videos={clip.videos}
        counted={counted}
        testId={`guest-videos-${clip.id}`}
        label={GUEST_COPY.videos}
        file={{ captioned: "video", clean: "clean" }}
      />

      {clip.images.length === 0 ? null : <Images clip={clip} counted={counted} />}

      {clip.dubs.length === 0 ? null : (
        <details
          className="rounded-sm border border-border bg-bg-0"
          data-testid={`guest-dubs-${clip.id}`}
        >
          <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm text-fg-1 select-none">
            {GUEST_COPY.otherLanguages(clip.dubs.map((dub) => dub.name).join(", "))}
          </summary>
          <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
            {clip.dubs.map((dub) => (
              <VideoList
                key={dub.language}
                clip={clip}
                videos={dub.videos}
                counted={counted}
                testId={`guest-dub-${clip.id}-${dub.language}`}
                label={dub.name}
                language={dub.language}
                file={{ captioned: "dub", clean: "dub-clean" }}
              />
            ))}
          </div>
        </details>
      )}
    </li>
  );
}

/** Every shape of one clip (or of one language of it): with captions, and without. */
function VideoList({
  clip,
  videos,
  counted,
  testId,
  label,
  language,
  file,
}: {
  readonly clip: GuestClip;
  readonly videos: readonly GuestVideo[];
  readonly counted: Counted;
  readonly testId: string;
  readonly label: string;
  readonly language?: string;
  readonly file: { readonly captioned: "video" | "dub"; readonly clean: "clean" | "dub-clean" };
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-1"
      aria-label={`${label}: ${clip.title}`}
      data-testid={testId}
    >
      <h3 className="m-0 text-xs font-semibold tracking-wide text-fg-2 uppercase">{label}</h3>
      <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
        {videos.map((video) => {
          const name = GUEST_COPY.shapeName[video.shape];
          const limits = clip.durationMs === null ? [] : tooLongFor(video.shape, clip.durationMs);
          const what = language === undefined ? name : `${name} ${label}`;
          return (
            <li
              key={video.shape}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid={`${testId}-${video.shape.replace(":", "x")}`}
            >
              <div className="min-w-0 flex-[1_1_160px]">
                <p className="m-0 text-sm text-fg-0">
                  {name}{" "}
                  <span className="font-mono text-2xs text-fg-2">
                    {String(video.width)} × {String(video.height)}
                  </span>
                </p>
                <p className="m-0 text-2xs text-fg-2">{GUEST_COPY.fits(shapeFits(video.shape))}</p>
                {limits.length === 0 ? null : (
                  <p className="m-0 text-2xs text-warning">
                    {GUEST_COPY.tooLong(limits.join("; "))}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3">
                {video.cleanUrl === null ? null : (
                  <a
                    href={video.cleanUrl}
                    download
                    className="inline-flex min-h-11 items-center rounded-sm text-xs text-fg-1 underline underline-offset-4 hover:text-fg-0"
                    aria-label={GUEST_COPY.downloadNamed(
                      `${what} ${GUEST_COPY.withoutCaptions.toLowerCase()}`,
                      clip.title,
                    )}
                    onClick={counted({
                      clipId: clip.id,
                      file: file.clean,
                      shape: video.shape,
                      ...(language === undefined ? {} : { language }),
                    })}
                  >
                    {GUEST_COPY.withoutCaptions}
                  </a>
                )}
                {video.url === null ? null : (
                  <Button variant="secondary" size="sm" className="h-11 sm:h-9" asChild>
                    <a
                      href={video.url}
                      download
                      className="no-underline"
                      aria-label={GUEST_COPY.downloadNamed(what, clip.title)}
                      onClick={counted({
                        clipId: clip.id,
                        file: file.captioned,
                        shape: video.shape,
                        ...(language === undefined ? {} : { language }),
                      })}
                    >
                      <Download strokeWidth={1.75} aria-hidden="true" />
                      {GUEST_COPY.download}
                    </a>
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The labelled texts of one platform's post: YouTube has a title and a description. */
function postFields(post: GuestPost): { readonly label: string; readonly text: string }[] {
  const platform = GUEST_COPY.platform;
  switch (post.platform) {
    case "any":
      return [];
    case "youtube":
      return [
        ...(post.title === null ? [] : [{ label: platform.youtubeTitle, text: post.title }]),
        ...(post.text.trim() === ""
          ? []
          : [{ label: platform.youtubeDescription, text: post.text }]),
      ];
    case "instagram":
      return [{ label: platform.instagram, text: post.text }];
    case "tiktok":
      return [{ label: platform.tiktok, text: post.text }];
    case "facebook":
      return [{ label: platform.facebook, text: post.text }];
    case "linkedin":
      return [{ label: platform.linkedin, text: post.text }];
    case "x":
      return [{ label: platform.x, text: post.text }];
  }
}

/** One text with its Copy button. */
function CopyField({
  label,
  text,
  testId,
}: {
  readonly label: string;
  readonly text: string;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-2">{label}</span>
        <CopyTextButton text={text} label={label} testId={`${testId}-copy`} />
      </div>
      <p className="m-0 text-sm break-words whitespace-pre-line text-fg-0">{text}</p>
    </div>
  );
}

/** The clip's words: its title and a caption for anywhere, then each platform's own. */
function Words({ clip }: { readonly clip: GuestClip }): React.JSX.Element | null {
  const anywhere = clip.posts.find((post) => post.platform === "any");
  const perPlatform = clip.posts.flatMap((post) =>
    postFields(post).map((field) => ({ ...field, platform: post.platform })),
  );
  const title = anywhere?.title ?? clip.title;
  const caption = anywhere?.text.trim() ?? "";
  return (
    <section
      className="flex flex-col gap-3 rounded-sm border border-border bg-bg-0 p-3"
      aria-label={`${GUEST_COPY.words}: ${clip.title}`}
      data-testid={`guest-words-${clip.id}`}
    >
      <h3 className="m-0 text-xs font-semibold tracking-wide text-fg-2 uppercase">
        {GUEST_COPY.words}
      </h3>
      <CopyField label={GUEST_COPY.title} text={title} testId={`guest-title-${clip.id}`} />
      {caption === "" ? null : (
        <CopyField label={GUEST_COPY.caption} text={caption} testId={`guest-caption-${clip.id}`} />
      )}
      {perPlatform.length === 0 ? null : (
        <details data-testid={`guest-platforms-${clip.id}`}>
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-fg-1 select-none">
            {GUEST_COPY.perPlatform}
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {perPlatform.map((field) => (
              <CopyField
                key={field.label}
                label={field.label}
                text={field.text}
                testId={`guest-post-${clip.id}-${field.platform}${field.label === GUEST_COPY.platform.youtubeTitle ? "-title" : ""}`}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

/** The clip's images, each frame a download; collapsed so a phone loads none until asked. */
function Images({
  clip,
  counted,
}: {
  readonly clip: GuestClip;
  readonly counted: Counted;
}): React.JSX.Element {
  const frames = clip.images.reduce((sum, image) => sum + image.urls.length, 0);
  return (
    <details
      className="rounded-sm border border-border bg-bg-0"
      data-testid={`guest-images-${clip.id}`}
    >
      <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm text-fg-1 select-none">
        {GUEST_COPY.images(frames)}
      </summary>
      <ul className="m-0 grid list-none grid-cols-2 gap-3 border-t border-border p-3">
        {clip.images.map((image) => {
          const label = Object.hasOwn(IMAGE_LABELS, image.id)
            ? IMAGE_LABELS[image.id as ImageFileId]
            : image.id;
          return (
            <li
              key={image.id}
              className="flex flex-col gap-1.5"
              data-testid={`guest-image-${clip.id}-${image.id}`}
            >
              {image.urls[0] === undefined ? null : (
                <div className="flex h-28 items-center justify-center overflow-hidden rounded-sm border border-border bg-ink">
                  {/* A signed object URL: not an asset Next can optimise. */}
                  <img
                    src={image.urls[0]}
                    alt={`${label}: ${clip.title}`}
                    loading="lazy"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              )}
              <span className="text-xs text-fg-0">{label}</span>
              <span className="font-mono text-2xs text-fg-2">
                {String(image.width)} × {String(image.height)}
              </span>
              <span className="flex flex-wrap gap-x-3">
                {image.urls.map((url, frame) => (
                  <a
                    key={url}
                    href={url}
                    download
                    className="inline-flex min-h-11 items-center rounded-sm text-xs text-fg-1 underline underline-offset-4 hover:text-fg-0"
                    aria-label={GUEST_COPY.downloadNamed(
                      image.urls.length > 1
                        ? `${label} ${GUEST_COPY.slide(frame + 1).toLowerCase()}`
                        : label,
                      clip.title,
                    )}
                    onClick={counted({ clipId: clip.id, file: "image", image: image.id })}
                  >
                    {image.urls.length > 1 ? GUEST_COPY.slide(frame + 1) : GUEST_COPY.download}
                  </a>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** The episode's own posts: to share the whole conversation, beside the clips. */
function EpisodePosts({
  episode,
}: {
  readonly episode: { readonly linkedin: string | null; readonly xThread: readonly string[] };
}): React.JSX.Element {
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
      aria-label={GUEST_COPY.episode}
      data-testid="guest-episode"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-base font-semibold text-fg-0">{GUEST_COPY.episode}</h2>
        <p className="m-0 text-xs text-fg-2">{GUEST_COPY.episodeHint}</p>
      </div>
      {episode.linkedin === null ? null : (
        <CopyField
          label={GUEST_COPY.linkedin}
          text={episode.linkedin}
          testId="guest-episode-linkedin"
        />
      )}
      {episode.xThread.length === 0 ? null : (
        <div className="flex flex-col gap-2" data-testid="guest-episode-x">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-fg-2">{GUEST_COPY.xThread}</span>
            <CopyTextButton
              text={episode.xThread.join("\n\n")}
              label={GUEST_COPY.wholeThread}
              testId="guest-episode-x-copy"
            />
          </div>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {episode.xThread.map((post, index) => (
              <li key={`${String(index)}-${post}`}>
                <CopyField
                  label={GUEST_COPY.xPost(index + 1, episode.xThread.length)}
                  text={post}
                  testId={`guest-episode-x-${String(index + 1)}`}
                />
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
