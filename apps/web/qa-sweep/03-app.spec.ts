import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { Client as PgClient } from "pg";

import { seedEditorProject } from "../e2e/editor-fixtures";
import { signUpAndVerify } from "../e2e/fixtures";
import { overflow, record, shot, watch } from "./diag";

import type { Page } from "@playwright/test";

const WEB_ROOT = "C:/Dikshant/Crest Mond/Product 2/05-build/_worktrees/main/apps/web";
const QA_DIR =
  process.env["QA_OUT"] ??
  "C:/Users/diksh/AppData/Local/Temp/claude/c--Dikshant-Crest-Mond/25f6dbc3-77fc-4d70-986a-42df9821b042/scratchpad/qa";
const DATABASE_URL = process.env["DATABASE_URL"] ?? "";

/**
 * Serve the renderer assets the deployed image is missing, plus the fake
 * proxy video / waveform for the seeded media, so the sweep exercises the
 * product rather than the packaging gap already recorded.
 */
async function installAssetRoutes(page: Page): Promise<void> {
  await page.route("**/canvaskit/canvaskit.wasm", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: readFileSync(resolve(WEB_ROOT, "public/canvaskit/canvaskit.wasm")),
    });
  });
  await page.route("**/fonts/*-subset.ttf", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "font/ttf",
      body: readFileSync(resolve(WEB_ROOT, "public/fonts", name)),
    });
  });
  await page.route("**/style-previews/*.png", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    try {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: readFileSync(resolve(WEB_ROOT, "public/style-previews", name)),
      });
    } catch {
      await route.continue();
    }
  });
}

async function installMediaRoutes(page: Page): Promise<void> {
  await page.route("http://minio:9000/**", async (route) => {
    const url = route.request().url();
    if (url.includes("proxy540")) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "video/mp4", "accept-ranges": "bytes" },
        body: readFileSync(`${QA_DIR}/proxy540.mp4`),
      });
      return;
    }
    if (url.includes("waveform")) {
      const peaks: number[] = [];
      const rms: number[] = [];
      for (let i = 0; i < 9000; i += 1) peaks.push(Math.abs(Math.sin(i / 90)) * 0.9);
      for (let i = 0; i < 900; i += 1) rms.push(Math.abs(Math.sin(i / 9)) * 0.5);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          sampleRate: 16_000,
          peakRate: 100,
          peaks,
          rms: { rate: 10, values: rms },
          durationMs: 90_000,
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "" });
  });
}

