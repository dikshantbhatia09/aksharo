/**
 * An in-memory ring buffer of the app's own recent log lines, so a crash
 * report can attach "the last 50 log lines" (brief §1) without reading a log
 * file from disk (which may not have flushed yet at the moment of a crash).
 */
export interface LogRingBuffer {
  push(line: string): void;
  /** Every retained line, oldest first. */
  lines(): string[];
}

const DEFAULT_CAPACITY = 500;

export function createLogRingBuffer(capacity: number = DEFAULT_CAPACITY): LogRingBuffer {
  const buffer: string[] = [];
  return {
    push(line) {
      buffer.push(line);
      if (buffer.length > capacity) buffer.shift();
    },
    lines() {
      return [...buffer];
    },
  };
}
