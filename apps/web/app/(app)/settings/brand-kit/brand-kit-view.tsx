"use client";

import { Upload } from "lucide-react";
import * as React from "react";

import { useSession } from "@montaj/api-client";
import { DEFAULT_PICKABLE_STYLE_ID } from "@montaj/caption-styles/browser";
import {
  DEFAULT_BRAND_KIT_SETTINGS,
  END_CARD_DURATION_MS,
  type BrandKitSettings,
  type OverlayCorner,
  type OverlayImage,
} from "@montaj/edg";
import { Button, Card, ConfirmAction, Input, Skeleton, cn } from "@montaj/ui";

import {
  brandPreviewProjection,
  PREVIEW_CANVAS,
  PREVIEW_DURATION_MS,
  previewMomentMs,
  type PreviewMoment,
} from "@/components/brand-kit/brand-preview";
import {
  LOGO_CONTENT_TYPES,
  logoFileProblem,
  MUSIC_ACCEPT,
  musicFileProblem,
  useBrandKit,
  useRemoveLogo,
  useRemoveMusic,
  useSaveBrandKit,
  useUploadLogo,
  useUploadMusic,
  useWorkspaceBrandKit,
  useUpdateWorkspaceBrandKit,
  type BrandKitView as BrandKitResponse,
} from "@/components/brand-kit/use-brand-kit";
import { CaptionStage } from "@/components/editor/canvas/CaptionStage";
import { PICKABLE_STYLES, SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";
import { SettingsGroup, SettingsSection } from "@/components/settings/section";
import { messageForError } from "@/lib/errors";

/**
 * Settings → Brand kit (2026-10-02): the workspace's logo, colours, typefaces
 * and end card, which Autopilot puts on a run's clips when the run asks for it
 * ("Use my brand kit" on the start form). One kit per workspace.
 *
 * Everything but the logo is a draft until Save: the preview beside it draws
 * the draft through the same renderer and the same builders a clip gets, so
 * what it shows is what a clip will look like. The logo uploads on its own the
 * moment it is chosen (a signed PUT, then the server checks the file), and
 * taking it off is confirmed, since the file goes once no clip draws it.
 *
 * Music (2026-10-04) uploads the same way, once the person has confirmed they
 * have the rights to use it - a checkbox, required, recorded by the API with
 * who ticked it and when. Whether clips get it, and how loud, are ordinary
 * draft settings, saved with the rest.
 *
 * Viewers see the kit; only editors change it.
 */

const SELECT_CLASS =
  "bg-sunken border-neutral-600 text-fg-0 h-9 w-full rounded-sm border px-3 text-sm";

const CORNERS: readonly { readonly value: OverlayCorner; readonly label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];

/** Every whole second an end card may last. */
const DURATIONS: readonly number[] = [2_000, 3_000, 4_000].filter(
  (ms) => ms >= END_CARD_DURATION_MS.min && ms <= END_CARD_DURATION_MS.max,
);

const MOMENTS: readonly { readonly value: PreviewMoment; readonly label: string }[] = [
  { value: "opening", label: "Opening" },
  { value: "middle", label: "Middle" },
  { value: "end", label: "End card" },
];

/** The logo as an overlay draws it. */
function overlayImageOf(view: BrandKitResponse | null | undefined): OverlayImage | undefined {
  const logo = view?.logo;
  if (logo === null || logo === undefined) return undefined;
  return { assetId: logo.assetId, format: logo.format, width: logo.width, height: logo.height };
}

/** One row: a label with its help text, and the control on the right. */
function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label className="text-fg-0 text-sm font-medium" htmlFor={htmlFor}>
          {label}
        </label>
        {hint === undefined ? null : <p className="text-fg-2 text-xs">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** A colour the kit always has. */
function ColourRow({
  id,
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <Row label={label} htmlFor={id} {...(hint === undefined ? {} : { hint })}>
      <span className="text-2xs text-fg-2 tabular-nums uppercase">{value}</span>
      <input
        id={id}
        type="color"
        className="panel-swatch"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        data-testid={id}
      />
    </Row>
  );
}

/**
 * A colour the kit may leave to the caption style: a switch to use the kit's
 * own, and the swatch it is picked with.
 */
function OptionalColourRow({
  id,
  label,
  hint,
  value,
  fallback,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string | undefined;
  /** Where the swatch starts when the switch is turned on. */
  readonly fallback: string;
  readonly disabled: boolean;
  readonly onChange: (next: string | undefined) => void;
}): React.JSX.Element {
  const on = value !== undefined;
  return (
    <Row label={label} htmlFor={`${id}-on`} hint={on ? hint : "The caption style's own."}>
      <input
        id={`${id}-on`}
        type="checkbox"
        role="switch"
        className="panel-switch"
        checked={on}
        disabled={disabled}
        aria-label={`Use my own ${label.toLowerCase()}`}
        onChange={(event) => {
          onChange(event.target.checked ? fallback : undefined);
        }}
        data-testid={`${id}-on`}
      />
      <input
        id={id}
        type="color"
        className="panel-swatch"
        value={value ?? fallback}
        disabled={disabled || !on}
        aria-label={label}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        data-testid={id}
      />
    </Row>
  );
}

function FontSelect({
  id,
  value,
  families,
  emptyLabel,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: string | undefined;
  readonly families: readonly string[];
  readonly emptyLabel: string;
  readonly disabled: boolean;
  readonly onChange: (next: string | undefined) => void;
}): React.JSX.Element {
  return (
    <select
      id={id}
      className={cn(SELECT_CLASS, "w-56")}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        onChange(event.target.value === "" ? undefined : event.target.value);
      }}
      data-testid={id}
    >
      <option value="">{emptyLabel}</option>
      {families.map((family) => (
        <option key={family} value={family}>
          {family}
        </option>
      ))}
    </select>
  );
}