async function attachDerivedMedia(projectId: string): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE media_assets
          SET proxy_key = 'ws/qa/p/' || $1 || '/media/proxy540.mp4',
              waveform_key = 'ws/qa/p/' || $1 || '/media/waveform.json'
        WHERE project_id = $1 AND role = 'primary'`,
      [projectId],
    );
  } finally {
    await client.end();
  }
}

test("signed-in journey: shell, projects, billing, settings", async ({ page }) => {
  watch(page, "app");
  await installAssetRoutes(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const account = await signUpAndVerify(page, "qa");
  await shot(page, "onboarding-step1");

  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.waitForTimeout(2500);
  await shot(page, "home");

  for (const route of [
    "/projects",
    "/billing",
    "/billing/plans",
    "/billing/usage",
    "/billing/invoices",
    "/billing/methods",
    "/settings",
    "/settings/profile",
    "/settings/languages",
    "/settings/notifications",
    "/settings/privacy",
    "/settings/subscription",
    "/team",
    "/academy",
    "/help",
    "/updates",
    "/plugins",
    "/affiliate",
  ]) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const status = response?.status() ?? 0;
    if (status >= 400) record({ kind: "route-status", where: route, detail: String(status) });
    const of = await overflow(page);
    if (of.scrollWidth > of.clientWidth + 1) {
      record({
        kind: "overflow",
        where: `${route}@1440`,
        detail: `${String(of.scrollWidth)}>${String(of.clientWidth)} :: ${of.offenders.join(" | ")}`,
      });
    }
    const bodyText = (await page.locator("body").innerText()).slice(0, 200);
    record({ kind: "visited", where: route, detail: bodyText.replaceAll("\n", " / ") });
    await shot(page, `app-${route.replaceAll("/", "_")}`);
  }

  // Mobile pass over the same shell.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/", "/projects", "/billing", "/settings"]) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const of = await overflow(page);
    if (of.scrollWidth > of.clientWidth + 1) {
      record({
        kind: "overflow",
        where: `${route}@390`,
        detail: `${String(of.scrollWidth)}>${String(of.clientWidth)} :: ${of.offenders.join(" | ")}`,
      });
    }
    await shot(page, `app-mobile-${route.replaceAll("/", "_")}`);
  }

  record({ kind: "account", where: "journey", detail: account.email });
  expect(true).toBe(true);
});

test("editor: transcript, playback, timeline, export dialog", async ({ page }) => {
  watch(page, "editor");
  await installAssetRoutes(page);
  await installMediaRoutes(page);
  await page.setViewportSize({ width: 1600, height: 950 });

  const account = await signUpAndVerify(page, "qaed");
  await page.getByTestId("onboarding-skip").click();
  await page.waitForURL((url) => url.pathname === "/");

  const { projectId } = await seedEditorProject(page, account, { title: "QA sweep editor" });
  await attachDerivedMedia(projectId);

  await page.goto(`/p/${projectId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(4000);
  await shot(page, "editor-initial");

  // --- playback -----------------------------------------------------------
  const video = page.getByTestId("caption-stage-video");
  const hasVideo = (await video.count()) > 0;
  record({ kind: "editor", where: "video element", detail: `count=${String(await video.count())}` });
  if (hasVideo) {
    const state = await video.evaluate((el: HTMLVideoElement) => ({
      src: el.currentSrc.slice(0, 80),
      readyState: el.readyState,
      duration: el.duration,
      error: el.error?.message ?? null,
      w: el.videoWidth,
      h: el.videoHeight,
    }));
    record({ kind: "editor", where: "video state", detail: JSON.stringify(state) });

    const before = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
    await page.keyboard.press("Space");
    await page.waitForTimeout(2500);
    const after = await video.evaluate((el: HTMLVideoElement) => ({
      t: el.currentTime,
      paused: el.paused,
    }));
    record({
      kind: "editor",
      where: "space play",
      detail: `before=${String(before)} after=${JSON.stringify(after)}`,
    });
    await shot(page, "editor-playing");

    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
    const paused = await video.evaluate((el: HTMLVideoElement) => el.paused);
    record({ kind: "editor", where: "space pause", detail: `paused=${String(paused)}` });
  }

  // --- transcript click seeks ---------------------------------------------
  const laterWord = page.getByTestId("word-chip-0:7");
  if ((await laterWord.count()) > 0) {
    await laterWord.click();
    await page.waitForTimeout(800);
    if (hasVideo) {
      const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
      record({ kind: "editor", where: "click word seeks", detail: `currentTime=${String(t)}` });
    }
  }
  await shot(page, "editor-after-word-click");

  // --- caption overlay -----------------------------------------------------
  const canvasInfo = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    return canvases.map((c) => ({
      w: c.width,
      h: c.height,
      testid: c.getAttribute("data-testid") ?? "",
    }));
  });
  record({ kind: "editor", where: "canvases", detail: JSON.stringify(canvasInfo).slice(0, 400) });

  const of = await overflow(page);
  if (of.scrollWidth > of.clientWidth + 1) {
    record({
      kind: "overflow",
      where: "/p/[id]@1600",
      detail: `${String(of.scrollWidth)}>${String(of.clientWidth)} :: ${of.offenders.join(" | ")}`,
    });
  }

  // --- export dialog -------------------------------------------------------
  const exportButton = page
    .getByTestId("export-open")
    .or(page.getByRole("button", { name: /export/i }))
    .first();
  if ((await exportButton.count()) > 0) {
    await exportButton.click();
    await page.waitForTimeout(2500);
    await shot(page, "editor-export-dialog");
    const dialogText = await page.locator('[role="dialog"]').first().innerText();
    record({ kind: "export", where: "dialog", detail: dialogText.replaceAll("\n", " / ").slice(0, 900) });
  } else {
    record({ kind: "export", where: "dialog", detail: "no export control found" });
  }

  // --- editor at a laptop width -------------------------------------------
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1500);
  await shot(page, "editor-1280");
  const of1280 = await overflow(page);
  record({
    kind: "editor",
    where: "1280 overflow",
    detail: `${String(of1280.scrollWidth)}>${String(of1280.clientWidth)} :: ${of1280.offenders.join(" | ")}`,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await shot(page, "editor-390");
  const of390 = await overflow(page);
  record({
    kind: "editor",
    where: "390 overflow",
    detail: `${String(of390.scrollWidth)}>${String(of390.clientWidth)} :: ${of390.offenders.join(" | ")}`,
  });

  record({ kind: "editor", where: "projectId", detail: projectId });
});
