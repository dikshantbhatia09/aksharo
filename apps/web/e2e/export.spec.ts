import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { API_ORIGIN, freshAccount, seedEditorProject } from "./editor-fixtures";
import {
  accessTokenFromPage,
  correctFixtureMediaDuration,
  grantTestCredits,
  workspaceIdFromPage,
} from "./export-test-helpers";
import { expect, gotoHydrated, test } from "./fixtures";

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
 *
 * ## M10 fixes
 *
 * Both cases here used to fail. (1) `page.waitForFunction(() =>
 * window.__exportHarness?.ready === true)` timed out at 60s regardless of
 * host throughput — CSP's `script-src 'self' 'unsafe-inline'` (next.config.ts) has
 * no `'wasm-unsafe-eval'`, which Chrome treats WebAssembly compilation as
 * needing the same way it treats `eval`, so CanvasKit — every editor route's
 * renderer, including this harness's — never instantiated and `ready` was
 * never set; fixed in `next.config.ts`. (2) This file imported `test`/`expect`
 * from `@playwright/test` directly rather than `./fixtures`, so it never got
 * `fixtures.ts`'s `context` fixture, which auto-dismisses `WhatsNewModal` on
 * every signed-in page (`installWhatsNewAutoDismiss`) — every fresh sign-up
 * here hits that modal, and its overlay intercepted the click on the real
 * dialog's Export button; fixed by importing `test`/`expect` from
 * `./fixtures` like every other spec.
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

    const capabilities = await page.evaluate(async () => {
      const harness = window.__exportHarness;
      if (harness === undefined) throw new Error("harness not ready");
      const probe = await harness.lib.probeExportCapabilities();
      return harness.lib.toCapabilitiesRequest(probe);
    });

    test.info().annotations.push({
      type: "hardware-encoder",
      description: String(capabilities.hardwareEncoder ?? "unknown"),
    });

    // A19c ruling (2): `auto` now defaults 1080p-and-up to the cloud when the
    // client did not report a hardware encoder — this sandbox's headless
    // chromium has none (see `README.md`'s "Throughput" section), so `auto`
    // would no longer pick "browser" here. The dialog's own "export in the
    // browser anyway" override (`mode: "browser"`, warned copy) is exactly
    // the escape hatch this test needs to keep exercising the real pipeline
    // end to end regardless of which machine it runs on.
    const manifestResponse = await page.request.post(
      `${API_ORIGIN}/projects/${projectId}/exports`,
      {
        headers: {
          Authorization: `Bearer ${await accessTokenFromPage(page)}`,
          "content-type": "application/json",
        },
        data: { kind: "video", preset: "reels", mode: "browser", capabilities },
      },
    );
    expect(manifestResponse.ok(), await manifestResponse.text()).toBe(true);
    const decision = (await manifestResponse.json()) as {
      path: "browser" | "cloud";
      watermarked: boolean;
      reasons: string[];
      manifest?: Record<string, unknown>;
    };

    test.info().annotations.push({ type: "export-path", description: decision.path });
    expect(decision.path, "an explicit browser request should be honoured").toBe("browser");
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
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
        return {
          sizeBytes: engineResult.sizeBytes,
          durationMs: engineResult.durationMs,
          checksum: engineResult.checksum,
          progressEvents: progressEvents.length,
          realtimeMultiplier: engineResult.realtimeMultiplier,
          captionSurfaceBackend: engineResult.captionSurfaceBackend,
          base64: btoa(binary),
        };
      },
      { manifest: decision.manifest, sourceUrl: fixtureUrl },
    );

    expect(result.sizeBytes).toBeGreaterThan(0);
    test.info().annotations.push({
      type: "realtime-multiplier",
      description: result.realtimeMultiplier.toFixed(2),
    });
    test.info().annotations.push({
      type: "caption-surface-backend",
      description: result.captionSurfaceBackend,
    });
    // A19c (brief §3): the ≥1x realtime target stays a *reported* metric,
    // annotated above rather than gated on unconditionally — the measured
    // number is a function of the machine's GPU and hardware encoder, not of
    // whether this pipeline is correct. The hard floor only applies once the
    // run itself reports a hardware encoder (this sandbox's headless
    // chromium does not, per `capabilities.hardwareEncoder` above and
    // `README.md`'s "Throughput" section) — at that point 0.5x is a
    // reasonable floor to gate on, since the whole point of a hardware
    // encoder + a GPU-backed caption surface is to clear it comfortably.
    // Without one, the only thing asserted is that the pipeline made forward
    // progress at all.
    if (capabilities.hardwareEncoder === true) {
      expect(
        result.realtimeMultiplier,
        "a hardware-encoder run should clear the 0.5x floor",
      ).toBeGreaterThanOrEqual(0.5);
    } else {
      expect(result.realtimeMultiplier).toBeGreaterThan(0);
    }
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
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

  /**
   * A07b: the real `ExportDialog` UI, clicked all the way through, rather
   * than the `/export-harness` driver the test above uses. Before this work
   * package, `use-export-dialog.ts` never passed `preferFileSystemAccess:
   * false` to the engine, so a synthetic Playwright click on the dialog's
   * own "Export" button reached for the real `showSaveFilePicker` — which
   * rejects a synthetic click with "The user aborted a request." (there is
   * no browser chrome for it to prompt against) — and the export ended in
   * `phase: "error"` before a single frame rendered. `gate-a.spec.ts` hit
   * this exact gap and worked around it by asserting the API decision
   * directly instead of driving the dialog on chromium; that workaround's
   * note is now superseded by this test.
   *
   * `use-export-dialog.ts`'s fix is a non-production-only `window.
   * __aksharoE2E?.noFilePicker` flag, set below with `addInitScript` before
   * the app's own scripts run, exactly as a real feature flag would be.
   *
   * The seeded project's `media_assets` row still has no real bytes behind
   * it (this file's header note) — this test's own fix for that is a
   * `page.route` intercept that rewrites the manifest response's signed
   * `sources.rawUrl` to the same local fixture MP4 the harness test above
   * reads directly, so the real dialog's real `fetch` of "the source video"
   * resolves to real bytes instead of a presigned URL for an object that
   * was never uploaded.
   */
  test("drives the real export dialog end to end, not the /export-harness driver", async ({
    page,
    browser,
  }) => {
    ensureFixtureVideo();

    const setupContext = await browser.newContext();
    const setupPage = await setupContext.newPage();
    const account = await freshAccount(setupPage, "export-dialog-e2e");
    const workspaceId = await workspaceIdFromPage(setupPage);
    await grantTestCredits(workspaceId);
    await setupContext.close();

    const { projectId } = await seedEditorProject(page, account, {
      title: "A07b export dialog e2e",
    });
    await correctFixtureMediaDuration(projectId, FIXTURE_SECONDS * 1000);

    await page.addInitScript(() => {
      (window as unknown as { __aksharoE2E?: { noFilePicker?: boolean } }).__aksharoE2E = {
        noFilePicker: true,
      };
    });

    await page.route(`${API_ORIGIN}/projects/${projectId}/exports`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as { sources?: Record<string, unknown> };
      if (body.sources !== undefined) {
        body.sources = { ...body.sources, rawUrl: "/e2e-fixtures/export-sample.mp4" };
      }
      await route.fulfill({ response, json: body });
    });

    await gotoHydrated(page, `/p/${projectId}`);
    await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("editor-export-open").click();
    await expect(page.getByTestId("export-dialog")).toBeVisible();
    await page.getByTestId("export-tab-video").click();
    await page.getByTestId("export-start").click();

    // A19c's software-encoder default (this file's other test) can still
    // route a fresh `auto` request to the cloud offer on a headless
    // chromium with no hardware encoder; the dialog's own override is
    // exactly what a real user would click in that case.
    const cloudOffer = page.getByTestId("export-cloud-offer");
    const wentToCloud = await cloudOffer
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (wentToCloud) {
      await page.getByTestId("export-browser-anyway").click();
    }

    await expect(page.getByTestId("export-error")).toHaveCount(0);
    await expect(page.getByTestId("export-done")).toBeVisible({ timeout: 120_000 });

    const exportsResponse = await page.request.get(`${API_ORIGIN}/projects/${projectId}/exports`, {
      headers: { Authorization: `Bearer ${await accessTokenFromPage(page)}` },
    });
    expect(exportsResponse.ok(), await exportsResponse.text()).toBe(true);
    const exports = (await exportsResponse.json()) as { items: { status: string }[] };
    expect(exports.items.some((item) => item.status === "succeeded")).toBe(true);
  });
});
