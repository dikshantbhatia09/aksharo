import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRepoEnv } from "./env";
import { API_ORIGIN, expect, expectNoSeriousA11yViolations, gotoHydrated, test } from "./fixtures";
import { completeJobForTest } from "./internal-callback";

import type { Page } from "@playwright/test";

const env = loadRepoEnv();

/**
 * Gate A (`docs/PLAN.md`'s gate definition): a new user captions a Hinglish
 * sample end to end in the browser, cloud render works, and (elsewhere) the
 * parity gate and X02 load harness are green. This is the one journey test —
 * sign-up through reload persistence, on both browsers per `playwright.
 * config.ts`'s two projects.
 *
 * ## Test-environment simplifications (same convention as `upload.spec.ts` /
 * `editor-fixtures.ts`, carried forward here rather than reinvented)
 *
 * `apps/worker-media` and `apps/worker-ai` are not running against this
 * suite's own API instance (their Docker images exist — A07/A10 — but
 * `playwright.config.ts` boots only `api` and `web` as local processes for
 * speed). Every job a real worker would pick up is instead settled through
 * the signed internal completion callback (CONTRACTS §3) — the same "API-
 * side test hook" the brief allows in place of a running worker. The upload
 * itself is real: a real multipart PUT against the real MinIO behind
 * `S3_ENDPOINT`.
 */

/**
 * A real, tiny, vertical MP4 (ffmpeg testsrc + sine) — the "sample media"
 * the journey uploads. Not audio-only (`generateWavFile`, used elsewhere in
 * this suite for the upload pipeline itself): the browser MP4 export step
 * further down needs a real video track — an audio-only upload gets "the
 * source has no video track" from the export dialog for the "reels" preset
 * — and captioning a video is the product's actual use case.
 */
function generateSampleClip(): string {
  const dir = mkdtempSync(join(tmpdir(), "aksharo-gate-a-clip-"));
  const clipPath = join(dir, "gate-a-sample.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1080x1920:rate=30:duration=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clipPath,
  ]);
  return clipPath;
}

function dropFile(page: Page, path: string): Promise<void> {
  return (async () => {
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /drop videos or audio here/i }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles(path);
  })();
}

async function currentAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    const body = (await response.json()) as { accessToken?: string };
    return body.accessToken ?? null;
  });
  // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
  if (token === null) throw new Error("could not obtain an access token from the page's session");
  return token;
}

/** A 24-second Hinglish transcript — short enough to keep the journey fast, long enough for a real split/style/script exercise. */
function gateAFixtureChunks(): {
  chunkIdx: number;
  startMs: number;
  endMs: number;
  words: unknown[];
}[] {
  const words = [
    {
      wid: "0:0",
      s: 0,
      e: 500,
      t: "namaste",
      sp: "s1",
      scripts: { roman: "namaste", native: "नमस्ते" },
      c: 0.95,
    },
    {
      wid: "0:1",
      s: 500,
      e: 1000,
      t: "dosto",
      sp: "s1",
      scripts: { roman: "dosto", native: "दोस्तों" },
      c: 0.92,
    },
    {
      wid: "0:2",
      s: 1000,
      e: 1500,
      t: "aaj",
      sp: "s1",
      scripts: { roman: "aaj", native: "आज" },
      c: 0.9,
    },
    {
      wid: "0:3",
      s: 1500,
      e: 2000,
      t: "hum",
      sp: "s1",
      scripts: { roman: "hum", native: "हम" },
      c: 0.9,
    },
    { wid: "0:4", s: 2000, e: 2500, t: "editor", sp: "s1", scripts: { roman: "editor" }, c: 0.9 },
    {
      wid: "0:5",
      s: 2500,
      e: 3000,
      t: "dekhenge",
      sp: "s1",
      scripts: { roman: "dekhenge", native: "देखेंगे" },
      c: 0.9,
    },
    {
      wid: "0:6",
      s: 4500,
      e: 5000,
      t: "bilkul",
      sp: "s2",
      scripts: { roman: "bilkul", native: "बिल्कुल" },
      c: 0.9,
    },
    {
      wid: "0:7",
      s: 5000,
      e: 5500,
      t: "sahi",
      sp: "s2",
      scripts: { roman: "sahi", native: "सही" },
      c: 0.9,
    },
    {
      wid: "0:8",
      s: 5500,
      e: 6000,
      t: "hai",
      sp: "s2",
      scripts: { roman: "hai", native: "है" },
      c: 0.9,
    },
  ];
  return [{ chunkIdx: 0, startMs: 0, endMs: 6_000, words }];
}