function RangeRow({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly disabled: boolean;
  readonly onChange: (next: number) => void;
}): React.JSX.Element {
  return (
    <Row label={label} htmlFor={id} {...(hint === undefined ? {} : { hint })}>
      <input
        id={id}
        type="range"
        className="panel-range w-40"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        data-testid={id}
      />
      <span className="text-fg-1 w-12 text-right text-xs tabular-nums">{format(value)}</span>
    </Row>
  );
}

/** The sample clip, drawn by the renderer every clip is drawn by. */
function BrandPreview({
  settings,
  view,
}: {
  readonly settings: BrandKitSettings;
  readonly view: BrandKitResponse | null | undefined;
}): React.JSX.Element {
  const [styleId, setStyleId] = React.useState(DEFAULT_PICKABLE_STYLE_ID);
  const [at, setAt] = React.useState({ ms: 1_300, seq: 1 });
  const style = SYSTEM_STYLE_MAP.get(styleId) ?? PICKABLE_STYLES[0];
  const logo = overlayImageOf(view);
  const projection = React.useMemo(
    () => (style === undefined ? undefined : brandPreviewProjection(settings, logo, style)),
    [settings, logo, style],
  );
  const jump = (ms: number): void => {
    setAt((current) => ({ ms, seq: current.seq + 1 }));
  };

  return (
    <Card className="flex flex-col gap-4 sm:flex-row" data-testid="brand-kit-preview">
      <div
        className="w-full shrink-0 sm:w-48"
        style={{
          aspectRatio: `${String(PREVIEW_CANVAS.width)} / ${String(PREVIEW_CANVAS.height)}`,
        }}
      >
        {projection === undefined ? null : (
          <CaptionStage
            src={undefined}
            // A plain frame where the video would be: the kit is what is shown.
            backdrop={<div aria-hidden="true" className="bg-bg-2 h-full w-full" />}
            projection={projection}
            catalogue={SYSTEM_STYLE_MAP}
            images={view?.images ?? {}}
            seekMs={at.ms}
            seekSeq={at.seq}
            showSafeZones={false}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="text-fg-1 m-0 text-sm">
          A sample clip with your kit, drawn the way a clip is. Save to use it on new runs.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show the moment">
          {MOMENTS.map((moment) => (
            <Button
              key={moment.value}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                jump(previewMomentMs(moment.value, settings));
              }}
              data-testid={`brand-kit-preview-${moment.value}`}
            >
              {moment.label}
            </Button>
          ))}
        </div>
        <input
          type="range"
          className="panel-range"
          min={0}
          max={PREVIEW_DURATION_MS - 1}
          step={100}
          value={at.ms}
          aria-label="Preview time"
          onChange={(event) => {
            jump(Number(event.target.value));
          }}
          data-testid="brand-kit-preview-time"
        />
        <label className="text-fg-2 flex flex-col gap-1 text-xs" htmlFor="brand-kit-preview-style">
          Caption style
          <select
            id="brand-kit-preview-style"
            className={SELECT_CLASS}
            value={styleId}
            onChange={(event) => {
              setStyleId(event.target.value);
            }}
            data-testid="brand-kit-preview-style"
          >
            {PICKABLE_STYLES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Card>
  );
}

function LogoGroup({
  view,
  canEdit,
}: {
  readonly view: BrandKitResponse | null | undefined;
  readonly canEdit: boolean;
}): React.JSX.Element {
  const upload = useUploadLogo();
  const remove = useRemoveLogo();
  const [problem, setProblem] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const logo = view?.logo ?? null;

  const choose = (file: File): void => {
    setProblem(null);
    const local = logoFileProblem(file);
    if (local !== null) {
      setProblem(local);
      return;
    }
    upload.mutate(file, {
      onError: (error) => {
        setProblem(messageForError(error));
      },
    });
  };

  return (
    <SettingsGroup
      title="Logo"
      description="A PNG, JPEG or WebP up to 2 MB. A transparent PNG looks best."
      testId="brand-kit-logo"
    >
      <Card className="flex flex-wrap items-center gap-4">
        <div className="bg-sunken flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md">
          {logo === null ? (
            <span className="text-fg-2 text-xs">No logo</span>
          ) : (
            <img
              src={logo.url}
              alt="Your logo"
              className="max-h-full max-w-full object-contain"
              data-testid="brand-kit-logo-image"
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-fg-0 m-0 text-sm">
            {logo === null
              ? "Add your logo to put it on your clips."
              : `${String(logo.width)} × ${String(logo.height)} px`}
          </p>
          {problem === null ? null : (
            <p
              role="alert"
              className="text-rejected m-0 text-xs"
              data-testid="brand-kit-logo-error"
            >
              {problem}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_CONTENT_TYPES.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) choose(file);
            }}
            data-testid="brand-kit-logo-input"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canEdit || upload.isPending}
            onClick={() => inputRef.current?.click()}
            data-testid="brand-kit-logo-upload"
          >
            <Upload aria-hidden="true" strokeWidth={1.75} />
            {upload.isPending ? "Uploading…" : logo === null ? "Upload logo" : "Replace"}
          </Button>
          {logo === null ? null : (
            <ConfirmAction
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canEdit || remove.isPending}
                  data-testid="brand-kit-logo-remove"
                >
                  Remove
                </Button>
              }
              title="Remove your logo?"
              description="New clips will not get a logo. Clips that already have it keep it until you take it off them in the editor; once none does, the file is deleted."
              confirmLabel="Remove logo"
              confirmTestId="brand-kit-logo-remove-confirm"
              onConfirm={() => {
                setProblem(null);
                remove.mutate(undefined, {
                  onError: (error) => {
                    setProblem(messageForError(error));
                  },
                });
              }}
            />
          )}
        </div>
      </Card>
    </SettingsGroup>
  );
}

