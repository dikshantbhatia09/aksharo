import { readFileSync } from "node:fs";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, test } from "@playwright/test";
import { Client as PgClient } from "pg";

import { seedEditorProject } from "../e2e/editor-fixtures";
import { loadRepoEnv } from "../e2e/env";
import { gotoHydrated, waitForHydration } from "../e2e/fixtures";
import { overflow, record, shot, watch } from "./diag";

import type { Account } from "../e2e/fixtures";
import type { Page } from "@playwright/test";

const QA_DIR =
  process.env["QA_OUT"] ??
  "C:/Users/diksh/AppData/Local/Temp/claude/c--Dikshant-Crest-Mond/25f6dbc3-77fc-4d70-986a-42df9821b042/scratchpad/qa";
const ENV = loadRepoEnv();
const DATABASE_URL = ENV["DATABASE_URL"] ?? "";
const PASSWORD = "correct-horse-battery-staple";

function uniqueEmail(label: string): string {
  return `qa-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`;
}

/** Sign up with dev auto-verification on (this .env sets AUTH_DEV_AUTO_VERIFY=1). */
async function signUp(page: Page, label: string): Promise<Account> {
  const email = uniqueEmail(label);
  await gotoHydrated(page, "/signup");
  await page.getByLabel("Name").fill("Priya Sharma");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByTestId("signup-continue").click();
  await page.getByLabel("Date of birth").fill("1995-04-12");
  await page.getByTestId("age-consent-submit").click();
  await expect(page.getByTestId("signup-sent")).toBeVisible();

  await gotoHydrated(page, "/login?next=/studio");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await waitForHydration(page);
  return { email, password: PASSWORD };
}


/** Auto-dismiss the first-run overlays (What's New modal, coach marks). */
async function dismissOverlays(page: Page): Promise<void> {
  await page.addLocatorHandler(page.getByTestId("whats-new-modal"), async (modal) => {
    await modal.getByRole("button", { name: "Got it" }).click();
  });
  await page.addLocatorHandler(page.getByTestId("coach-mark"), async (mark) => {
    const skip = mark.getByTestId("coach-mark-skip");
    await skip.waitFor({ state: "visible", timeout: 5_000 });
    await skip.click();
  });
}

