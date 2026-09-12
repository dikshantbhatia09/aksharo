# Analyst System Audit — Editor, Canvas & Export Pipeline

## Purpose
This document logs the visual and runtime analysis performed during the end-to-end user walkthrough of the Kalakar platform editor (`/p/[id]`), video playback, subtitle styling, and export pipeline.

---

## Audit Item 5: Stale Media Infinite Processing Resolution
* **Symptom**: User projects where an upload was interrupted or aborted stayed stuck indefinitely on *"Analyzing your media — Transcription starts by itself as soon as the media is ready. This page updates on its own"*.
* **Root Cause**: In `apps/api/src/transcripts/transcripts.service.ts`, `transcriptionState` checked `if (media.status !== "ready" || media.durationMs === null || media.durationMs <= 0)` and returned `{ status: "processing_media" }` unconditionally without checking `media.status === "failed"` or considering stale uploads.
* **Resolution**:
  - In `transcripts.service.ts`, explicitly check:
    ```typescript
    if (media.status === "failed") {
      return {
        status: "failed",
        error: media.failureReason ?? "Media processing failed. Please try re-uploading the file.",
      };
    }
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (
      (media.status === "pending" || media.status === "uploading" || media.status === "probing") &&
      media.createdAt &&
      media.createdAt < fiveMinutesAgo
    ) {
      return {
        status: "failed",
        error: "Media upload or processing timed out. Please try re-uploading the file.",
      };
    }
    ```
  - Unit tests in `transcription-state.test.ts` updated and passing (14/14).
  - Visual verification via Playwright confirmed project `01M27M7CK4ZC6K4QX7N52R09BF` now renders a clean failure notice with a *"Try again"* button (`03_stale_project_recovered.png`).

---

## Audit Item 6: Missing CanvasKit WASM and Web Fonts in Web Container
* **Symptom**: When opening the editor in the browser, console reported:
  `wasm streaming compile failed: TypeError: Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok (404)`
  `Aborted(both async and sync fetching of the wasm failed)`
* **Root Cause**: The runtime container `montaj-e2e-web` was initialized without running `pnpm assets:render`. The directory `/app/public` was missing `/canvaskit/canvaskit.wasm` (7.3MB) and `/fonts/` (Noto Sans subset TTFs).
* **Resolution**: Synced `canvaskit.wasm` and fonts into `/app/public/` in the web container. The editor Skia/CanvasKit engine now initializes instantly at 1080x1920 (9:16) resolution.

---

## Audit Item 7: Client-side Export Crop Floating-Point Crash
* **Symptom**: Triggering video export in the browser failed immediately with:
  `options.crop.top must be a non-negative integer.`
* **Root Cause**: In `apps/web/lib/export/engine.ts` lines 553–558, `coverScaleCrop` computed target crop dimensions and divided by `scale` to map back to source coordinate space:
  ```typescript
  crop: {
    left: fit.cropX / scale,
    top: fit.cropY / scale,
    width: fit.cropWidth / scale,
    height: fit.cropHeight / scale,
  }
  ```
  This passed floating-point values (e.g. `0.00012` or non-integer numbers) to `mediabunny.CanvasSink`. Mediabunny strictly validates that `crop.left`, `crop.top`, `crop.width`, `crop.height` are non-negative integers.
* **Resolution**: Clamped and rounded to integers:
  ```typescript
  crop: {
    left: Math.max(0, Math.round(fit.cropX / scale)),
    top: Math.max(0, Math.round(fit.cropY / scale)),
    width: Math.max(1, Math.round(fit.cropWidth / scale)),
    height: Math.max(1, Math.round(fit.cropHeight / scale)),
  }
  ```
  - Deployed rebuilt Next.js assets to web container.
  - Export rendering was verified in a real visible browser: rendered the 20.2-second 1080x1920 video to MP4 format (`20.6 MB`) with zero errors, produced the downloadable file, and recorded the completed render into export history (`08_export_completed.png`).

---

## Audit Item 8: Video Playback, Active Word Sync & Live Style Rendering
* **Verification Results**:
  - Video player loads derived proxy (`proxy540.mp4`, 20.2s duration) directly via signed MinIO URL.
  - Video plays smoothly at 55+ fps.
  - Canvas overlays real-time Hindi subtitles synced to speech.
  - As playhead advances (verified at 3.87s), transcript words highlight in active green chips and timeline filmstrip thumbnails track progress (`04_editor_playback_in_progress.png`).
  - Selecting a new Style Preset (e.g. Purple Badge with Yellow Highlight) instantly re-styles live captions on the canvas (`05_style_preset_applied.png`).

---

## Audit Item 9: Full End-to-End Fresh Upload & Automated Transcription
* **Verification Flow**:
  - Dropped sample media clip `QA-source-clip.mp4` directly onto Home drop zone (`09_fresh_upload_modal.png`).
  - System uploaded file to MinIO S3, triggered probing and proxy generation.
  - "Prepare Your Media" modal opened, allowing user to select language: `Hinglish (Roman)` (`10_language_selected.png`).
  - Clicked *"Generate Transcription →"*, initiating `ai.transcribe` job (`01M281T6EF0PD4PF4GK7F5CY37`).
  - Worker AI extracted 16kHz WAV, ran Faster-Whisper `small` model, generated full EDG word timestamps, and updated project status to `active` (`11_transcription_enqueued.png`).
  - Opened newly created project in editor (`01M281T2HZ6M0FZ8NQR5X2KVDM`): verified synchronized English/Roman cues ("Get the transcript first, then cut. It is that simple..."), waveform, and styles (`12_new_project_editor.png`).

---

## Screenshot Evidence Index
All screenshots taken during the automated visible browser audit are stored in `docs/analyst-audit/screenshots/`:
1. `01_login_page.png` — Sign in interface with branding
2. `01_login_filled.png` — Credentials input for `dikshantbhatia36@gmail.com`
3. `02_dashboard_after_login.png` — User dashboard showing 1M credits, recent projects & video thumbnails
4. `03_stale_project_recovered.png` — Stale project properly showing failure & retry instead of hanging
5. `03_editor_fully_loaded.png` — Editor loaded with Lonavala Villa video, waveform, and Hindi transcript
6. `04_editor_playback_in_progress.png` — Live video playback with real-time highlighted words and captions
7. `05_style_preset_applied.png` — Caption preset selection with Skia canvas re-render
8. `06_export_dialog_open.png` — Export options modal with presets and opacity slider
9. `07_export_rendering_started.png` — Active video rendering phase
10. `08_export_completed.png` — Export finished successfully (`20.6 MB, 20.2s`) with history entry
11. `09_fresh_upload_modal.png` — Drag-and-drop file upload to MinIO S3 with Prepare Media modal
12. `10_language_selected.png` — Language configured to Hinglish (Roman)
13. `11_transcription_enqueued.png` — Automated transcription progress screen
14. `12_new_project_editor.png` — Newly created project fully transcribed and ready in editor
