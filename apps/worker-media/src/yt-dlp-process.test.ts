import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaJobError } from "./errors.js";
import { runDownloader } from "./yt-dlp.js";

/**
 * The downloader's stops, against real processes.
 *
 * Under a section download yt-dlp starts ffmpeg with `Popen(args,
 * stdin=PIPE)`, so ffmpeg inherits the worker's own stdout and stderr, and on
 * Windows it outlives a kill of the launcher stub. The stand-in here does
 * exactly that: a parent (the downloader) starts a grandchild (ffmpeg) with
 * `stdio: "inherit"` that runs until something kills it. Killing only the
 * parent left the grandchild fetching and the run waiting on pipes that never
 * closed — a stop, a timeout, the size cap and the pace rule alike.
 */

let dir: string;
let grandchild: number | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montaj-kill-test-"));
  grandchild = undefined;
});

afterEach(async () => {
  // Whatever the result, nothing this test started outlives it.
  if (grandchild !== undefined && isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number | undefined, withinMs = 5_000): Promise<boolean> {
  if (pid === undefined) return false;
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

/** A downloader that starts a pipe-holding grandchild, says its pid, then `then`s. */
async function downloader(then: "wait" | "exit"): Promise<string> {
  const child = join(dir, "grandchild.js");
  const parent = join(dir, "parent.js");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own temp directory
  await writeFile(child, "setInterval(() => {}, 1000);\n");
  // On Windows, Node puts every child it spawns in a kill-on-close job, so a
  // grandchild started the ordinary way dies with its parent — which python's
  // Popen, and so ffmpeg, does not. `detached` there leaves it out of the job,
  // as ffmpeg is. Elsewhere it stays in the parent's process group, as ffmpeg
  // does under python.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
  await writeFile(
    parent,
    [
      'const { spawn } = require("node:child_process");',
      `const held = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "inherit", detached: process.platform === "win32" });`,
      'process.stdout.write("grandchild " + String(held.pid) + "\\n");',
      then === "exit"
        ? "setTimeout(() => process.exit(0), 100);"
        : "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return parent;
}

const onLine = (line: string): void => {
  const match = /^grandchild (\d+)/.exec(line);
  if (match !== null) grandchild = Number(match[1]);
};

async function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (error: unknown) => error,
  );
}

describe("runDownloader against a real process tree", () => {
  it("stops the grandchild holding its pipes too, and ends, when it is stopped", async () => {
    const parent = await downloader("wait");
    const stop = new AbortController();
    const started = Date.now();
    const result = await outcome(
      runDownloader(process.execPath, [parent], {
        timeoutMs: 60_000,
        outputPath: join(dir, "source.mp4"),
        maxBytes: 1_000_000_000,
        sizeCheckIntervalMs: 1_000,
        onLine: (line) => {
          onLine(line);
          if (grandchild !== undefined) stop.abort();
        },
        signal: stop.signal,
      }),
    );
    expect(result).toBeInstanceOf(MediaJobError);
    expect(result).toMatchObject({ code: "media/cancelled", retryable: true });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(grandchild).toBeDefined();
    expect(await gone(grandchild)).toBe(true);
  });

  it("stops the whole tree on its time limit, too", async () => {
    const parent = await downloader("wait");
    const result = await outcome(
      runDownloader(process.execPath, [parent], {
        timeoutMs: 1_500,
        outputPath: join(dir, "source.mp4"),
        maxBytes: 1_000_000_000,
        sizeCheckIntervalMs: 1_000,
        onLine,
      }),
    );
    expect(result).toMatchObject({ code: "media/tool_timeout" });
    expect(await gone(grandchild)).toBe(true);
  });

  it("ends when the downloader exits, though something it started still holds the pipes", async () => {
    const parent = await downloader("exit");
    const started = Date.now();
    const result = await outcome(
      runDownloader(process.execPath, [parent], {
        timeoutMs: 60_000,
        outputPath: join(dir, "source.mp4"),
        maxBytes: 1_000_000_000,
        sizeCheckIntervalMs: 1_000,
        onLine,
        drainGraceMs: 500,
      }),
    );
    expect(result).toMatchObject({ code: 0 });
    expect(String((result as { output: string }).output)).toContain("grandchild");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
