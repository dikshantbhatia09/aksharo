/**
 * The editor's transport commander.
 *
 * One clock rule: the `<video>` element is the only clock (it is the only thing
 * that can be frame-accurate, and the caption overlay is already slaved to its
 * `requestVideoFrameCallback`). This store never ticks. It holds *intent* —
 * `playing`, and a seek command — and mirrors the element's actual time back so
 * the timeline marker and the active-segment lookup follow the played frame.
 *
 * `seekSeq` is how the executor (`CaptionStage`) tells a new user seek apart
 * from a mirrored update: `seek()` bumps it, `syncFromMedia()` never does. That
 * one integer is what prevents the mirror path from re-seeking the element it
 * just read (audit FIX-02, 2026-09-04 — the previous version of this file was a
 * scaffold that drove nothing, and Play/Space were dead switches).
 */
export interface PlayheadSnapshot {
  readonly ms: number;
  readonly playing: boolean;
  /** Bumped only by an explicit `seek()`; the executor applies exactly one seek per bump. */
  readonly seekSeq: number;
}

export type PlayheadListener = () => void;

export class PlayheadStore {
  private snapshot: PlayheadSnapshot = { ms: 0, playing: false, seekSeq: 0 };
  private readonly listeners = new Set<PlayheadListener>();

  getSnapshot = (): PlayheadSnapshot => this.snapshot;

  subscribe = (listener: PlayheadListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A user intent: move the playhead. The executor seeks the media element. */
  seek(ms: number): void {
    this.set({
      ms: Math.max(0, ms),
      playing: this.snapshot.playing,
      seekSeq: this.snapshot.seekSeq + 1,
    });
  }

  /** Mirror of the element's actual clock. Never triggers a seek. */
  syncFromMedia(ms: number): void {
    if (ms === this.snapshot.ms) return;
    this.set({ ...this.snapshot, ms });
  }

  setPlaying(playing: boolean): void {
    if (playing === this.snapshot.playing) return;
    this.set({ ...this.snapshot, playing });
  }

  togglePlaying(): void {
    this.setPlaying(!this.snapshot.playing);
  }

  private set(next: PlayheadSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
