/**
 * Undo/redo as inverse ops (brief §2), grouped by user action.
 *
 * A "user action" is whatever the caller batches into one `record()` call — one
 * `EditWord` for a keystroke, forty for "Replace all". `computeInverseOps` in
 * `ops.ts` does the actual inversion; this module only keeps the two stacks and
 * enforces the 100-step limit.
 */
import type { EdgOp } from "@montaj/edg";

export interface HistoryEntry {
  readonly actionId: string;
  /** The ops as they were submitted. */
  readonly ops: readonly EdgOp[];
  /** Their inverses, in the order that undoes `ops` correctly (generally reversed). */
  readonly inverseOps: readonly EdgOp[];
  /** A short label for a "Undo: merge segments" style affordance. */
  readonly label?: string;
}

export const HISTORY_LIMIT = 100;

export class EditHistory {
  private readonly limit: number;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(limit: number = HISTORY_LIMIT) {
    this.limit = limit;
  }

  /** Push one action. Clears the redo stack — the standard editor rule. */
  record(entry: HistoryEntry): void {
    if (entry.ops.length === 0) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  peekUndo(): HistoryEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  peekRedo(): HistoryEntry | undefined {
    return this.redoStack[this.redoStack.length - 1];
  }

  /** Pops the last action and returns the ops that undo it, or `undefined`. */
  undo(): HistoryEntry | undefined {
    const entry = this.undoStack.pop();
    if (entry === undefined) return undefined;
    this.redoStack.push(entry);
    return entry;
  }

  /** Pops the last undone action and returns its original ops, or `undefined`. */
  redo(): HistoryEntry | undefined {
    const entry = this.redoStack.pop();
    if (entry === undefined) return undefined;
    this.undoStack.push(entry);
    return entry;
  }

  /** For tests and a "history is full" indicator. */
  size(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