async function putDerived(key: string, body: Buffer, contentType: string): Promise<void> {
  const client = new S3Client({
    endpoint: ENV["R2_ENDPOINT"] ?? "http://localhost:9000",
    region: ENV["S3_REGION"] ?? "ap-south-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: ENV["R2_ACCESS_KEY"] ?? "montaj-local",
      secretAccessKey: ENV["R2_SECRET_KEY"] ?? "montaj-local-secret",
    },
  });
  await client.send(
    new PutObjectCommand({
      Bucket: ENV["R2_BUCKET_DERIVED"] ?? "montaj-derived",
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function attachDerivedMedia(projectId: string): Promise<{ proxyKey: string }> {
  const proxyKey = `ws/qa/p/${projectId}/media/proxy540.mp4`;
  const waveformKey = `ws/qa/p/${projectId}/media/waveform.json`;

  await putDerived(proxyKey, readFileSync(`${QA_DIR}/proxy540.mp4`), "video/mp4");
  const peaks: number[] = [];
  const rms: number[] = [];
  for (let i = 0; i < 9000; i += 1) peaks.push(Math.abs(Math.sin(i / 90)) * 0.9);
  for (let i = 0; i < 900; i += 1) rms.push(Math.abs(Math.sin(i / 9)) * 0.5);
  await putDerived(
    waveformKey,
    Buffer.from(
      JSON.stringify({
        version: 1,
        sampleRate: 16_000,
        peakRate: 100,
        peaks,
        rms: { rate: 10, values: rms },
        durationMs: 90_000,
      }),
    ),
    "application/json",
  );

  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE media_assets SET proxy_key = $2, waveform_key = $3
        WHERE project_id = $1 AND role = 'primary'`,
      [projectId, proxyKey, waveformKey],
    );
  } finally {
    await client.end();
  }
  return { proxyKey };
}

test("host: signed-in shell, projects, billing, settings", async ({ page }) => {
  watch(page, "host-app");
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page, "shell");
  await page.waitForTimeout(1500);
  await shot(page, "host-after-login");

  const skip = page.getByTestId("onboarding-skip");
  if ((await skip.count()) > 0) {
    await shot(page, "host-onboarding");
    await skip.click();
    await page.waitForTimeout(1500);
  }
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await shot(page, "host-home");

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
    "/settings/devices",
    "/team",
    "/academy",
    "/help",
    "/updates",
    "/plugins",
    "/affiliate",
    "/studio/styles",
  ]) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
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
    const bodyText = (await page.locator("body").innerText()).slice(0, 260);
    record({ kind: "visited", where: route, detail: bodyText.replaceAll("\n", " / ") });
    await shot(page, `host${route.replaceAll("/", "_")}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/", "/projects", "/billing", "/billing/plans", "/settings"]) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const of = await overflow(page);
    if (of.scrollWidth > of.clientWidth + 1) {
      record({
        kind: "overflow",
        where: `${route}@390`,
        detail: `${String(of.scrollWidth)}>${String(of.clientWidth)} :: ${of.offenders.join(" | ")}`,
      });
    }
    await shot(page, `host-mobile${route.replaceAll("/", "_")}`);
  }
});

test("host: editor playback, transcript, timeline, export", async ({ page }) => {
  watch(page, "host-editor");
  await dismissOverlays(page);
  await page.setViewportSize({ width: 1600, height: 950 });
  const account = await signUp(page, "editor");
  const skip = page.getByTestId("onboarding-skip");
  if ((await skip.count()) > 0) await skip.click();
  await page.waitForTimeout(1000);

  // `seedEditorProject` signs in itself; /login redirects an already-signed-in
  // session straight to the shell, so drop the cookie first.
  await page.context().clearCookies();
  const { projectId } = await seedEditorProject(page, account, { title: "QA host editor" });
  const { proxyKey } = await attachDerivedMedia(projectId);
  record({ kind: "editor", where: "seeded", detail: `${projectId} ${proxyKey}` });

  await page.goto(`/p/${projectId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(6000);
  await shot(page, "host-editor-initial");

  const video = page.getByTestId("caption-stage-video");
  const hasVideo = (await video.count()) > 0;
  record({ kind: "editor", where: "video count", detail: String(await video.count()) });
  if (hasVideo) {
    const state = await video.evaluate((el: HTMLVideoElement) => ({
      src: el.currentSrc.slice(0, 120),
      readyState: el.readyState,
      networkState: el.networkState,
      duration: el.duration,
      error: el.error === null ? null : `${String(el.error.code)}: ${el.error.message}`,
      w: el.videoWidth,
      h: el.videoHeight,
    }));
    record({ kind: "editor", where: "video state", detail: JSON.stringify(state) });

    await page.keyboard.press("Space");
    await page.waitForTimeout(3000);
    const after = await video.evaluate((el: HTMLVideoElement) => ({
      t: el.currentTime,
      paused: el.paused,
      err: el.error === null ? null : el.error.code,
    }));
    record({ kind: "editor", where: "after space", detail: JSON.stringify(after) });
    await shot(page, "host-editor-playing");
    await page.keyboard.press("Space");
  }

  const stageText = await page.getByTestId("editor-root").innerText();
  record({
    kind: "editor",
    where: "editor text",
    detail: stageText.split(/\s*\n\s*/).join(" / ").slice(0, 1400),
  });

  const canvases = await page.evaluate(() =>
    Array.from(document.querySelectorAll("canvas")).map((c) => ({
      w: c.width,
      h: c.height,
      id: c.getAttribute("data-testid") ?? "",
    })),
  );
  record({ kind: "editor", where: "canvases", detail: JSON.stringify(canvases).slice(0, 300) });

  const wordChip = page.getByTestId("word-chip-0:7");
  if ((await wordChip.count()) > 0) {
    await wordChip.click();
    await page.waitForTimeout(1200);
    if (hasVideo) {
      const t = await video.evaluate((el: HTMLVideoElement) => el.currentTime);
      record({ kind: "editor", where: "word click seek", detail: `t=${String(t)}` });
    }
    await shot(page, "host-editor-word-click");
  }

  const of = await overflow(page);
  record({
    kind: "editor",
    where: "editor overflow 1600",
    detail: `${String(of.scrollWidth)}>${String(of.clientWidth)} :: ${of.offenders.join(" | ")}`,
  });

  const exportButton = page
    .getByTestId("export-open")
    .or(page.getByRole("button", { name: /^export/i }))
    .first();
  if ((await exportButton.count()) > 0) {
    await exportButton.click();
    await page.waitForTimeout(3000);
    await shot(page, "host-export-dialog");
    const dialog = page.locator('[role="dialog"]').first();
    if ((await dialog.count()) > 0) {
      record({
        kind: "export",
        where: "dialog text",
        detail: (await dialog.innerText()).replaceAll("\n", " / ").slice(0, 1200),
      });
    } else {
      record({ kind: "export", where: "dialog", detail: "clicked export, no [role=dialog]" });
    }
  } else {
    record({ kind: "export", where: "control", detail: "no export button found" });
  }

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(2000);
  await shot(page, "host-editor-1280");
  const of1280 = await overflow(page);
  record({
    kind: "editor",
    where: "editor overflow 1280",
    detail: `${String(of1280.scrollWidth)}>${String(of1280.clientWidth)} :: ${of1280.offenders.join(" | ")}`,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(2000);
  await shot(page, "host-editor-390");
  const of390 = await overflow(page);
  record({
    kind: "editor",
    where: "editor overflow 390",
    detail: `${String(of390.scrollWidth)}>${String(of390.clientWidth)} :: ${of390.offenders.join(" | ")}`,
  });
  record({ kind: "editor", where: "project", detail: projectId });
});
