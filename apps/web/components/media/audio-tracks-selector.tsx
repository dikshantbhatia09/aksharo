"use client";

import * as React from "react";
import { Mic, Volume2, VolumeX, Loader2, AlertCircle } from "lucide-react";
import { Card, Badge, cn } from "@montaj/ui";

export interface AudioTrackItem {
  id: string;
  mediaId: string;
  streamIndex: number;
  channelIndex: number;
  label: string;
  speakerLabel: string | null;
  isDialogue: boolean;
  sampleRate: number;
  channels: number;
  durationMs: number | null;
}

export interface AudioTracksSelectorProps {
  readonly projectId: string;
  readonly mediaId: string;
  readonly initialTracks?: AudioTrackItem[];
  readonly onTracksUpdated?: (tracks: AudioTrackItem[]) => void;
  readonly className?: string;
}

export function AudioTracksSelector({
  projectId,
  mediaId,
  initialTracks,
  onTracksUpdated,
  className,
}: AudioTracksSelectorProps): React.JSX.Element {
  const [tracks, setTracks] = React.useState<AudioTrackItem[]>(initialTracks ?? []);
  const [loading, setLoading] = React.useState<boolean>(!initialTracks);
  const [savingTrackId, setSavingTrackId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (initialTracks) {
      setTracks(initialTracks);
      return;
    }

    let cancelled = false;
    const fetchTracks = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(
          `/api/v1/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/audio-tracks`,
        );
        if (!res.ok) {
          throw new Error(`Failed to load audio tracks: ${res.statusText}`);
        }
        const data = (await res.json()) as AudioTrackItem[];
        if (!cancelled) {
          setTracks(data);
          onTracksUpdated?.(data);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load audio tracks");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void fetchTracks();

    return () => {
      cancelled = true;
    };
  }, [projectId, mediaId, initialTracks, onTracksUpdated]);

  const handleToggleDialogue = async (track: AudioTrackItem): Promise<void> => {
    const updatedValue = !track.isDialogue;
    setSavingTrackId(track.id);
    try {
      const res = await fetch(
        `/api/v1/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/audio-tracks/${encodeURIComponent(track.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isDialogue: updatedValue }),
        },
      );
      if (!res.ok) {
        throw new Error("Failed to update track dialogue setting");
      }
      const updatedTrack = (await res.json()) as AudioTrackItem;
      const newTracks = tracks.map((t) => (t.id === track.id ? updatedTrack : t));
      setTracks(newTracks);
      onTracksUpdated?.(newTracks);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update track");
    } finally {
      setSavingTrackId(null);
    }
  };

  const handleSpeakerChange = async (track: AudioTrackItem, newSpeaker: string): Promise<void> => {
    setSavingTrackId(track.id);
    try {
      const res = await fetch(
        `/api/v1/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(mediaId)}/audio-tracks/${encodeURIComponent(track.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speakerLabel: newSpeaker.trim() || null }),
        },
      );
      if (!res.ok) {
        throw new Error("Failed to update speaker label");
      }
      const updatedTrack = (await res.json()) as AudioTrackItem;
      const newTracks = tracks.map((t) => (t.id === track.id ? updatedTrack : t));
      setTracks(newTracks);
      onTracksUpdated?.(newTracks);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update track");
    } finally {
      setSavingTrackId(null);
    }
  };

  if (loading) {
    return (
      <Card className={cn("flex items-center justify-center space-x-2 p-4 text-sm text-muted-foreground", className)}>
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Detecting audio tracks...</span>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={cn("flex items-center space-x-2 border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive", className)}>
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{error}</span>
      </Card>
    );
  }

  if (tracks.length === 0) {
    return (
      <Card className={cn("p-4 text-sm text-muted-foreground", className)}>
        No multi-track audio detected. Using standard single-track downmix.
      </Card>
    );
  }

  return (
    <Card className={cn("space-y-4 p-4", className)}>
      <div className="flex items-center justify-between">
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
            <Mic className="h-4 w-4 text-primary" />
            Audio Tracks & Speaker Separation
          </h4>
          <p className="text-xs text-muted-foreground">
            {tracks.length} track{tracks.length > 1 ? "s" : ""} isolated from source media. Designate dialogue mic channels to enable 100% accurate speaker attribution.
          </p>
        </div>
        <Badge tone="neutral" className="text-xs">
          Multi-Track Demuxed
        </Badge>
      </div>

      <div className="space-y-2.5">
        {tracks.map((track, idx) => (
          <div
            key={track.id}
            data-testid={`audio-track-item-${track.id}`}
            className={cn(
              "flex flex-col sm:flex-row items-start sm:items-center justify-between rounded-lg border p-3 gap-3 transition-colors",
              track.isDialogue ? "bg-card border-border" : "bg-muted/40 border-muted text-muted-foreground",
            )}
          >
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleToggleDialogue(track)}
                disabled={savingTrackId === track.id}
                data-testid={`toggle-dialogue-${track.id}`}
                className={cn(
                  "rounded-md p-2 transition-colors",
                  track.isDialogue
                    ? "bg-primary/10 text-primary hover:bg-primary/20"
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
                title={track.isDialogue ? "Track active as dialogue" : "Track muted / ignored"}
              >
                {track.isDialogue ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">
                    {track.label || `Track ${idx + 1}`}
                  </span>
                  <Badge tone="neutral" className="text-[10px] py-0 px-1.5">
                    Stream {track.streamIndex}:Ch {track.channelIndex}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {track.sampleRate / 1000}kHz • {track.channels === 1 ? "Mono" : "Stereo"}
                  {track.isDialogue ? " • Active Dialogue" : " • Muted / Non-dialogue"}
                </div>
              </div>
            </div>

            <div className="flex w-full sm:w-auto items-center gap-2">
              <label htmlFor={`speaker-${track.id}`} className="text-xs text-muted-foreground shrink-0">
                Speaker:
              </label>
              <input
                id={`speaker-${track.id}`}
                data-testid={`speaker-input-${track.id}`}
                defaultValue={track.speakerLabel ?? ""}
                placeholder={`Speaker ${idx + 1}`}
                onBlur={(e) => {
                  if (e.target.value !== (track.speakerLabel ?? "")) {
                    void handleSpeakerChange(track, e.target.value);
                  }
                }}
                disabled={!track.isDialogue || savingTrackId === track.id}
                className="h-7 w-32 rounded border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
