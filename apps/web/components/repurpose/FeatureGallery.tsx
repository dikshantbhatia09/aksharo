"use client";

/**
 * "What one video gives you" (2026-10-01, OpusClip's feature pills and their
 * detail dialogs): every thing the clips pipeline makes, one tile each, and a
 * tile opened says what it is, how to get it and where to start.
 *
 * Every tile is something built and live; the words say where a feature is
 * limited (dubbing on paid plans, posting once an account is connected). Open
 * on the Clips page for a workspace with few runs, folded away for one that
 * knows them, and the choice is remembered per browser.
 *
 * Opened, it ends with "See a finished example" (2026-10-01) while the owner
 * has set one (`ExampleRunLink` renders nothing otherwise): the tiles say what
 * a run makes, the example shows it.
 */
import {
  BarChart3,
  ChevronRight,
  Languages,
  Layers,
  Palette,
  Radio,
  RectangleVertical,
  Share2,
  Sparkles,
  Type,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "@montaj/ui";

import { ExampleRunLink } from "@/components/repurpose/example/ExampleRunLink";
import { stylePreviewUrl } from "@/lib/style-previews";

export interface Feature {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly title: string;
  /** One line, on the tile. */
  readonly line: string;
  /** What it is, opened. */
  readonly about: string;
  /** How to get it, step by step. */
  readonly how: readonly string[];
  readonly cta: { readonly label: string; readonly href: string };
  /** Pictures made by the product itself, shown opened. */
  readonly pictures?: readonly { readonly src: string; readonly alt: string }[];
}

export const FEATURES: readonly Feature[] = [
  {
    key: "moments",
    icon: Sparkles,
    title: "The strongest moments, scored",
    line: "Every moment worth a clip, ranked, with why.",
    about:
      "An AI editor reads the whole video and picks the moments that stand on their own. Each gets a score out of 100 and a grade for its hook, its flow, its value and how much people talk about it now, with a sentence on each.",
    how: [
      "Paste a link or upload a long video.",
      "Open a clip to see its grades, the people it names and its words with their times.",
      "Search the clips by their words or by what they are about.",
    ],
    cta: { label: "Find my strongest moments", href: "/repurpose/new" },
  },
  {
    key: "captions",
    icon: Type,
    title: "Captions in your style",
    line: "Five looks, kept off faces, in Hinglish or Devanagari.",
    about:
      "Every clip is captioned word by word in the look you pick. Captions move out of the way of faces, and Hindi can be written in Roman (Hinglish) or Devanagari.",
    how: [
      "Pick a caption look when you start; save it as your default.",
      "Change the look of any clip later in the editor.",
    ],
    cta: { label: "Choose a caption look", href: "/repurpose/new" },
    pictures: [
      { src: stylePreviewUrl("punch-pop.png"), alt: "Punch Pop captions" },
      { src: stylePreviewUrl("karaoke-fill.png"), alt: "Karaoke Fill captions" },
      { src: stylePreviewUrl("word-pop.png"), alt: "Word Pop captions" },
    ],
  },
  {
    key: "sizes",
    icon: RectangleVertical,
    title: "Every size, every platform",
    line: "9:16, 4:5, 1:1 and 16:9, framed on the speaker, plus images.",
    about:
      "With Autopilot on, each clip is made in four sizes, each framed on whoever is speaking (two speakers can be stacked), with eleven images: covers, a carousel, a pin, a thumbnail and banners.",
    how: [
      "Leave Autopilot on when you start.",
      "Open a clip's “All formats”, or use Download all for every clip in one ZIP.",
    ],
    cta: { label: "Start with Autopilot", href: "/repurpose/new" },
  },
  {
    key: "editing",
    icon: Wand2,
    title: "Edited for you",
    line: "Cuts, zooms, emphasis, a hook title and B-roll.",
    about:
      "Autopilot trims the pauses, punches in on key moments, emphasises the words that matter and opens each clip with a headline. With pictures in your B-roll library it cuts away to them where the speaker names something.",
    how: [
      "Leave Autopilot on; add pictures in Settings › B-roll library for cutaways.",
      "Turn the hook titles off for a whole video from its page if you do not want them.",
    ],
    cta: { label: "Add B-roll pictures", href: "/settings/broll" },
  },
  {
    key: "brand",
    icon: Palette,
    title: "Your brand on every clip",
    line: "Logo, colours, typeface, end card and music.",
    about:
      "Save a brand kit once and Autopilot puts your logo, colours and typeface on every clip, adds your end card and lays your own music under it, quietly, lower while people speak.",
    how: ["Set it up in Settings › Brand kit.", "Keep “Use my brand kit” on when you start."],
    cta: { label: "Set up a brand kit", href: "/settings/brand-kit" },
  },
  {
    key: "dubbing",
    icon: Languages,
    title: "In other Indian languages",
    line: "A clip dubbed in the speaker's own voice.",
    about:
      "Dub a finished clip into other Indian languages in the speaker's own voice, with captions in the new language, in every size. On paid plans, charged per minute per language.",
    how: [
      "Open a finished clip and choose “Dub”.",
      "Confirm you have the right to use the speaker's voice.",
    ],
    cta: { label: "See plans", href: "/billing" },
  },
  {
    key: "compilations",
    icon: Layers,
    title: "Compilations and series",
    line: "Several clips as one video, or as Part 1, 2, 3.",
    about:
      "Join up to twenty clips into one video with a title card and fades, or label clips as a series so viewers come back for the next part.",
    how: ["On a video's page, choose “Make a compilation” or “Make a series”."],
    cta: { label: "Go to your videos", href: "/repurpose" },
  },
  {
    key: "share",
    icon: Share2,
    title: "Share, review and post",
    line: "Guest links, client review, one ZIP, a post a day.",
    about:
      "Send a podcast guest a link to download their clips, let a client approve or comment without an account, download everything in one ZIP, and, once your accounts are connected, post one clip a day.",
    how: [
      "On a video's page: Share with a guest, Share for review, Download all.",
      "Pick clips in the grid with Select to download just those.",
    ],
    cta: { label: "Go to your videos", href: "/repurpose" },
  },
  {
    key: "performance",
    icon: BarChart3,
    title: "Learn what works",
    line: "Views and engagement per clip, and picks that learn.",
    about:
      "Paste where a clip went and its numbers are kept up to date. What works compares length, opening, topic and time against your own median, and the next videos' picks lean a little towards what did best.",
    how: ["On a finished clip, choose “I posted this” and paste the link.", "Open What works."],
    cta: { label: "Open What works", href: "/repurpose/what-works" },
  },
  {
    key: "automations",
    icon: Radio,
    title: "From every new video",
    line: "Follow a channel; each upload becomes clips.",
    about:
      "Follow a YouTube channel and every video it posts starts an Autopilot run by itself, with the settings you saved for it. You are told when the clips are ready.",
    how: ["Open Automations and paste the channel's link."],
    cta: { label: "Follow a channel", href: "/repurpose/automations" },
  },
];

const FOLD_KEY = "aksharo.repurpose.gallery";

function recallFolded(): boolean | null {
  try {
    const value = window.localStorage.getItem(FOLD_KEY);
    return value === "folded" ? true : value === "open" ? false : null;
  } catch {
    return null;
  }
}

export interface FeatureGalleryProps {
  /** Open unless the person folded it: a workspace with few runs. */
  readonly openByDefault: boolean;
}

export function FeatureGallery({ openByDefault }: FeatureGalleryProps): React.JSX.Element {
  const [folded, setFolded] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    setFolded(recallFolded());
  }, []);
  const open = folded === null ? openByDefault : !folded;
  const [shown, setShown] = React.useState<Feature | null>(null);
  const headingId = React.useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      data-testid="feature-gallery"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          const next = open;
          setFolded(next);
          try {
            window.localStorage.setItem(FOLD_KEY, next ? "folded" : "open");
          } catch {
            // Storage off: folded for this visit.
          }
        }}
        className="-ml-1 flex items-center gap-1.5 self-start rounded-sm px-1 text-left"
        data-testid="feature-gallery-toggle"
      >
        <ChevronRight
          className={cn(
            "size-4 text-fg-2 transition-transform duration-[160ms]",
            open && "rotate-90",
          )}
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <h2 id={headingId} className="m-0 text-base text-fg-0">
          What one video gives you
        </h2>
      </button>
      {open ? (
        <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <li key={feature.key}>
                <button
                  type="button"
                  onClick={() => {
                    setShown(feature);
                  }}
                  className="flex h-full w-full items-start gap-3 rounded-md border border-border bg-surface p-3 text-left transition-colors hover:border-neutral-600 hover:bg-neutral-100/5"
                  data-testid={`feature-${feature.key}`}
                >
                  <Icon
                    className="mt-0.5 size-5 shrink-0 text-fg-2"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-fg-0">{feature.title}</span>
                    <span className="text-xs text-fg-2">{feature.line}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {open ? <ExampleRunLink withHint /> : null}

      <Dialog
        open={shown !== null}
        onOpenChange={(next) => {
          if (!next) setShown(null);
        }}
      >
        <DialogContent className="max-w-lg" data-testid="feature-detail">
          {shown === null ? null : (
            <>
              <DialogHeader>
                <DialogTitle>{shown.title}</DialogTitle>
                <DialogDescription>{shown.about}</DialogDescription>
              </DialogHeader>
              {shown.pictures === undefined ? null : (
                <div className="grid grid-cols-3 gap-2">
                  {shown.pictures.map((picture) => (
                    <img
                      key={picture.src}
                      src={picture.src}
                      alt={picture.alt}
                      width={270}
                      height={480}
                      loading="lazy"
                      className="aspect-[9/16] h-auto w-full rounded-sm border border-border bg-bg-2 object-cover"
                    />
                  ))}
                </div>
              )}
              <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm text-fg-1">
                {shown.how.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShown(null);
                  }}
                >
                  Close
                </Button>
                <Button variant="secondary" asChild>
                  <NextLink
                    href={shown.cta.href}
                    className="no-underline"
                    data-testid="feature-detail-cta"
                  >
                    {shown.cta.label}
                  </NextLink>
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
