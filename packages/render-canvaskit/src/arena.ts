/**
 * CanvasKit hands out WASM-heap objects that must be `delete()`d by hand: a
 * `Paint`, a `Path`, a `Shader` or an `ImageFilter` leaks the heap otherwise,
 * and a preview that leaks a paint per frame runs out of memory in a minute.
 *
 * Every object a frame creates goes into an arena and the whole arena is
 * released when the frame is done, so no code path has to remember to free
 * anything and an exception mid-frame still frees.
 */

export interface Deletable {
  delete(): void;
  isDeleted?(): boolean;
}

export class Arena {
  readonly #owned: Deletable[] = [];

  /** Registers an object and returns it, so it can wrap a constructor call. */
  keep<T extends Deletable>(value: T): T {
    this.#owned.push(value);
    return value;
  }

  get size(): number {
    return this.#owned.length;
  }

  /** Frees everything, newest first. Safe to call twice. */
  release(): void {
    for (let index = this.#owned.length - 1; index >= 0; index -= 1) {
      const value = this.#owned[index];
      if (value === undefined) continue;
      try {
        if (value.isDeleted?.() !== true) value.delete();
      } catch {
        // A double delete must never take a frame down with it.
      }
    }
    this.#owned.length = 0;
  }
}

/** Runs `body` with a fresh arena and releases it however the call ends. */
export function withArena<T>(body: (arena: Arena) => T): T {
  const arena = new Arena();
  try {
    return body(arena);
  } finally {
    arena.release();
  }
}