test.describe("Gate A journey", () => {
  test("sign-up through cloud render and reload persistence", async ({ page, browserName }) => {
    // --- Sign up (adult, India) ------------------------------------------
    await gotoHydrated(page, "/signup");
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `gate-a-${suffix}@example.test`;
    const password = "correct-horse-battery-staple";
    await page.getByLabel("Name").fill("Priya Sharma");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByTestId("signup-continue").click();
    await page.getByLabel("Date of birth").fill("1995-04-12");
    await page.getByTestId("age-consent-submit").click();
    await expect(page.getByTestId("signup-sent")).toBeVisible();

    const { waitForToken } = await import("./fixtures");
    const token = await waitForToken(email, "email_verification");
    await page.goto(`/verify?token=${encodeURIComponent(token)}`);
    await page.waitForURL(/\/login/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByTestId("login-submit").click();
    await page.waitForURL(/\/onboarding/);

    // --- Onboarding ---------------------------------------------------------
    await expect(page.getByTestId("onboarding")).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Onboarding");
    await page.getByTestId("onboarding-skip").click();
    await page.waitForURL((url) => url.pathname === "/");
    await expectNoSeriousA11yViolations(page, "Home");

    // --- Upload the sample media (real multipart PUT to MinIO) -------------
    const clipPath = generateSampleClip();
    await dropFile(page, clipPath);
    await expect(page.getByTestId("upload-tray-item")).toBeVisible();
    await expect
      .poll(async () => page.getByTestId("upload-cancel").count(), { timeout: 30_000 })
      .toBe(0);

    await gotoHydrated(page, "/projects");
    const card = page.getByTestId("project-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const projectId = (await card.getAttribute("href")) ?? "";
    const match = /\/p\/([0-9A-Z]{26})/.exec(projectId);
    expect(match).not.toBeNull();
    const id = match![1]!;

    const accessToken = await currentAccessToken(page);
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // Settle the probe + proxy jobs a real `worker-media` would run (see the
    // file header's note), then complete transcription with the deterministic
    // Hinglish fixture in place of a real `worker-ai` (`AI_PROVIDER=mock`
    // per the brief; this suite reaches the same outcome through the signed
    // completion callback rather than a live mock-provider worker process).
    const jobsResponse = await page.request.get(`${API_ORIGIN}/jobs`, {
      headers: authHeaders,
      params: { projectId: id, status: "queued" },
    });
    expect(jobsResponse.ok()).toBe(true);
    const jobs = (await jobsResponse.json()) as {
      items: { id: string; type: string; attemptId: string | null }[];
    };
    const probeJob = jobs.items.find((job) => job.type === "media.probe");
    expect(probeJob).toBeDefined();
    await completeJobForTest(probeJob!.id, probeJob!.attemptId!, {
      status: "succeeded",
      result: {
        mediaId: (
          await (
            await page.request.get(`${API_ORIGIN}/projects/${id}/media`, { headers: authHeaders })
          ).json()
        )[0].id,
        container: "mp4",
        mime: "video/mp4",
        durationMs: 6_000,
        sizeBytes: 96_044,
        hasVideo: true,
        hasAudio: true,
        video: { codec: "h264", width: 1080, height: 1920, fps: 30, rotation: 0, hdr: false },
        audio: { codec: "pcm_s16le", sampleRate: 8_000, channels: 1 },
        probedAt: new Date().toISOString(),
        toolVersion: "gate-a-e2e",
      },
    });

    await expect(card).toHaveAttribute("data-status", "queued", { timeout: 15_000 });
    const proxyJobsResponse = await page.request.get(`${API_ORIGIN}/jobs`, {
      headers: authHeaders,
      params: { projectId: id, type: "media.proxy" },
    });
    const proxyJobs = (await proxyJobsResponse.json()) as {
      items: { id: string; attemptId: string | null }[];
    };
    expect(proxyJobs.items.length).toBeGreaterThan(0);
    await completeJobForTest(proxyJobs.items[0]!.id, proxyJobs.items[0]!.attemptId!, {
      status: "succeeded",
      result: {},
    });
    await expect(card).toHaveAttribute("data-status", "ready", { timeout: 15_000 });

    // `completeJobForTest` above is enough on its own: `MediaProxyCompletionHandler`
    // (A07b) reads `media.proxy`'s own completion and flips the media asset's
    // `status` (what `POST /transcribe` actually checks) to `ready` off the job
    // completion itself, independently of the real worker's separate write-back
    // route (`PATCH /internal/media/{id}`, which is not running against this
    // suite's API instance — see this file's header). Asserted directly, since
    // that is the thing this step is actually relying on.
    const mediaListResponse = await page.request.get(`${API_ORIGIN}/projects/${id}/media`, {
      headers: authHeaders,
    });
    const mediaList = (await mediaListResponse.json()) as { id: string; status: string }[];
    expect(mediaList[0]?.status).toBe("ready");

    // Grant credits directly (the fresh signup's signup-gift is enough for a
    // 6s clip in practice, but a generous grant keeps this journey from being
    // sensitive to that policy's own tuning) — same convention as
    // `editor-fixtures.ts`'s `grantCredits` (account+lot+ledger, invariant 1).
    await test.step("grant credits via SQL fixture helper", async () => {
      const { grantTestCredits, workspaceIdFromPage } = await import("./export-test-helpers");
      await grantTestCredits(await workspaceIdFromPage(page));
    });

    // A fresh signup is on the `free` plan (`PLAN_CONCURRENCY_LANE.free` is
    // 2 in-flight jobs, `apps/api/src/jobs/jobs.config.ts`) — too tight for
    // this journey's own probe/proxy/transcribe/subtitle-render/video-render
    // sequence (X02's load harness hit the same cap; see its own header
    // note). Upgraded to `starter` (lane 4) directly by SQL, the same "one
    // non-HTTP step" convention this suite already uses for credits.
    await test.step("upgrade the workspace's plan (concurrency lane) via SQL fixture helper", async () => {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: env["DATABASE_URL"] ?? "" });
      await client.connect();
      try {
        const workspaceId = await (await import("./export-test-helpers")).workspaceIdFromPage(page);
        // A fresh signup has no `subscriptions` row at all (entitlements
        // fall back to `free` with none present), so this inserts one
        // rather than updating a row that does not exist yet.
        const { testUlid } = await import("./editor-fixtures");
        await client.query(
          `INSERT INTO subscriptions
             (id, workspace_id, plan_id, provider, status, current_period_start, current_period_end)
           VALUES ($1, $2, (SELECT id FROM plans WHERE key = 'starter'), 'none', 'active', now(), now() + interval '30 days')
           ON CONFLICT (id) DO NOTHING`,
          [testUlid(), workspaceId],
        );
      } finally {
        await client.end();
      }
    });

    const transcribeResponse = await page.request.post(`${API_ORIGIN}/projects/${id}/transcribe`, {
      headers: { ...authHeaders, "content-type": "application/json" },
      data: {
        languages: ["hi-Latn"],
        hints: [],
        diarise: true,
        captions: { dropFillers: false, maxChars: 60, maxLines: 1, minMs: 200, maxMs: 8_000 },
      },
    });
    expect(transcribeResponse.ok(), await transcribeResponse.text()).toBe(true);
    const { jobId, transcriptId } = (await transcribeResponse.json()) as {
      jobId: string;
      transcriptId: string;
    };
    const transcribeJobResponse = await page.request.get(`${API_ORIGIN}/jobs/${jobId}`, {
      headers: authHeaders,
    });
    const transcribeJob = (await transcribeJobResponse.json()) as { attemptId: string | null };
    await completeJobForTest(jobId, transcribeJob.attemptId ?? "", {
      status: "succeeded",
      result: {
        transcriptId,
        language: "hi-Latn",
        chunks: gateAFixtureChunks(),
        providerSubmissions: [],
      },
    });

    // --- Editor opens --------------------------------------------------------
    await gotoHydrated(page, `/p/${id}`);
    await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 30_000 });
    await expectNoSeriousA11yViolations(page, "Editor");

    // --- Edit a word -----------------------------------------------------
    const chip = page.getByTestId("word-chip-0:0");
    await expect(chip).toHaveText("Namaste");
    await chip.click();
    await chip.press("Enter");
    await expect(chip).toHaveAttribute("contenteditable", "true");
    await chip.selectText();
    await page.keyboard.type("namastey");
    await chip.press("Enter");
    await expect(chip).toHaveText("namastey");
    await expect(page.getByTestId("editor-pending-count")).toHaveAttribute("data-pending", "0", {
      timeout: 10_000,
    });

    // --- Split a segment ---------------------------------------------------
    const segments = page.locator('[data-testid^="segment-card-"]');
    const before = await segments.count();
    await page.getByTestId("word-chip-0:4").click();
    await page.keyboard.press("s");
    await expect(segments).toHaveCount(before + 1, { timeout: 10_000 });

    // --- Switch script -------------------------------------------------------
    await page.getByTestId("script-tab-native").click();
    await expect(page.getByTestId("word-chip-0:1")).toHaveText("दोस्तों");
    await page.getByTestId("script-tab-roman").click();
    await expect(page.getByTestId("word-chip-0:1")).toHaveText("dosto");

    // --- Style: punch-pop --------------------------------------------------
    await page.getByTestId("right-panel-tab-style").click();
    await page.getByTestId("style-picker-tile-punch-pop").click();
    const reflowBanner = page.getByTestId("reflow-banner");
    if (await reflowBanner.count()) {
      await page.getByTestId("reflow-banner-apply").click();
      await expect(reflowBanner).toHaveCount(0, { timeout: 15_000 });
    }
    // The style reflow re-cuts captions to `punch-pop`'s own budget, so the
    // segment count after it has nothing to do with the split's `before + 1`
    // — this is the real baseline the reload-persistence check at the end
    // compares against.
    const afterStyle = await segments.count();

    // --- Export SRT ----------------------------------------------------------
    // `decision.ts` always routes `kind: "subtitle"` to the cloud path
    // ("Subtitles render on the server — there is no browser subtitle
    // path.", asserted by the API's own `decision.test.ts`) even though
    // `ExportDialog.tsx`'s subtitles tab requests `mode: "browser"` — by
    // design, not a bug: the dialog lands in `cloud-offered`, not `done`.
    // So this exercises the dialog for that real transition, then settles
    // the actual cloud job the same way a real `apps/render` would.
    await page.getByTestId("editor-export-open").click();
    await expect(page.getByTestId("export-dialog")).toBeVisible();
    await page.getByTestId("export-tab-subtitles").click();
    // Default is already `srt` (`ExportDialog.tsx`'s `DEFAULT_SUBTITLES`).
    await expect(page.getByTestId("export-subtitle-format-srt")).toBeChecked();
    await page.getByTestId("export-start").click();
    await expect(page.getByTestId("export-cloud-progress")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    const srtManifestResponse = await page.request.post(`${API_ORIGIN}/projects/${id}/exports`, {
      headers: { ...authHeaders, "content-type": "application/json" },
      data: { kind: "subtitle", subtitle: { formats: ["srt"], scripts: ["roman"] }, mode: "cloud" },
    });
    expect(srtManifestResponse.ok(), await srtManifestResponse.text()).toBe(true);
    const srtDecision = (await srtManifestResponse.json()) as {
      path: string;
      exportId: string;
      job?: { jobId: string; status: string; deduplicated: boolean };
    };
    expect(srtDecision.path).toBe("cloud");
    expect(srtDecision.job).toBeDefined();

    // A real SRT, with the edited word and real Hinglish text in it —
    // uploaded to the derived bucket at a fabricated key, standing in for
    // `apps/render`'s own subtitle sidecar output (this suite's established
    // "API-side test hook" convention; see the file header).
    const srtBody = [
      "1",
      "00:00:00,000 --> 00:00:01,000",
      "namastey dosto",
      "",
      "2",
      "00:00:04,500 --> 00:00:06,000",
      "bilkul sahi hai",
      "",
    ].join("\n");
    const srtKey = `ws/gate-a-e2e/p/${id}/exports/sample.srt`;
    await test.step("upload the fabricated SRT sidecar to the derived bucket", async () => {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client({
        endpoint: env["S3_ENDPOINT"] ?? "http://localhost:9000",
        region: env["S3_REGION"] ?? "ap-south-1",
        credentials: {
          accessKeyId: env["S3_ACCESS_KEY"] ?? "montaj-local",
          secretAccessKey: env["S3_SECRET_KEY"] ?? "montaj-local-secret",
        },
        forcePathStyle: true,
      });
      await client.send(
        new PutObjectCommand({
          Bucket: env["R2_BUCKET_DERIVED"] ?? "montaj-derived",
          Key: srtKey,
          Body: srtBody,
          ContentType: "application/x-subrip",
        }),
      );
    });

    const srtJobResponse = await page.request.get(`${API_ORIGIN}/jobs/${srtDecision.job!.jobId}`, {
      headers: authHeaders,
    });
    const srtJob = (await srtJobResponse.json()) as { attemptId: string | null };
    await completeJobForTest(srtDecision.job!.jobId, srtJob.attemptId ?? "", {
      status: "succeeded",
      result: {
        exportId: srtDecision.exportId,
        outputMs: 6_000,
        sidecars: [
          { format: "srt", script: "roman", key: srtKey, sizeBytes: srtBody.length, cues: 2 },
        ],
      },
    });

    // `RenderSubtitleCompletionHandler` creates a NEW `exports` row per
    // sidecar (its own id, not `srtDecision.exportId` — that id names the
    // pre-render placeholder, which never itself reaches `succeeded`), so
    // this looks the finished row up by kind instead.
    let srtExportId: string | undefined;
    await expect
      .poll(
        async () => {
          const listResponse = await page.request.get(`${API_ORIGIN}/projects/${id}/exports`, {
            headers: authHeaders,
          });
          const list = (await listResponse.json()) as {
            items: { id: string; kind: string; status: string }[];
          };
          const row = list.items.find((item) => item.kind === "srt" && item.status === "succeeded");
          srtExportId = row?.id;
          return row?.status;
        },
        { timeout: 15_000 },
      )
      .toBe("succeeded");
    expect(srtExportId).toBeDefined();

    const srtDownloadResponse = await page.request.get(
      `${API_ORIGIN}/exports/${srtExportId}/download`,
      { headers: authHeaders },
    );
    expect(srtDownloadResponse.ok(), await srtDownloadResponse.text()).toBe(true);
    const srtDownload = (await srtDownloadResponse.json()) as { url: string };
    const srtBytes = await (await fetch(srtDownload.url)).text();
    expect(srtBytes).toContain("00:00:00,000 --> 00:00:01,000");
    expect(srtBytes).toContain("namastey dosto");

    // --- Export browser MP4 (chromium only; webkit asserts the cloud fallback) ---
    if (browserName === "webkit") {
      // The dialog was closed after the subtitles step (Escape, above) to
      // make the direct API calls that settle the cloud subtitle job; reopen
      // it for this assertion.
      await page.getByTestId("editor-export-open").click();
      await expect(page.getByTestId("export-dialog")).toBeVisible();
      // WebKit lacks the WebCodecs AAC path (`export-fallback.spec.ts`'s own
      // finding) — the dialog must offer the cloud path rather than attempt
      // (and fail) a browser render.
      await page.getByTestId("export-tab-video").click();
      await page.getByTestId("export-start").click();
      await expect(page.getByTestId("export-cloud-progress")).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");
    } else {
      // ## A reported gap
      //
      // Driving the dialog's own "Export" button here (as the rest of this
      // journey does for every other tab) reaches `use-export-dialog.ts`'s
      // `runExport`, which never passes `preferFileSystemAccess: false` —
      // so a real click tries the native `showSaveFilePicker`, and that
      // rejects with "The user aborted a request." under Playwright's
      // synthetic click (there is no browser chrome for it to prompt
      // against). A real person's click is a genuine user gesture and does
      // not hit this; it is a testability gap, not a product bug, and it is
      // exactly why `export.spec.ts` (A19) already drives a dedicated
      // `/export-harness` page instead of the dialog for its own full
      // browser-export assertion (manifest → WebCodecs render → ffprobe on
      // the produced MP4). Rather than re-deriving that same harness call
      // here with this journey's own project fixture (a second
      // implementation to keep in sync), this step asserts the contract
      // `export.spec.ts` itself depends on: a fresh, ≤10-minute upload on
      // desktop chromium is decided eligible for the *browser* path, at no
      // credit cost — the same decision the dialog's click would have
      // gotten had the picker not intervened. The full pipeline is
      // A19/A19b's own, already-passing coverage.
      const videoDecisionResponse = await page.request.post(
        `${API_ORIGIN}/projects/${id}/exports`,
        {
          headers: { ...authHeaders, "content-type": "application/json" },
          data: {
            kind: "video",
            preset: "reels",
            mode: "auto",
            // `decision.ts`'s `browserEligibility`: H.264 decode+encode and
            // a usable audio encoder are required at every resolution
            // (`hasH264Support`/`hasUsableAudio`), not only above 1080p.
            // `hardwareEncoder: true` (M18): A19c ruling (2), shipped after
            // this assertion was written, routes `auto` at 1080p-and-up to
            // the cloud by default once the client does not report one
            // (`softwareEncoderAboveHd` in `decision.ts`) — real headless
            // Chromium reports none (`export.spec.ts`'s own established
            // finding), so without this field this call now gets `cloud`
            // regardless of eligibility, not because a fresh upload stopped
            // being eligible. This comment's own "the same decision the
            // dialog's click would have gotten" is a real desktop Chrome,
            // and most of those do report a hardware encoder — so `true`
            // here is what keeps this assertion honest for that machine,
            // not a workaround for this sandbox's own.
            capabilities: {
              isMobile: false,
              isDesktopChromium: true,
              codecs: ["avc1.42E01E"],
              audioEncoder: true,
              hardwareEncoder: true,
            },
          },
        },
      );
      expect(videoDecisionResponse.ok(), await videoDecisionResponse.text()).toBe(true);
      const videoDecision = (await videoDecisionResponse.json()) as {
        path: string;
        watermarked: boolean;
      };
      expect(videoDecision.path, "a fresh upload should be browser-export eligible").toBe(
        "browser",
      );
      expect(videoDecision.watermarked, "a fresh signup's gift clears the watermark").toBe(false);
    }

    // --- Cloud render --------------------------------------------------------
    const cloudManifestResponse = await page.request.post(`${API_ORIGIN}/projects/${id}/exports`, {
      headers: { ...authHeaders, "content-type": "application/json" },
      data: { kind: "video", preset: "reels", mode: "cloud" },
    });
    expect(cloudManifestResponse.ok(), await cloudManifestResponse.text()).toBe(true);
    const cloudDecision = (await cloudManifestResponse.json()) as {
      path: string;
      job?: { jobId: string; status: string; deduplicated: boolean };
      exportId: string;
    };
    expect(cloudDecision.path).toBe("cloud");
    expect(cloudDecision.job, "cloud export should enqueue a render job").toBeDefined();

    // Settle the render job the same way `apps/render` would (see the file
    // header's simplification note), producing a real (tiny) MP4 verified
    // with real ffprobe.
    const outDir = mkdtempSync(join(tmpdir(), "aksharo-gate-a-"));
    const outPath = join(outDir, "cloud-render.mp4");
    execFileSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1080x1920:rate=30:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      outPath,
    ]);
    const renderOutputKey = `ws/gate-a-e2e/p/${id}/exports/cloud-render.mp4`;
    await test.step("upload the fabricated cloud-render output to the derived bucket", async () => {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client({
        endpoint: env["S3_ENDPOINT"] ?? "http://localhost:9000",
        region: env["S3_REGION"] ?? "ap-south-1",
        credentials: {
          accessKeyId: env["S3_ACCESS_KEY"] ?? "montaj-local",
          secretAccessKey: env["S3_SECRET_KEY"] ?? "montaj-local-secret",
        },
        forcePathStyle: true,
      });
      await client.send(
        new PutObjectCommand({
          Bucket: env["R2_BUCKET_DERIVED"] ?? "montaj-derived",
          Key: renderOutputKey,
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
          Body: readFileSync(outPath),
          ContentType: "video/mp4",
        }),
      );
    });

    // `RenderVideoResultSchema` (render-completion.handler.ts): every field
    // is required — `outputKey`/`width`/`height`/`watermarked` included, not
    // only size/duration.
    const cloudJobResponse = await page.request.get(
      `${API_ORIGIN}/jobs/${cloudDecision.job!.jobId}`,
      {
        headers: authHeaders,
      },
    );
    const cloudJob = (await cloudJobResponse.json()) as { attemptId: string | null };
    await completeJobForTest(cloudDecision.job!.jobId, cloudJob.attemptId ?? "", {
      status: "succeeded",
      result: {
        exportId: cloudDecision.exportId,
        outputKey: renderOutputKey,
        outputMs: 1_000,
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
        sizeBytes: readFileSync(outPath).length,
        width: 1080,
        height: 1920,
        watermarked: false,
      },
    });

    // No `GET /exports/{id}` route exists (only the list and the download
    // URL, `exports.controller.ts`) — read the status back off the list the
    // same way the export history panel would.
    await expect
      .poll(
        async () => {
          const listResponse = await page.request.get(`${API_ORIGIN}/projects/${id}/exports`, {
            headers: authHeaders,
          });
          const list = (await listResponse.json()) as { items: { id: string; status: string }[] };
          return list.items.find((item) => item.id === cloudDecision.exportId)?.status;
        },
        { timeout: 15_000 },
      )
      .toBe("succeeded");

    const downloadResponse = await page.request.get(
      `${API_ORIGIN}/exports/${cloudDecision.exportId}/download`,
      { headers: authHeaders },
    );
    expect(downloadResponse.ok(), await downloadResponse.text()).toBe(true);
    const download = (await downloadResponse.json()) as { url: string };
    expect(download.url).toBeTruthy();

    // The download genuinely works: fetch the signed URL and ffprobe the
    // real bytes it returns.
    const downloadedPath = join(outDir, "downloaded.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(downloadedPath, Buffer.from(await (await fetch(download.url)).arrayBuffer()));
    const probeJson = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "json",
      downloadedPath,
    ]).toString();
    const probed = JSON.parse(probeJson) as { streams: { codec_type: string }[] };
    expect(probed.streams.some((s) => s.codec_type === "video")).toBe(true);

    // --- Reload and verify persistence -------------------------------------
    await page.reload();
    await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("word-chip-0:0")).toHaveText("namastey", { timeout: 15_000 });
    await expect(segments).toHaveCount(afterStyle);
  });
});
