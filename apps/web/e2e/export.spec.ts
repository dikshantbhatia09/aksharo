import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { API_ORIGIN, freshAccount, seedEditorProject } from "./editor-fixtures";
import {
  accessTokenFromPage,
  correctFixtureMediaDuration,
  grantTestCredits,
  workspaceIdFromPage,
} from "./export-test-helpers";

/**
 * Chromium: exports a 10-second synthetic clip end to end in the browser —
 * real WebCodecs, a real API-issued signed manifest, `POST
 * /exports/manifests/{id}/complete` accepted, output duration and a sampled
 * frame hash asserted. Runs the pipeline through `/export-harness` (see that
 * page's header) rather than the editor's dialog UI, for the same reason
 * `render-canvaskit`'s own e2e lane uses a static harness: a deterministic
 * driver for a real-browser test, without a second implementation of the
 * pipeline to keep in sync.
 *
 * ## Known test-environment simplification
 *
 * The seeded project's `media_assets` row (`editor-fixtures.ts`) is a
 * database row with no real bytes behind it — there is no proxy transcode
 * pipeline available in this harness (A06/A07 media pipeline is out of this
 * work package's scope). The manifest and its HMAC signature are entirely
 * real, issued by the real API's decision engine; only the video *bytes* are
 * a locally generated fixture MP4 served from this app's own `public/`
 * directory, standing in for the signed proxy URL `resolveSourceUrl` would
 * otherwise fetch. This is reported as a limitation in the final report.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "e2e-fixtures");
const FIXTURE_PATH = join(FIXTURE_DIR, "export-sample.mp4");
const FIXTURE_SECONDS = 10;

function ensureFixtureVideo(): void {
  if (existsSync(FIXTURE_PATH)) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  // A 10 s, 1080x1920, 30fps H.264+AAC clip with a moving colour field (so a
  // frame hash is meaningful) and a 440Hz tone — generated with ffmpeg
  // (available on the CI/dev machine per the setup instructions), not checked
  // into the repository.
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=1080x1920:rate=30:duration=${String(FIXTURE_SECONDS)}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${String(FIXTURE_SECONDS)}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    FIXTURE_PATH,
  ]);
}

function ffprobe(args: string[]): string {
  return execFileSync("ffprobe", args, { encoding: "utf-8" });
}

test.describe("browser export (chromium)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "WebCodecs export runs on chromium only",
  );

  test("exports a 10s clip to a valid MP4 with duration and a real signed manifest", async ({
    page,
    browser,
  }) => {
    ensureFixtureVideo();

    // `freshAccount` signs in on whatever page it is given (`signUpAndVerify`
    // ends with a real login). Doing that in a wholly separate browser
    // *context* — not merely a second page in the same context, which still
    // shares cookies — mirrors how `editor.spec.ts`'s `sharedAccount` fixture
    // keeps sign-up separate from the page under test: `page` must still be
    // signed out when `seedEditorProject` calls `signIn` on it, or `/login`
    // redirects straight past the form it is waiting for.
    const setupContext = await browser.newContext();
    const setupPage = await setupContext.newPage();
    const account = await freshAccount(setupPage, "export-e2e");
    const workspaceId = await workspaceIdFromPage(setupPage);
    await grantTestCredits(workspaceId);
    await setupContext.close();

    const { projectId } = await seedEditorProject(page, account, { title: "A19 export e2e" });
    // `editor-fixtures.ts`'s `insertProbedMedia` (shared, out of this WP's file
    // boundary) always writes a fictitious 90s duration — fine for the specs
    // that only need *a* probed media row, wrong here where the manifest's
    // `timemap.sourceDurationMs` has to match the real ~10s fixture MP4 this
    // test serves. Corrected by SQL, confined to this test file, the same
    // "one non-HTTP step" convention `insertProbedMedia` itself uses.
    await correctFixtureMediaDuration(projectId, FIXTURE_SECONDS * 1000);

    await page.goto(`/export-harness?projectId=${projectId}`);
    await page.waitForFunction(() => window.__exportHarness?.ready === true, undefined, {
      timeout: 60_000,
    });

    const manifestResponse = await page.request.post(
      `${API_ORIGIN}/projects/${projectId}/exports`,
      {
        headers: {
          Authorization: `Bearer ${await accessTokenFromPage(page)}`,
          "content-type": "application/json",
        },
        data: { kind: "video", preset: "reels", mode: "auto" },
      },
    );
    expect(manifestResponse.ok(), await manifestResponse.text()).toBe(true);
    const decision = (await manifestResponse.json()) as {
      path: "browser" | "cloud";
      watermarked: boolean;
      manifest?: Record<string, unknown>;
    };

    test.info().annotations.push({ type: "export-path", description: decision.path });
    expect(decision.path, "a fresh, ≤10-minute browser export should be eligible").toBe("browser");
    expect(decision.watermarked, "a fresh account's signup gift clears the watermark").toBe(false);
    expect(decision.manifest).toBeDefined();

    const fixtureUrl = "/e2e-fixtures/export-sample.mp4";

    const result = await page.evaluate(
      async ({ manifest, sourceUrl }) => {
        const harness = window.__exportHarness;
        if (harness === undefined) throw new Error("harness not ready");
        const controller = new AbortController();
        const progressEvents: unknown[] = [];
        const engineResult = await harness.runExport({
          manifest: manifest as never,
          source: sourceUrl,
          projection: harness.projection,
          catalogue: harness.catalogue,
          registry: harness.registry,
          shaper: harness.shaper,
          signal: controller.signal,
          aacEncodable: true,
          aacPolyfillAvailable: false,
          preferFileSystemAccess: false,
          onProgress: (p) => progressEvents.push(p),
        });
        const bytes = new Uint8Array(await engineResult.blob!.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
        return {
          sizeBytes: engineResult.sizeBytes,
          durationMs: engineResult.durationMs,
          checksum: engineResult.checksum,
          progressEvents: progressEvents.length,
          base64: btoa(binary),
        };
      },
      { manifest: decision.manifest, sourceUrl: fixtureUrl },
    );

    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.progressEvents).toBeGreaterThan(0);

    // Write the produced MP4 out and verify it with real ffprobe/ffmpeg,
    // exactly as the brief's acceptance criterion asks: duration, and a
    // sampled frame's hash. This is *not* a parity check against
    // render-skia-node's fixtures (see the final report's open question) —
    // it proves the browser pipeline produced a real, decodable MP4 with the
    // right length and a non-trivial burned-in frame, nothing more.
    const outDir = mkdtempSync(join(tmpdir(), "aksharo-export-e2e-"));
    const outPath = join(outDir, "output.mp4");
    writeFileSync(outPath, Buffer.from(result.base64, "base64"));

    const probeJson = ffprobe([
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,codec_type",
      "-of",
      "json",
      outPath,
    ]);
    const probed = JSON.parse(probeJson) as {
      format: { duration: string };
      streams: { codec_name: string; codec_type: string }[];
    };
    const probedDurationMs = Number(probed.format.duration) * 1000;
    expect(probedDurationMs).toBeGreaterThan(9_000);
    expect(probedDurationMs).toBeLessThan(11_000);
    expect(probed.streams.some((s) => s.codec_type === "video" && s.codec_name === "h264")).toBe(
      true,
    );

    const framePath = join(outDir, "frame.png");
    execFileSync("ffmpeg", ["-y", "-ss", "2", "-i", outPath, "-frames:v", "1", framePath]);
    const frameHash = createHash("sha256").update(readFileSync(framePath)).digest("hex");
    expect(frameHash).toMatch(/^[0-9a-f]{64}$/);
    test.info().annotations.push({ type: "sampled-frame-sha256", description: frameHash });

    // The manifest's own timemap has no accepted cuts for a freshly seeded
    // project, so output duration should track the fixture's own length.
    expect(result.durationMs).toBeGreaterThan(9_000);
    expect(result.durationMs).toBeLessThan(11_000);

    const manifestId = (decision.manifest as { manifestId: string }).manifestId;
    const completeResponse = await page.request.post(
      `${API_ORIGIN}/exports/manifests/${manifestId}/complete`,
      {
        headers: {
          Authorization: `Bearer ${await accessTokenFromPage(page)}`,
          "content-type": "application/json",
        },
        data: {
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
          checksum: result.checksum,
        },
      },
    );
    expect(completeResponse.ok(), await completeResponse.text()).toBe(true);
    const completion = (await completeResponse.json()) as { status: string };
    expect(completion.status).toBe("succeeded");
  });
});
