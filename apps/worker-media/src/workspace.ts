import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logger } from "./logger.js";

/**
 * One job's scratch directory, and the guarantee that it goes away.
 *
 * The worker never copies the *source* to disk — ffmpeg reads it through a signed
 * URL, which is what keeps a 4K sixty-minute file off the media node entirely.
 * What does need a file is every **output**: `proxy540.mp4` needs `+faststart`,
 * which rewrites the moov atom at the end and therefore needs a seekable
 * destination, and the WAVs need a header patched with their final length. Those
 * are the only things in here.
 *
 * `withWorkspace` is the whole discipline: the directory is removed in a `finally`,
 * so a throw, a timeout and a clean run all leave the same nothing behind. A
 * worker that leaks one directory per failed job fills its disk in a day, and the
 * failing jobs are exactly the ones that repeat.
 */
export interface Workspace {
  /** Absolute path to the directory. */
  readonly dir: string;
  /** A path inside it. Names come from this module, never from a payload. */
  path(name: string): string;
  /** Size of a file in the workspace, in bytes. */
  size(name: string): Promise<number>;
}

/**
 * Run `fn` with a fresh scratch directory, and delete it afterwards no matter what.
 *
 * @param prefix short label that ends up in the directory name, for an operator
 *   looking at `/tmp` while a job is running.
 */
export async function withWorkspace<T>(
  prefix: string,
  root: string | undefined,
  fn: (workspace: Workspace) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(root ?? tmpdir(), `montaj-${prefix}-`));
  const workspace: Workspace = {
    dir,
    path: (name: string) => join(dir, name),
    size: async (name: string) => (await stat(join(dir, name))).size,
  };

  try {
    return await fn(workspace);
  } finally {
    // Best effort by design: on Windows a virus scanner can still hold a handle to
    // a file ffmpeg has just closed, and failing a job that succeeded because a
    // temporary directory outlived it by a second would be absurd. The leak is
    // visible in the logs and the next boot's OS sweep takes it.
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn("temp directory not removed", {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
