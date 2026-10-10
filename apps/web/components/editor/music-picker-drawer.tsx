"use client";

import {
  Check,
  Disc3,
  Loader2,
  Music,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Sliders,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import * as React from "react";

import { Badge, Button, cn } from "@montaj/ui";

export interface MusicTrackItem {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly mood: string;
  readonly tempo: string;
  readonly bpm: number | null;
  readonly durationSec: number;
  readonly previewUri: string;
  readonly masterUri: string;
  readonly waveform: readonly number[];
  readonly isPublic: boolean;
}

export interface MusicPickerDrawerProps {
  readonly projectId?: string;
  readonly clipId?: string;
  readonly appliedTrackId?: string | null;
  readonly appliedVolume?: number;
  readonly onSelectTrack?: (track: MusicTrackItem | null, volume: number) => void;
  readonly className?: string;
}

const MOODS = [
  "ALL",
  "ENERGETIC",
  "CHILL",
  "DRAMATIC",
  "CORPORATE",
  "INSPIRATIONAL",
  "MYSTERIOUS",
] as const;

const TEMPOS = ["ALL", "SLOW", "MEDIUM", "FAST"] as const;

// Fallback curated seed tracks for instant preview and offline resilience
const FALLBACK_TRACKS: readonly MusicTrackItem[] = [
  {
    id: "track-eng-001",
    title: "Tech Cyber Pulse",
    artist: "Aksharo Originals",
    mood: "ENERGETIC",
    tempo: "FAST",
    bpm: 128,
    durationSec: 154,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/tech-cyber-pulse.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/tech-cyber-pulse.wav",
    waveform: [0.1, 0.4, 0.7, 0.9, 0.6, 0.8, 0.95, 0.5, 0.3, 0.7, 0.85, 0.6, 0.4, 0.8, 0.9],
    isPublic: true,
  },
  {
    id: "track-chl-001",
    title: "Coffee & Code Lo-Fi",
    artist: "Aksharo Originals",
    mood: "CHILL",
    tempo: "SLOW",
    bpm: 78,
    durationSec: 180,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/coffee-and-code-lofi.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/coffee-and-code-lofi.wav",
    waveform: [0.2, 0.3, 0.5, 0.6, 0.4, 0.5, 0.6, 0.4, 0.3, 0.5, 0.4, 0.3, 0.2, 0.4, 0.5],
    isPublic: true,
  },
  {
    id: "track-drm-001",
    title: "Cinematic Piano Melancholy",
    artist: "Aksharo Originals",
    mood: "DRAMATIC",
    tempo: "SLOW",
    bpm: 68,
    durationSec: 190,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/cinematic-piano-melancholy.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/cinematic-piano-melancholy.wav",
    waveform: [0.08, 0.15, 0.4, 0.7, 0.85, 0.9, 0.7, 0.5, 0.3, 0.6, 0.8, 0.5, 0.3, 0.2, 0.1],
    isPublic: true,
  },
  {
    id: "track-crp-001",
    title: "Silicon Valley Optimism",
    artist: "Aksharo Originals",
    mood: "CORPORATE",
    tempo: "MEDIUM",
    bpm: 110,
    durationSec: 135,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/silicon-valley-optimism.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/silicon-valley-optimism.wav",
    waveform: [0.15, 0.3, 0.6, 0.75, 0.5, 0.65, 0.8, 0.7, 0.45, 0.6, 0.7, 0.5, 0.35, 0.5, 0.6],
    isPublic: true,
  },
  {
    id: "track-ins-001",
    title: "Sunrise Over The Peaks",
    artist: "Aksharo Originals",
    mood: "INSPIRATIONAL",
    tempo: "MEDIUM",
    bpm: 98,
    durationSec: 162,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/sunrise-over-the-peaks.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/sunrise-over-the-peaks.wav",
    waveform: [0.1, 0.25, 0.5, 0.8, 0.9, 0.95, 0.85, 0.6, 0.4, 0.7, 0.85, 0.9, 0.6, 0.4, 0.2],
    isPublic: true,
  },
  {
    id: "track-mys-001",
    title: "Subterranean Whispers",
    artist: "Aksharo Originals",
    mood: "MYSTERIOUS",
    tempo: "SLOW",
    bpm: 70,
    durationSec: 170,
    previewUri: "https://cdn.aksharo.com/audio/music/previews/subterranean-whispers.mp3",
    masterUri: "https://cdn.aksharo.com/audio/music/masters/subterranean-whispers.wav",
    waveform: [0.05, 0.1, 0.3, 0.6, 0.7, 0.5, 0.4, 0.65, 0.8, 0.6, 0.4, 0.3, 0.5, 0.3, 0.1],
    isPublic: true,
  },
];

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins)}:${secs < 10 ? "0" : ""}${String(secs)}`;
}

function volumeToDbfs(volume: number): string {
  if (volume <= 0.001) return "-∞ dBFS";
  // Maps 0.15 volume roughly to -20 dBFS standard broadcast level
  const db = 20 * Math.log10(volume / 0.15) - 20;
  return `${Math.round(db)} dBFS`;
}

export function MusicPickerDrawer({
  projectId,
  clipId,
  appliedTrackId,
  appliedVolume = 0.15,
  onSelectTrack,
  className,
}: MusicPickerDrawerProps): React.JSX.Element {
  const [tracks, setTracks] = React.useState<readonly MusicTrackItem[]>(FALLBACK_TRACKS);
  const [loading, setLoading] = React.useState(false);
  const [selectedMood, setSelectedMood] = React.useState<string>("ALL");
  const [selectedTempo, setSelectedTempo] = React.useState<string>("ALL");
  const [searchQuery, setSearchQuery] = React.useState("");

  // Music volume slider: 0.0 to 1.0 (default 0.15 = -20 dBFS bed)
  const [volume, setVolume] = React.useState<number>(appliedVolume);
  const [activeTrackId, setActiveTrackId] = React.useState<string | null>(appliedTrackId ?? null);

  // Audio playback state
  const [playingTrackId, setPlayingTrackId] = React.useState<string | null>(null);
  const [playbackProgress, setPlaybackProgress] = React.useState<number>(0);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  // Fetch tracks from API
  React.useEffect(() => {
    let active = true;
    async function loadTracks(): Promise<void> {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (selectedMood !== "ALL") params.set("mood", selectedMood);
        if (selectedTempo !== "ALL") params.set("tempo", selectedTempo);
        if (searchQuery.trim() !== "") params.set("search", searchQuery.trim());
        params.set("limit", "50");

        const res = await fetch(`/api/v1/audio/music?${params.toString()}`);
        if (res.ok) {
          const data = (await res.json()) as { tracks: MusicTrackItem[] };
          if (active && Array.isArray(data.tracks) && data.tracks.length > 0) {
            setTracks(data.tracks);
          }
        }
      } catch {
        // Fallback tracks stay active
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadTracks();
    return () => {
      active = false;
    };
  }, [selectedMood, selectedTempo, searchQuery]);

  // Handle track audition playback
  const togglePlay = React.useCallback(
    (track: MusicTrackItem) => {
      if (playingTrackId === track.id) {
        if (audioRef.current) {
          audioRef.current.pause();
        }
        setPlayingTrackId(null);
        setPlaybackProgress(0);
      } else {
        if (audioRef.current) {
          audioRef.current.pause();
        }
        const audio = new Audio(track.previewUri);
        audio.volume = Math.max(0.05, Math.min(1, volume * 1.5)); // Slightly louder for preview
        audio.ontimeupdate = () => {
          if (audio.duration > 0) {
            setPlaybackProgress(audio.currentTime / audio.duration);
          }
        };
        audio.onended = () => {
          setPlayingTrackId(null);
          setPlaybackProgress(0);
        };
        audio.onerror = () => {
          setPlayingTrackId(null);
          setPlaybackProgress(0);
        };
        void audio.play().catch(() => {
          // Autoplay policy fallback
          setPlayingTrackId(null);
        });
        audioRef.current = audio;
        setPlayingTrackId(track.id);
      }
    },
    [playingTrackId, volume],
  );

  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Handle track selection / application
  const handleSelectTrack = React.useCallback(
    async (track: MusicTrackItem | null) => {
      const nextId = track ? track.id : null;
      setActiveTrackId(nextId);
      onSelectTrack?.(track, volume);

      // Persist to backend if clipId or projectId is present
      if (clipId) {
        try {
          await fetch(`/api/v1/projects/${projectId ?? "default"}/clips/${clipId}/music`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              musicTrackId: nextId,
              musicVolume: volume,
            }),
          });
        } catch {
          // Optimistic local state remains
        }
      }
    },
    [clipId, onSelectTrack, projectId, volume],
  );

  // Handle volume change
  const handleVolumeChange = React.useCallback(
    (newVolume: number) => {
      setVolume(newVolume);
      if (audioRef.current) {
        audioRef.current.volume = Math.max(0.05, Math.min(1, newVolume * 1.5));
      }
      if (activeTrackId) {
        const activeTrack = tracks.find((t) => t.id === activeTrackId) ?? null;
        onSelectTrack?.(activeTrack, newVolume);
      }
    },
    [activeTrackId, onSelectTrack, tracks],
  );

  const appliedTrack = tracks.find((t) => t.id === activeTrackId);

  return (
    <div
      className={cn("flex h-full min-w-0 flex-col bg-bg-1 text-fg-0 overflow-hidden", className)}
      data-testid="music-picker-drawer"
    >
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Music className="size-4 text-accent" />
            <h2 className="text-sm font-semibold tracking-tight">Royalty-Free Music</h2>
          </div>
          <span className="flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-2xs text-emerald-400">
            <ShieldCheck className="size-3" />
            <span>Commercial-Safe</span>
          </span>
        </div>
        <p className="mt-1 text-2xs text-fg-2">
          Commercially cleared background music tracks with automatic dialogue ducking.
        </p>

        {/* Search input */}
        <div className="relative mt-2.5">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-2" />
          <input
            type="text"
            placeholder="Search by title, artist, mood..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-sm border border-border bg-bg-0 py-1.5 pr-3 pl-8 text-xs text-fg-0 placeholder:text-fg-2/60 focus:border-accent focus:outline-none"
            data-testid="music-search-input"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-2 hover:text-fg-0"
              aria-label="Clear search"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>

        {/* Mood filter pills */}
        <div className="mt-2.5 flex flex-wrap gap-1" data-testid="music-mood-pills">
          {MOODS.map((mood) => {
            const isSelected = selectedMood === mood;
            return (
              <button
                key={mood}
                type="button"
                onClick={() => setSelectedMood(mood)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-3xs font-medium uppercase tracking-wider transition-colors",
                  isSelected
                    ? "bg-accent text-accent-fg shadow-xs"
                    : "border border-border/60 bg-bg-2/50 text-fg-2 hover:border-fg-2/40 hover:text-fg-0",
                )}
                data-testid={`mood-pill-${mood.toLowerCase()}`}
              >
                {mood}
              </button>
            );
          })}
        </div>

        {/* Tempo filter */}
        <div className="mt-2 flex items-center justify-between text-2xs text-fg-2">
          <span className="font-medium">Tempo:</span>
          <div className="flex gap-1" data-testid="music-tempo-pills">
            {TEMPOS.map((tempo) => {
              const isSelected = selectedTempo === tempo;
              return (
                <button
                  key={tempo}
                  type="button"
                  onClick={() => setSelectedTempo(tempo)}
                  className={cn(
                    "rounded-xs px-2 py-0.5 text-3xs transition-colors",
                    isSelected
                      ? "bg-neutral-100/15 font-semibold text-fg-0"
                      : "text-fg-2 hover:text-fg-0",
                  )}
                  data-testid={`tempo-pill-${tempo.toLowerCase()}`}
                >
                  {tempo}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Applied Track & Volume Attenuation Control Bar */}
      {activeTrackId && appliedTrack ? (
        <div
          className="shrink-0 border-b border-border/60 bg-bg-2/40 px-4 py-2.5"
          data-testid="applied-music-bar"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Disc3 className="size-3.5 animate-spin text-accent" />
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-fg-0">{appliedTrack.title}</div>
                <div className="text-3xs text-fg-2">{appliedTrack.artist}</div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleSelectTrack(null)}
              className="h-6 px-1.5 text-2xs text-fg-2 hover:text-destructive"
              title="Remove background music"
              data-testid="remove-music-btn"
            >
              <X className="size-3.5 mr-1" />
              Remove
            </Button>
          </div>

          {/* Volume Attenuation Slider */}
          <div className="mt-2.5">
            <div className="flex items-center justify-between text-2xs">
              <span className="flex items-center gap-1 text-fg-2">
                {volume === 0 ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
                <span>Music Volume: {Math.round(volume * 100)}%</span>
              </span>
              <span className="text-accent font-mono text-3xs">
                {volumeToDbfs(volume)} (Auto-Ducked)
              </span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              className="mt-1 w-full accent-[var(--accent,#ec4899)] cursor-pointer h-1.5 rounded-full bg-border"
              data-testid="music-volume-slider"
              aria-label="Background music volume"
            />
          </div>
        </div>
      ) : null}

      {/* Track List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5" data-testid="music-track-list">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-xs text-fg-2">
            <Loader2 className="mr-2 size-4 animate-spin text-accent" />
            Loading music catalog...
          </div>
        ) : tracks.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center text-center text-xs text-fg-2">
            <Sliders className="mb-2 size-6 opacity-40" />
            No tracks match the selected filters.
          </div>
        ) : (
          tracks.map((track) => {
            const isPlaying = playingTrackId === track.id;
            const isApplied = activeTrackId === track.id;

            return (
              <div
                key={track.id}
                className={cn(
                  "group relative flex flex-col rounded-sm border p-2.5 transition-all",
                  isApplied
                    ? "border-accent/40 bg-accent/5 shadow-xs"
                    : "border-border/40 bg-bg-0 hover:border-border hover:bg-bg-2/30",
                )}
                data-testid={`music-track-item-${track.id}`}
              >
                <div className="flex items-center justify-between gap-3">
                  {/* Play / Pause Audition Button */}
                  <button
                    type="button"
                    onClick={() => togglePlay(track)}
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95",
                      isPlaying
                        ? "bg-accent text-accent-fg shadow-sm"
                        : "bg-bg-2 text-fg-1 hover:bg-accent/20 hover:text-fg-0",
                    )}
                    aria-label={isPlaying ? "Pause preview" : "Play preview"}
                    data-testid={`play-btn-${track.id}`}
                  >
                    {isPlaying ? (
                      <Pause className="size-3.5" />
                    ) : (
                      <Play className="size-3.5 translate-x-0.5" />
                    )}
                  </button>

                  {/* Track Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold text-fg-0">
                        {track.title}
                      </span>
                      {isApplied ? (
                        <span className="rounded bg-accent px-1 py-0.2 text-3xs font-medium uppercase text-accent-fg">
                          Active
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-3xs text-fg-2">
                      <span>{track.artist}</span>
                      <span>•</span>
                      <span className="rounded bg-bg-2 px-1 py-0.2 font-mono uppercase">
                        {track.mood}
                      </span>
                      <span>•</span>
                      <span>{track.bpm ? `${String(track.bpm)} BPM` : track.tempo}</span>
                      <span>•</span>
                      <span>{formatDuration(track.durationSec)}</span>
                    </div>
                  </div>

                  {/* 1-Click Apply Button */}
                  <Button
                    variant={isApplied ? "outline" : "secondary"}
                    size="sm"
                    onClick={() => handleSelectTrack(isApplied ? null : track)}
                    className={cn(
                      "h-7 shrink-0 text-2xs px-2.5",
                      isApplied
                        ? "border-accent/50 text-accent hover:bg-destructive/10 hover:text-destructive"
                        : "bg-bg-2 text-fg-0 hover:bg-accent hover:text-accent-fg",
                    )}
                    data-testid={`apply-btn-${track.id}`}
                  >
                    {isApplied ? (
                      <>
                        <Check className="size-3 mr-1" />
                        Selected
                      </>
                    ) : (
                      "Apply"
                    )}
                  </Button>
                </div>

                {/* Waveform Visualizer Bar */}
                <div className="mt-2 flex h-4 items-center gap-0.5 px-0.5">
                  {(track.waveform.length > 0 ? track.waveform : [0.2, 0.4, 0.7, 0.3, 0.5]).map(
                    (peak, idx, arr) => {
                      const barProgress = idx / arr.length;
                      const hasPlayed = isPlaying && playbackProgress >= barProgress;
                      const heightPercent = Math.max(15, Math.min(100, peak * 100));

                      return (
                        <div
                          key={idx}
                          className={cn(
                            "flex-1 rounded-full transition-colors duration-100",
                            hasPlayed
                              ? "bg-accent"
                              : isApplied
                                ? "bg-accent/30"
                                : "bg-neutral-100/20 group-hover:bg-neutral-100/30",
                          )}
                          style={{ height: `${String(heightPercent)}%` }}
                        />
                      );
                    },
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Info */}
      <div className="shrink-0 border-t border-border/40 p-2.5 text-center text-3xs text-fg-2">
        <span>Licensed under Creative Commons Zero / Aksharo Commercial Clearance.</span>
      </div>
    </div>
  );
}
