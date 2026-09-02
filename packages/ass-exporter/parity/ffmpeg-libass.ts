/**
 * Renders one frame of an `.ass` file through ffmpeg's `-vf ass=` (libass)
 * filter and returns straight RGBA pixels — the "third renderer" of the D33
 * parity gate (browser CanvasKit, cloud Skia, `.ass`-via-libass).
 *
 * ffmpeg is required to have been built `--enable-libass` (checked once by
 * `probeLibass`); when it has not, the gate must mark ass parity "not
 * measured" rather than fabricate a score (the brief's explicit rule).
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LibassProbeResult {
  readonly available: boolean;
  readonly reason?: string;
}

function runFfmpeg(
  args: readonly string[],
  timeoutMs = 20_000,
  cwd?: string,
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [...args], { windowsHide: true, ...(cwd === undefined ? {} : { cwd }) });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ffmpeg timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), stderr, code });
    });
  });
}

/** Checks once whether the `ffmpeg` on PATH was built with libass and has the `ass` filter. */
export async function probeLibass(): Promise<LibassProbeResult> {
  try {
    const { stdout, code } = await runFfmpeg(["-hide_banner", "-filters"], 10_000);
    const text = stdout.toString("utf8");
    if (code !== 0) return { available: false, reason: `ffmpeg -filters exited ${String(code)}` };
    if (!/\bass\b.*libass/i.test(text) && !text.includes(" ass ")) {
      return { available: false, reason: "ffmpeg -filters does not list the ass filter" };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Confirms this ffmpeg build's `ass` filter accepts `shaping=complex` and
 * runs to completion on a Devanagari cue (RR-04 F6/F14, D35: "verified
 * against Devanagari/Tamil/Malayalam fixtures before any Indic burn-in
 * ships"). Devanagari uses conjuncts and reordered matras that only the
 * HarfBuzz (`complex`) shaping path handles; `simple`/`auto` can silently
 * render the base consonants with the matras in the wrong order, which is
 * exactly the kind of "technically rendered, wrong" result the parity SLO
 * cannot catch through a byte-identical `.ass` `Text` field — only a real
 * render (`golden-devanagari.test.ts`) can.
 */
export async function probeComplexShaping(): Promise<LibassProbeResult> {
  const probe = await probeLibass();
  if (!probe.available) return probe;
  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 320",
    "PlayResY: 240",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Noto Sans Devanagari,24,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,देवनागरी",
    "",
  ].join("\n");
  try {
    await renderAssFrameToRgba({
      assContent: ass,
      width: 320,
      height: 240,
      background: "#000000ff",
      tMs: 100,
      durationMs: 1000,
      shaping: "complex",
    });
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Escapes a filesystem path for use inside an ffmpeg filtergraph argument (`ass=<path>`). */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function hexToFfmpegColour(hex: string): string {
  const match = /^#([0-9a-fA-F]{6})/.exec(hex);
  return match ? `0x${match[1]}` : "0x000000";
}

export interface RenderAssFrameOptions {
  readonly assContent: string;
  readonly width: number;
  readonly height: number;
  /** `#RRGGBB(AA)`; alpha is ignored — the ground is always opaque. */
  readonly background: string;
  /** Instant, in the `.ass` document's own timeline, to sample. */
  readonly tMs: number;
  readonly durationMs?: number;
  /**
   * RR-04 F6/F14: ffmpeg's `ass`/`subtitles` filter exposes a `shaping`
   * option whose `complex` mode is the HarfBuzz path Devanagari/Tamil need;
   * `auto` is libass's own default and was **not** verified by RR-04. Every
   * Indic render in this gate passes `complex` explicitly rather than trust
   * the default (`probeComplexShaping` is the test that checks the option
   * exists and does not error on this ffmpeg build).
   */
  readonly shaping?: "auto" | "simple" | "complex";
}

/** Renders one instant of an `.ass` document via `ffmpeg -vf ass=` and returns straight RGBA. */
export async function renderAssFrameToRgba(options: RenderAssFrameOptions): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "montaj-ass-parity-"));
  const assPath = join(dir, "cue.ass");
  await writeFile(assPath, options.assContent, "utf8");
  try {
    const durationSec = Math.max(1, (options.durationMs ?? options.tMs + 500) / 1000);
    const seekSec = (options.tMs / 1000).toFixed(3);
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${hexToFfmpegColour(options.background)}:s=${String(options.width)}x${String(
        options.height,
      )}:d=${durationSec.toFixed(3)}`,
      "-ss",
      seekSec,
      "-vf",
      // Run with cwd = the scratch dir and a bare relative filename: Windows
      // drive-letter colons in an absolute path collide with the ass filter's
      // own `:key=value` option separator even when backslash-escaped, so the
      // simplest robust fix is to never put an absolute Windows path in the
      // filtergraph at all.
      options.shaping === undefined ? "ass=cue.ass" : `ass=cue.ass:shaping=${options.shaping}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ];
    const { stdout, stderr, code } = await runFfmpeg(args, 30_000, dir);
    if (code !== 0 || stdout.length !== options.width * options.height * 4) {
      throw new Error(
        `ffmpeg ass render failed (exit ${String(code)}, ${String(stdout.length)} bytes): ${stderr.slice(0, 2000)}`,
      );
    }
    return new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.byteLength);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
