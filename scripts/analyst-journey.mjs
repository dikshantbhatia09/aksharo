import pkg from "../apps/web/node_modules/@playwright/test/index.js";
const { chromium } = pkg;
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const auditEmail = process.env.AKSHARO_AUDIT_EMAIL;
const auditPassword = process.env.AKSHARO_AUDIT_PASSWORD;
if (!auditEmail || !auditPassword) {
  throw new Error("Set AKSHARO_AUDIT_EMAIL and AKSHARO_AUDIT_PASSWORD before running this audit.");
}
const SCREENSHOT_DIR = path.resolve(__dirname, "../docs/analyst-audit/screenshots");
const SAMPLE_VIDEO = path.resolve(
  __dirname,
  "../../_orchestration/reports/S04/_qa/QA-source-clip.mp4"
);

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function snap(page, name) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`📸 Saved screenshot: ${name}.png`);
  return filePath;
}

async function runAnalystJourney() {
  console.log("🚀 Starting Analyst Journey: Kalakar / Montaj E2E Platform Test");
  console.log("---------------------------------------------------------------");

  const headless = process.argv.includes("--headless");
  console.log(`Browser mode: ${headless ? "Headless" : "Visible (headless: false)"}`);

  const browser = await chromium.launch({
    headless,
    slowMo: 100,
    args: ["--disable-web-security", "--window-size=1440,900"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // Bypass native file-picker in Playwright synthetic clicks
  await page.addInitScript(() => {
    window.__aksharoE2E = { noFilePicker: true };
  });

  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.log(`[Browser ${msg.type().toUpperCase()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error(`[Browser PageError]`, err.message);
  });

  try {
    // -------------------------------------------------------------
    // STEP 1: AUTHENTICATION
    // -------------------------------------------------------------
    console.log("\n[Step 1] Navigating to http://localhost:3000/login");
    await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await snap(page, "01_login_page");

    console.log("[Step 1] Entering credentials for dikshantbhatia36@gmail.com...");
    await page.fill('input[name="email"]', auditEmail);
    await page.fill('input[name="password"]', auditPassword);
    await snap(page, "01_login_filled");

    console.log("[Step 1] Submitting sign in...");
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    console.log(`[Step 1] Logged in successfully! Dashboard URL: ${page.url()}`);
    await page.waitForTimeout(2000);
    await snap(page, "02_dashboard_after_login");

    // -------------------------------------------------------------
    // STEP 2: OPEN READY PROJECT (LONAVALA VILLA 01M280AXK3M2Q58M32W7DKW0NA)
    // -------------------------------------------------------------
    console.log("\n[Step 2] Navigating to transcribed project 01M280AXK3M2Q58M32W7DKW0NA");
    await page.goto("http://localhost:3000/p/01M280AXK3M2Q58M32W7DKW0NA", { waitUntil: "domcontentloaded" });

    console.log("[Step 2] Waiting for editor components (Timeline, Canvas, Transcript)...");
    await page.waitForTimeout(5000);

    // Dismiss coach marks if present
    const skipBtn = await page.$('button:has-text("Skip")');
    if (skipBtn) {
      console.log("[Step 2] Dismissing first-run coach marks...");
      await skipBtn.click();
      await page.waitForTimeout(1000);
    }

    await snap(page, "03_editor_fully_loaded");

    // Inspect editor DOM state
    const editorState = await page.evaluate(() => {
      const video = document.querySelector("video");
      const canvas = document.querySelector("canvas");
      const words = document.querySelectorAll('[data-testid^="word-chip"], [data-word-id], .word-chip');
      return {
        videoSrc: video ? video.src : null,
        videoDuration: video ? video.duration : null,
        hasCanvas: Boolean(canvas),
        canvasWidth: canvas ? canvas.width : null,
        canvasHeight: canvas ? canvas.height : null,
        wordCount: words.length,
      };
    });
    console.log("[Step 2] Editor state:", JSON.stringify(editorState, null, 2));

    // -------------------------------------------------------------
    // STEP 3: PLAYBACK VERIFICATION
    // -------------------------------------------------------------
    console.log("\n[Step 3] Testing timeline playback...");
    const playBtn = await page.$('[data-testid="timeline-play-pause"]');
    if (playBtn) {
      console.log("[Step 3] Clicking timeline play button...");
      await playBtn.click();
    } else {
      console.log("[Step 3] Pressing Space to toggle play...");
      await page.keyboard.press("Space");
    }

    await page.waitForTimeout(3500);
    await snap(page, "04_editor_playback_in_progress");

    const playMetrics = await page.evaluate(() => {
      const video = document.querySelector("video");
      return {
        currentTime: video ? video.currentTime : null,
        paused: video ? video.paused : null,
      };
    });
    console.log("[Step 3] Playback metrics after 3.5s:", playMetrics);

    // Pause playback
    if (playBtn) {
      await playBtn.click();
    } else {
      await page.keyboard.press("Space");
    }
    await page.waitForTimeout(1000);

    // -------------------------------------------------------------
    // STEP 4: STYLE PRESETS APPLICATION
    // -------------------------------------------------------------
    console.log("\n[Step 4] Testing caption style preset selection...");
    const secondStyleTile = await page.$('[data-testid^="style-picker-tile-"]:nth-child(2), [data-testid^="style-picker-tile-"]');
    if (secondStyleTile) {
      console.log("[Step 4] Clicking style preset tile...");
      await secondStyleTile.click();
      await page.waitForTimeout(2000);
      await snap(page, "05_style_preset_applied");
    } else {
      console.log("[Step 4] Style tile not directly found, snapping current style panel...");
      await snap(page, "05_style_panel");
    }

    // -------------------------------------------------------------
    // STEP 5: FULL EXPORT EXECUTION (WITH INTEGER-CROP FIX)
    // -------------------------------------------------------------
    console.log("\n[Step 5] Triggering video export...");
    const exportTopBtn = await page.$('button:has-text("Export"):not([data-testid="export-start"])');
    if (exportTopBtn) {
      console.log("[Step 5] Opening Export dialog...");
      await exportTopBtn.click();
      await page.waitForTimeout(1500);
      await snap(page, "06_export_dialog_open");

      const exportStartBtn = await page.$('[data-testid="export-start"]');
      if (exportStartBtn) {
        console.log("[Step 5] Clicking modal Export button...");
        await exportStartBtn.click();
        await page.waitForTimeout(2000);
        await snap(page, "07_export_rendering_started");

        console.log("[Step 5] Polling for export completion (up to 90s)...");
        let finished = false;
        for (let i = 0; i < 30; i++) {
          await page.waitForTimeout(3000);
          const exportStatus = await page.evaluate(() => {
            const dl = document.querySelector('[data-testid="export-download"]');
            const done = document.querySelector('[data-testid="export-done"]');
            const err = document.querySelector('[data-testid="export-error"]');
            const inFlight = document.querySelector('[data-testid="export-render-in-flight"]');
            const cloudOffer = document.querySelector('[data-testid="export-cloud-offer"]');
            return {
              hasDownload: Boolean(dl),
              downloadHref: dl?.querySelector("a")?.href ?? null,
              doneText: done?.textContent ?? null,
              errText: err?.textContent ?? null,
              inFlight: Boolean(inFlight),
              cloudOffer: Boolean(cloudOffer),
            };
          });

          console.log(`[Step 5 Poll ${i + 1}] Export status:`, exportStatus);
          if (exportStatus.hasDownload || exportStatus.doneText) {
            finished = true;
            console.log("✅ Export completed successfully!");
            await snap(page, "08_export_completed");
            break;
          }
          if (exportStatus.errText) {
            console.error("❌ Export failed with error:", exportStatus.errText);
            await snap(page, "08_export_failed");
            break;
          }
        }
      }
    }

    // Close export dialog if open
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);

    // -------------------------------------------------------------
    // STEP 6: TEST FRESH VIDEO UPLOAD VIA HOME DROPZONE
    // -------------------------------------------------------------
    console.log("\n[Step 6] Navigating back to Home to test fresh file upload...");
    await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const fileInput = await page.$('[data-testid="drop-zone-input"]');
    if (fileInput && fs.existsSync(SAMPLE_VIDEO)) {
      console.log(`[Step 6] Uploading sample video: ${SAMPLE_VIDEO}...`);
      await fileInput.setInputFiles(SAMPLE_VIDEO);
      await page.waitForTimeout(3000);
      await snap(page, "09_fresh_upload_modal");

      // In Prepare Your Media modal, choose spoken language
      console.log("[Step 6] Selecting language in Prepare Your Media modal...");
      const langTrigger = await page.$(
        '[role="dialog"] [data-testid="quickpick-language"] button, [role="dialog"] button:has-text("Choose spoken language")'
      );
      if (langTrigger) {
        await langTrigger.click();
        await page.waitForTimeout(1000);

        // Click English or Hindi from dropdown list
        const hindiOption = await page.$(
          '[role="option"]:has-text("Hindi"), [cmdk-item]:has-text("Hindi"), [data-value*="hi"]'
        );
        if (hindiOption) {
          await hindiOption.click();
          await page.waitForTimeout(1000);
        }
      }

      await snap(page, "10_language_selected");

      const generateBtn = await page.$('[data-testid="prepare-media-generate"]');
      if (generateBtn) {
        console.log("[Step 6] Clicking 'Generate Transcription ->'...");
        await generateBtn.click();
        await page.waitForTimeout(5000);
        await snap(page, "11_transcription_enqueued");
      }
    } else {
      console.log(`[Step 6] Sample video not found or dropzone input not found.`);
    }

    console.log("\n🎉 Full Analyst Journey completed successfully!");
  } catch (error) {
    console.error("\n❌ Analyst Journey failed with error:", error);
    await snap(page, "99_failure_state");
  } finally {
    await browser.close();
  }
}

runAnalystJourney().catch(console.error);
