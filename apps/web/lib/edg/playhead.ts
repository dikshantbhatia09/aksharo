/**
 * A minimal, local playhead store.
 *
 * The brief's "Playback link" (§4) reads the current time from "a shared
 * `PlayheadStore`" that A17 (the timeline) drives — A17 has not landed, so
 * there is no shared store to read yet. This is a scaffold, not a
 * substitute: the shape (`getMs`, `seek`, `subscribe`) is what A17's own
 * store is expected to expose, so wiring the real one later is a constructor
 * swap in the editor page, not a rewrite of `TranscriptList` or the keyboard
 * map. Until then it only tracks "where the user last clicked/sought" — it
 * does not drive an actual `<video>` element, because `CaptionStage` (A16)
 * owns its own `<video>` internally and does not expose playback control to
 * a parent (out of this work package's file boundary to add).
 */
export interface PlayheadSnapshot {
  readonly ms: number;
  readonly playing: boolean;
}

export type PlayheadListener = () => void;

export class PlayheadStore {
  private snapshot: PlayheadSnapshot = { ms: 0, playing: false };
  private readonly listeners = new Set<PlayheadListener>();

  getSnapshot = (): PlayheadSnapshot => this.snapshot;

  subscribe = (listener: PlayheadListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  seek(ms: number): void {
    this.set({ ms: Math.max(0, ms), playing: this.snapshot.playing });
  }

  setPlaying(playing: boolean): void {
    this.set({ ms: this.snapshot.ms, playing });
  }

  togglePlaying(): void {
    this.setPlaying(!this.snapshot.playing);
  }

  private set(next: PlayheadSnapshot): void {
    if (next.ms === this.snapshot.ms && next.playing === this.snapshot.playing) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