const MUSIC_LEVELS: readonly {
  readonly value: BrandKitSettings["music"]["level"];
  readonly label: string;
  readonly hint: string;
}[] = [
  { value: "quiet", label: "Quiet", hint: "Heard in the pauses" },
  { value: "medium", label: "Medium", hint: "Heard throughout" },
];

/** `83_000` → `1:23`. */
function trackLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

/** An ISO time as a short date, for "Rights confirmed on …". */
function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function MusicGroup({
  view,
  settings,
  canEdit,
  onSettings,
}: {
  readonly view: BrandKitResponse | null | undefined;
  readonly settings: BrandKitSettings["music"];
  readonly canEdit: boolean;
  readonly onSettings: (patch: Partial<BrandKitSettings["music"]>) => void;
}): React.JSX.Element {
  const upload = useUploadMusic();
  const remove = useRemoveMusic();
  const [problem, setProblem] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<File | null>(null);
  const [rights, setRights] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const music = view?.music ?? null;
  const locked = !canEdit;

  const choose = (file: File): void => {
    setProblem(null);
    const local = musicFileProblem(file);
    if (local !== null) {
      setProblem(local);
      return;
    }
    setPending(file);
    setRights(false);
  };

  const send = (): void => {
    if (pending === null) return;
    setProblem(null);
    upload.mutate(
      { file: pending, rightsAttested: rights },
      {
        onSuccess: () => {
          setPending(null);
          setRights(false);
        },
        onError: (error) => {
          setProblem(messageForError(error));
        },
      },
    );
  };

  return (
    <SettingsGroup
      title="Music"
      description="Your own track under Autopilot's clips when a run uses the brand kit: faded in and out, and quieter whenever anyone talks. MP3, WAV or M4A, 5 seconds to 10 minutes, up to 25 MB."
      testId="brand-kit-music"
    >
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
            {music === null ? (
              <p className="text-fg-0 m-0 text-sm" data-testid="brand-kit-music-none">
                No music yet.
              </p>
            ) : (
              <>
                <p className="text-fg-0 m-0 truncate text-sm" data-testid="brand-kit-music-title">
                  {music.title ?? "Your music"}
                </p>
                <p className="text-fg-2 m-0 text-xs" data-testid="brand-kit-music-facts">
                  {`${music.format.toUpperCase()} · ${trackLength(music.durationMs)}`}
                  {music.rightsAttestedAt === null
                    ? ""
                    : ` · Rights confirmed on ${shortDate(music.rightsAttestedAt)}`}
                </p>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept={MUSIC_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) choose(file);
              }}
              data-testid="brand-kit-music-input"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={locked || upload.isPending}
              onClick={() => inputRef.current?.click()}
              data-testid="brand-kit-music-choose"
            >
              <Upload aria-hidden="true" strokeWidth={1.75} />
              {music === null ? "Choose music" : "Replace"}
            </Button>
            {music === null ? null : (
              <ConfirmAction
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={locked || remove.isPending}
                    data-testid="brand-kit-music-remove"
                  >
                    Remove
                  </Button>
                }
                title="Remove your music?"
                description="New clips will not get music. Clips that already have it keep it until you take it off them in the editor; once none does, the file is deleted."
                confirmLabel="Remove music"
                confirmTestId="brand-kit-music-remove-confirm"
                onConfirm={() => {
                  setProblem(null);
                  remove.mutate(undefined, {
                    onError: (error) => {
                      setProblem(messageForError(error));
                    },
                  });
                }}
              />
            )}
          </div>
        </div>

        {music === null ? null : (
          <audio
            controls
            preload="none"
            src={music.url}
            className="w-full"
            aria-label={`Play ${music.title ?? "your music"}`}
            data-testid="brand-kit-music-player"
          />
        )}

        {pending === null ? null : (
          <div
            className="bg-sunken flex flex-col gap-2 rounded-md p-3"
            data-testid="brand-kit-music-pending"
          >
            <p className="text-fg-0 m-0 truncate text-sm">{pending.name}</p>
            <label className="text-fg-1 flex min-h-8 cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="accent-accent mt-0.5 size-4 shrink-0"
                checked={rights}
                onChange={(event) => {
                  setRights(event.target.checked);
                }}
                data-testid="brand-kit-music-rights"
              />
              <span>
                I have the rights to use this music in my videos, wherever they are posted.
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!rights || upload.isPending}
                onClick={send}
                data-testid="brand-kit-music-upload"
              >
                {upload.isPending ? "Uploading…" : "Upload music"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={upload.isPending}
                onClick={() => {
                  setPending(null);
                  setRights(false);
                }}
                data-testid="brand-kit-music-cancel"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {problem === null ? null : (
          <p role="alert" className="text-rejected m-0 text-xs" data-testid="brand-kit-music-error">
            {problem}
          </p>
        )}

        <Row
          label="Add to clips"
          htmlFor="brand-kit-music-on"
          hint={
            music === null
              ? "Once you have uploaded a track."
              : "Under every clip of a run that uses the brand kit."
          }
        >
          <input
            id="brand-kit-music-on"
            type="checkbox"
            role="switch"
            className="panel-switch"
            checked={settings.enabled}
            disabled={locked}
            onChange={(event) => {
              onSettings({ enabled: event.target.checked });
            }}
            data-testid="brand-kit-music-on"
          />
        </Row>
        <fieldset className="m-0 border-0 p-0 pb-2" disabled={locked || !settings.enabled}>
          <legend className="text-fg-0 mb-2 p-0 text-sm font-medium">Level</legend>
          <div className="grid grid-cols-2 gap-2">
            {MUSIC_LEVELS.map((level) => (
              <label
                key={level.value}
                className={cn(
                  "flex min-h-11 cursor-pointer flex-col items-center justify-center rounded-sm border px-2 py-1 text-sm",
                  settings.level === level.value
                    ? "border-accent text-fg-0"
                    : "text-fg-1 border-neutral-600",
                )}
              >
                <input
                  type="radio"
                  name="brand-kit-music-level"
                  className="sr-only"
                  value={level.value}
                  checked={settings.level === level.value}
                  onChange={() => {
                    onSettings({ level: level.value });
                  }}
                  data-testid={`brand-kit-music-level-${level.value}`}
                />
                {level.label}
                <span className="text-fg-2 text-2xs">{level.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </Card>
    </SettingsGroup>
  );
}

function BumpersGroup({
  canEdit,
}: {
  readonly canEdit: boolean;
}): React.JSX.Element {
  const wbkQuery = useWorkspaceBrandKit();
  const updateWbk = useUpdateWorkspaceBrandKit();
  const data = wbkQuery.data;
  const [introUrl, setIntroUrl] = React.useState(data?.introVideoUrl ?? "");
  const [outroUrl, setOutroUrl] = React.useState(data?.outroVideoUrl ?? "");
  const [handle, setHandle] = React.useState(data?.socialHandle ?? "");
  const [position, setPosition] = React.useState<"TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT">(
    data?.logoPosition ?? "TOP_LEFT",
  );
  const [savedMsg, setSavedMsg] = React.useState(false);

  React.useEffect(() => {
    if (data) {
      setIntroUrl(data.introVideoUrl ?? "");
      setOutroUrl(data.outroVideoUrl ?? "");
      setHandle(data.socialHandle ?? "");
      setPosition(data.logoPosition ?? "TOP_LEFT");
    }
  }, [data]);

  const onSaveBumpers = (): void => {
    updateWbk.mutate(
      {
        introVideoUrl: introUrl || null,
        outroVideoUrl: outroUrl || null,
        socialHandle: handle || null,
        logoPosition: position,
      },
      {
        onSuccess: () => {
          setSavedMsg(true);
          setTimeout(() => setSavedMsg(false), 3000);
        },
      },
    );
  };

  return (
    <SettingsGroup
      title="Video Bumpers & Social Overlays"
      description="Stitch signature 1.5–2.5s intro motion stingers and 2.0–3.0s outro CTA cards onto your shorts with -14 LUFS loudness matching."
      testId="brand-kit-bumpers"
    >
      <Card className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-fg-0 text-sm font-medium" htmlFor="brand-kit-intro-bumper">
              Intro Bumper MP4 URI
            </label>
            <p className="text-fg-2 text-xs">
              1.5–2.5s branded motion sting stitched to the front of every clip.
            </p>
            <Input
              id="brand-kit-intro-bumper"
              data-testid="brand-kit-intro-bumper"
              placeholder="https://.../intro-bumper.mp4"
              value={introUrl}
              disabled={!canEdit || updateWbk.isPending}
              onChange={(e) => setIntroUrl(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-fg-0 text-sm font-medium" htmlFor="brand-kit-outro-bumper">
              Outro Bumper / CTA Card MP4 URI
            </label>
            <p className="text-fg-2 text-xs">
              2.0–3.0s concluding call-to-action video stitched to the end.
            </p>
            <Input
              id="brand-kit-outro-bumper"
              data-testid="brand-kit-outro-bumper"
              placeholder="https://.../outro-cta.mp4"
              value={outroUrl}
              disabled={!canEdit || updateWbk.isPending}
              onChange={(e) => setOutroUrl(e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-fg-0 text-sm font-medium" htmlFor="brand-kit-social-handle">
              Social Media Handle Badge
            </label>
            <p className="text-fg-2 text-xs">
              E.g. @aksharo or your channel handle across platforms.
            </p>
            <Input
              id="brand-kit-social-handle"
              data-testid="brand-kit-social-handle"
              placeholder="@yourhandle"
              value={handle}
              disabled={!canEdit || updateWbk.isPending}
              onChange={(e) => setHandle(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-fg-0 text-sm font-medium" htmlFor="brand-kit-corner-position">
              Corner Logo Bug Position
            </label>
            <p className="text-fg-2 text-xs">
              Persistent placement safe from platform header and UI buttons.
            </p>
            <select
              id="brand-kit-corner-position"
              data-testid="brand-kit-corner-position"
              className={SELECT_CLASS}
              value={position}
              disabled={!canEdit || updateWbk.isPending}
              onChange={(e) => setPosition(e.target.value as typeof position)}
            >
              <option value="TOP_LEFT">Top Left (Safe X=60px, Y=180px)</option>
              <option value="TOP_RIGHT">Top Right</option>
              <option value="BOTTOM_LEFT">Bottom Left</option>
              <option value="BOTTOM_RIGHT">Bottom Right</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-neutral-700/50">
          <span className="text-fg-2 text-xs">
            {savedMsg
              ? "✓ Bumpers and social handle settings saved!"
              : updateWbk.isPending
              ? "Saving bumper configuration…"
              : "Settings are automatically applied during video rendering."}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canEdit || updateWbk.isPending}
            onClick={onSaveBumpers}
            data-testid="brand-kit-save-bumpers"
          >
            Save bumper settings
          </Button>
        </div>
      </Card>
    </SettingsGroup>
  );
}

export function BrandKitView(): React.JSX.Element {
  const session = useSession();
  const canEdit = session !== null && session.role !== "viewer";
  const kit = useBrandKit();
  const save = useSaveBrandKit();
  const view = kit.data;
  const saved = view?.settings ?? DEFAULT_BRAND_KIT_SETTINGS;
  const [draft, setDraft] = React.useState<BrandKitSettings>(saved);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  // The kit as the server has it, whenever that changes (a load, a save, a
  // logo upload that created the kit): the form starts from it again.
  const savedKey = JSON.stringify(saved);
  React.useEffect(() => {
    setDraft(JSON.parse(savedKey) as BrandKitSettings);
  }, [savedKey]);

  const dirty = JSON.stringify(draft) !== savedKey;
  const families = view?.fontFamilies ?? [];
  const locked = !canEdit;

  const set = <K extends keyof BrandKitSettings>(
    key: K,
    patch: Partial<BrandKitSettings[K]>,
  ): void => {
    setJustSaved(false);
    // eslint-disable-next-line security/detect-object-injection -- one of the kit's own section names
    setDraft((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  };
  /** Sets an optional field, or takes it out when `value` is undefined. */
  const setOptional = (
    key: "captions" | "hookTitle",
    field: string,
    value: string | undefined,
  ): void => {
    setJustSaved(false);
    setDraft((current) => {
      // eslint-disable-next-line security/detect-object-injection -- one of the kit's own section names
      const next: Record<string, unknown> = { ...current[key] };
      // eslint-disable-next-line security/detect-object-injection -- a field name from this page's own controls
      if (value === undefined) delete next[field];
      // eslint-disable-next-line security/detect-object-injection -- a field name from this page's own controls
      else next[field] = value;
      return { ...current, [key]: next };
    });
  };

  const onSave = (): void => {
    setError(null);
    save.mutate(draft, {
      onSuccess: () => {
        setJustSaved(true);
      },
      onError: (saveError) => {
        setError(messageForError(saveError));
      },
    });
  };

  return (
    <SettingsSection
      title="Brand kit"
      description="Your logo, colours and end card, on every clip Autopilot makes with “Use my brand kit” on."
      testId="settings-brand-kit"
      actions={
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={locked || !dirty || save.isPending || kit.isPending}
          onClick={onSave}
          data-testid="brand-kit-save"
        >
          {save.isPending ? "Saving…" : "Save brand kit"}
        </Button>
      }
    >
      {kit.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {error === null ? null : (
            <p role="alert" className="text-rejected m-0 text-sm" data-testid="brand-kit-error">
              {error}
            </p>
          )}
          <p className="text-fg-2 m-0 text-sm" aria-live="polite" data-testid="brand-kit-status">
            {locked
              ? "Only editors can change the brand kit."
              : dirty
                ? "You have changes that are not saved."
                : justSaved
                  ? "Saved. New runs with the brand kit on use it."
                  : view?.exists === true
                    ? "Clips already made keep their look; new runs get the kit."
                    : "No brand kit yet: save one to offer it when you start a run."}
          </p>

          <BrandPreview settings={draft} view={view} />

          <LogoGroup view={view} canEdit={canEdit} />

          <MusicGroup
            view={view}
            settings={draft.music}
            canEdit={canEdit}
            onSettings={(patch) => {
              set("music", patch);
            }}
          />

          <BumpersGroup canEdit={canEdit} />

          <SettingsGroup
            title="Logo placement"
            description="It moves to the other corner on the same side, or shrinks, rather than cover a caption."
            testId="brand-kit-placement"
          >
            <Card className="flex flex-col">
              <Row label="Show in a corner" htmlFor="brand-kit-logo-show">
                <input
                  id="brand-kit-logo-show"
                  type="checkbox"
                  role="switch"
                  className="panel-switch"
                  checked={draft.logo.show}
                  disabled={locked}
                  onChange={(event) => {
                    set("logo", { show: event.target.checked });
                  }}
                  data-testid="brand-kit-logo-show"
                />
              </Row>
              <fieldset className="m-0 border-0 p-0 py-2" disabled={locked || !draft.logo.show}>
                <legend className="text-fg-0 mb-2 p-0 text-sm font-medium">Corner</legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {CORNERS.map((corner) => (
                    <label
                      key={corner.value}
                      className={cn(
                        "flex h-9 cursor-pointer items-center justify-center rounded-sm border text-sm",
                        draft.logo.corner === corner.value
                          ? "border-accent text-fg-0"
                          : "text-fg-1 border-neutral-600",
                      )}
                    >
                      <input
                        type="radio"
                        name="brand-kit-corner"
                        className="sr-only"
                        value={corner.value}
                        checked={draft.logo.corner === corner.value}
                        onChange={() => {
                          set("logo", { corner: corner.value });
                        }}
                        data-testid={`brand-kit-corner-${corner.value}`}
                      />
                      {corner.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <RangeRow
                id="brand-kit-logo-size"
                label="Size"
                hint="Share of the frame's width."
                value={draft.logo.sizePct}
                min={5}
                max={40}
                step={1}
                format={(value) => `${String(value)}%`}
                disabled={locked || !draft.logo.show}
                onChange={(sizePct) => {
                  set("logo", { sizePct });
                }}
              />
              <RangeRow
                id="brand-kit-logo-opacity"
                label="Opacity"
                value={Math.round(draft.logo.opacity * 100)}
                min={10}
                max={100}
                step={5}
                format={(value) => `${String(value)}%`}
                disabled={locked || !draft.logo.show}
                onChange={(percent) => {
                  set("logo", { opacity: percent / 100 });
                }}
              />
              <RangeRow
                id="brand-kit-logo-margin"
                label="Margin"
                hint="Distance from the edges."
                value={draft.logo.marginPct}
                min={0}
                max={15}
                step={0.5}
                format={(value) => `${String(value)}%`}
                disabled={locked || !draft.logo.show}
                onChange={(marginPct) => {
                  set("logo", { marginPct });
                }}
              />
            </Card>
          </SettingsGroup>

          <SettingsGroup
            title="Colours"
            description="Primary: title cards and your handle. Secondary: where a new end card starts. Text: words on your cards, where they read."
            testId="brand-kit-colours"
          >
            <Card className="flex flex-col">
              <ColourRow
                id="brand-kit-color-primary"
                label="Primary"
                value={draft.colors.primary}
                disabled={locked}
                onChange={(primary) => {
                  set("colors", { primary });
                }}
              />
              <ColourRow
                id="brand-kit-color-secondary"
                label="Secondary"
                value={draft.colors.secondary}
                disabled={locked}
                onChange={(secondary) => {
                  set("colors", { secondary });
                }}
              />
              <ColourRow
                id="brand-kit-color-text"
                label="Text"
                value={draft.colors.text}
                disabled={locked}
                onChange={(text) => {
                  set("colors", { text });
                }}
              />
            </Card>
          </SettingsGroup>

          <SettingsGroup
            title="Captions"
            description="Left off, a caption keeps its style's own typeface and colours."
            testId="brand-kit-captions"
          >
            <Card className="flex flex-col">
              <Row label="Typeface" htmlFor="brand-kit-caption-font">
                <FontSelect
                  id="brand-kit-caption-font"
                  value={draft.captions.fontFamily}
                  families={families}
                  emptyLabel="The style's own"
                  disabled={locked}
                  onChange={(value) => {
                    setOptional("captions", "fontFamily", value);
                  }}
                />
              </Row>
              <OptionalColourRow
                id="brand-kit-caption-fill"
                label="Text colour"
                hint="Every word at rest."
                value={draft.captions.fill}
                fallback="#ffffff"
                disabled={locked}
                onChange={(value) => {
                  setOptional("captions", "fill", value);
                }}
              />
              <OptionalColourRow
                id="brand-kit-caption-highlight"
                label="Highlight"
                hint="The word being spoken, and the keyword on each line."
                value={draft.captions.highlight}
                fallback={draft.colors.primary}
                disabled={locked}
                onChange={(value) => {
                  setOptional("captions", "highlight", value);
                }}
              />
              <OptionalColourRow
                id="brand-kit-caption-stroke"
                label="Outline"
                hint="Used where the caption style has an outline."
                value={draft.captions.stroke}
                fallback="#000000"
                disabled={locked}
                onChange={(value) => {
                  setOptional("captions", "stroke", value);
                }}
              />
            </Card>
          </SettingsGroup>

          <SettingsGroup
            title="Hook title"
            description="The line over a clip's first seconds."
            testId="brand-kit-hook"
          >
            <Card className="flex flex-col">
              <Row label="Typeface" htmlFor="brand-kit-hook-font">
                <FontSelect
                  id="brand-kit-hook-font"
                  value={draft.hookTitle.fontFamily}
                  families={families}
                  emptyLabel="Same as the captions"
                  disabled={locked}
                  onChange={(value) => {
                    setOptional("hookTitle", "fontFamily", value);
                  }}
                />
              </Row>
              <OptionalColourRow
                id="brand-kit-hook-background"
                label="Card colour"
                hint="Your own card colour instead of the primary."
                value={draft.hookTitle.background}
                fallback={draft.colors.primary}
                disabled={locked}
                onChange={(value) => {
                  setOptional("hookTitle", "background", value);
                }}
              />
              <OptionalColourRow
                id="brand-kit-hook-text"
                label="Words"
                hint="Otherwise black or white, whichever reads on the card."
                value={draft.hookTitle.text}
                fallback={draft.colors.text}
                disabled={locked}
                onChange={(value) => {
                  setOptional("hookTitle", "text", value);
                }}
              />
            </Card>
          </SettingsGroup>

          <SettingsGroup
            title="End card"
            description="Over the last seconds of each clip, on a dimmed frame. The clip keeps its length."
            testId="brand-kit-end-card"
          >
            <Card className="flex flex-col">
              <Row label="Add an end card" htmlFor="brand-kit-end-card-on">
                <input
                  id="brand-kit-end-card-on"
                  type="checkbox"
                  role="switch"
                  className="panel-switch"
                  checked={draft.endCard.enabled}
                  disabled={locked}
                  onChange={(event) => {
                    set("endCard", {
                      enabled: event.target.checked,
                      // A new card starts on the secondary colour.
                      ...(event.target.checked && !draft.endCard.enabled
                        ? { background: draft.colors.secondary }
                        : {}),
                    });
                  }}
                  data-testid="brand-kit-end-card-on"
                />
              </Row>
              <fieldset
                className="m-0 flex flex-col border-0 p-0"
                disabled={locked || !draft.endCard.enabled}
              >
                <Row
                  label="Call to action"
                  htmlFor="brand-kit-end-card-cta"
                  hint={`${String(draft.endCard.cta.length)} of ${String(view?.limits.ctaMax ?? 60)}`}
                >
                  <Input
                    id="brand-kit-end-card-cta"
                    className="bg-sunken w-64 border-neutral-600"
                    placeholder="Follow for more"
                    maxLength={view?.limits.ctaMax ?? 60}
                    value={draft.endCard.cta}
                    onChange={(event) => {
                      set("endCard", { cta: event.target.value });
                    }}
                    data-testid="brand-kit-end-card-cta"
                  />
                </Row>
                <Row
                  label="Handle"
                  htmlFor="brand-kit-end-card-handle"
                  hint={`${String(draft.endCard.handle.length)} of ${String(view?.limits.handleMax ?? 40)}`}
                >
                  <Input
                    id="brand-kit-end-card-handle"
                    className="bg-sunken w-64 border-neutral-600"
                    placeholder="@yourname"
                    maxLength={view?.limits.handleMax ?? 40}
                    value={draft.endCard.handle}
                    onChange={(event) => {
                      set("endCard", { handle: event.target.value });
                    }}
                    data-testid="brand-kit-end-card-handle"
                  />
                </Row>
                <ColourRow
                  id="brand-kit-end-card-background"
                  label="Background"
                  value={draft.endCard.background}
                  disabled={locked || !draft.endCard.enabled}
                  onChange={(background) => {
                    set("endCard", { background });
                  }}
                />
                <Row label="Show the logo" htmlFor="brand-kit-end-card-logo">
                  <input
                    id="brand-kit-end-card-logo"
                    type="checkbox"
                    role="switch"
                    className="panel-switch"
                    checked={draft.endCard.showLogo}
                    onChange={(event) => {
                      set("endCard", { showLogo: event.target.checked });
                    }}
                    data-testid="brand-kit-end-card-logo"
                  />
                </Row>
                <Row label="How long" htmlFor="brand-kit-end-card-duration">
                  <select
                    id="brand-kit-end-card-duration"
                    className={cn(SELECT_CLASS, "w-32")}
                    value={draft.endCard.durationMs}
                    onChange={(event) => {
                      set("endCard", { durationMs: Number(event.target.value) });
                    }}
                    data-testid="brand-kit-end-card-duration"
                  >
                    {DURATIONS.map((ms) => (
                      <option key={ms} value={ms}>
                        {`${String(ms / 1000)} seconds`}
                      </option>
                    ))}
                  </select>
                </Row>
              </fieldset>
              {draft.endCard.enabled &&
              draft.endCard.cta.trim() === "" &&
              draft.endCard.handle.trim() === "" &&
              !(draft.endCard.showLogo && view?.logo !== null && view?.logo !== undefined) ? (
                <p
                  className="text-proposed m-0 py-2 text-xs"
                  data-testid="brand-kit-end-card-empty"
                >
                  Add a call to action, a handle or a logo, or the end card has nothing to show.
                </p>
              ) : null}
            </Card>
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  );
}
