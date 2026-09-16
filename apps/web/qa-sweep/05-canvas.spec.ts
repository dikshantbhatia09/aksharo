import { readFileSync } from "node:fs";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, test } from "@playwright/test";
import { Client as PgClient } from "pg";

import { record, shot, watch } from "./diag";
import { seedEditorProject } from "../e2e/editor-fixtures";
import { loadRepoEnv } from "../e2e/env";
import { gotoHydrated, waitForHydration } from "../e2e/fixtures";

import type { Account } from "../e2e/fixtures";
import type { Page } from "@playwright/test";

const ENV = loadRepoEnv();
const QA_DIR =
  process.env["QA_OUT"] ??
  "C:/Users/diksh/AppData/Local/Temp/claude/c--Dikshant-Crest-Mond/25f6dbc3-77fc-4d70-986a-42df9821b042/scratchpad/qa";
const PASSWORD = "correct-horse-battery-staple";

async function signUp(page: Page, label: string): Promise<Account> {
  const email = `qa-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`;
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

test("editor canvas: caption overlay and style tiles actually paint", async ({ page }) => {
  watch(page, "canvas");
  await dismissOverlays(page);
  await page.setViewportSize({ width: 1600, height: 950 });
  const account = await signUp(page, "canvas");
  const skip = page.getByTestId("onboarding-skip");
  if ((await skip.count()) > 0) await skip.click();
  await page.waitForTimeout(800);
  await page.context().clearCookies();

  const { projectId } = await seedEditorProject(page, account, { title: "QA canvas" });

  // Derived media in the local MinIO, as a real probe would leave it.
  const proxyKey = `ws/qa/p/${projectId}/media/proxy540.mp4`;
  const s3 = new S3Client({
    endpoint: ENV["R2_ENDPOINT"] ?? "http://localhost:9000",
    region: ENV["S3_REGION"] ?? "ap-south-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: ENV["R2_ACCESS_KEY"] ?? "montaj-local",
      secretAccessKey: ENV["R2_SECRET_KEY"] ?? "montaj-local-secret",
    },
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: ENV["R2_BUCKET_DERIVED"] ?? "montaj-derived",
      Key: proxyKey,
      Body: readFileSync(`${QA_DIR}/proxy540.mp4`),
      ContentType: "video/mp4",
    }),
  );
  const pg = new PgClient({ connectionString: ENV["DATABASE_URL"] ?? "" });
  await pg.connect();
  await pg.query(`UPDATE media_assets SET proxy_key = $2 WHERE project_id = $1 AND role='primary'`, [
    projectId,
    proxyKey,
  ]);
  await pg.end();

  await page.goto(`/p/${projectId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("editor-root")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(9000);

  const sample = await page.evaluate(() => {
    function inspect(canvas: HTMLCanvasElement): {
      id: string;
      w: number;
      h: number;
      nonBlank: number;
      distinct: number;
    } {
      const ctx = canvas.getContext("2d");
      const id = canvas.getAttribute("data-testid") ?? "";
      if (ctx === null) return { id, w: canvas.width, h: canvas.height, nonBlank: -1, distinct: -1 };
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      } catch {
        return { id, w: canvas.width, h: canvas.height, nonBlank: -2, distinct: -2 };
      }
      const colours = new Set<string>();
      let nonBlank = 0;
      for (let i = 0; i < data.length; i += 4 * 37) {
        const key = `${String(data[i])},${String(data[i + 1])},${String(data[i + 2])},${String(data[i + 3])}`;
        colours.add(key);
        if ((data[i + 3] ?? 0) > 8) nonBlank += 1;
      }
      return {
        id,
        w: canvas.width,
        h: canvas.height,
        nonBlank,
        distinct: colours.size,
      };
    }
    return Array.from(document.querySelectorAll("canvas")).slice(0, 6).map(inspect);
  });
  record({ kind: "canvas", where: "pixels", detail: JSON.stringify(sample) });

  const stage = page.getByTestId("caption-stage-overlay");
  if ((await stage.count()) > 0) {
    await stage.screenshot({ path: `${QA_DIR}/canvas-stage.png` });
  }
  const panel = page.locator('[data-testid="style-preview-punch-pop"]').first();
  if ((await panel.count()) > 0) {
    await panel.screenshot({ path: `${QA_DIR}/canvas-style-tile.png` });
  }
  await shot(page, "canvas-editor");

  // Does the reflow banner really appear on a project nobody restyled?
  const banner = page.getByText(/Reflow to re-cut lines/i);
  record({
    kind: "editor",
    where: "reflow banner on first open",
    detail: String(await banner.count()),
  });
  record({ kind: "editor", where: "canvas project", detail: projectId });
});
