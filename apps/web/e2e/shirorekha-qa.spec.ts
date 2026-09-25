import { mkdirSync, writeFileSync } from "node:fs";

import { seedEditorProject, smallFixtureChunks } from "./editor-fixtures";
import { test } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * A look at every signed-in screen after the Shirorekha redesign, at desktop
 * (1440 × 900) and phone (390 × 844) widths. A verification aid, not a gate:
 * it records a full-page PNG per screen plus a JSON report of horizontal
 * overflow and console errors, and fails nothing on its own.
 *
 * Scratch stack only — never `.env.local-run` (CLAUDE.md §1; it signs up an
 * account). Every port and origin must be set, because the config's defaults
 * are the production ports:
 *
 * ```
 * cd apps/web
 * API_PORT=3131 API_ORIGIN=http://127.0.0.1:3131 WEB_PORT=3132 \
 *   NEXT_DIST_DIR=.next-qa \
 *   DATABASE_URL="postgresql://montaj:montaj@localhost:59432/montaj_e2e?schema=public" \
 *   REDIS_URL="redis://localhost:59379" \
 *   npx playwright test e2e/shirorekha-qa.spec.ts --project=chromium --workers=1
 * ```
 */

const OUT = "test-results-shirorekha";

const ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["home", "/home"],
  ["projects", "/projects"],
  ["studio", "/studio"],
  ["styles", "/studio/styles"],
  ["repurpose", "/repurpose"],
  ["repurpose-new", "/repurpose/new"],
  ["billing", "/billing"],
  ["billing-plans", "/billing/plans"],
  ["billing-usage", "/billing/usage"],
  ["billing-invoices", "/billing/invoices"],
  ["settings-profile", "/settings/profile"],
  ["settings-languages", "/settings/languages"],
  ["settings-notifications", "/settings/notifications"],
  ["settings-privacy", "/settings/privacy"],
  ["settings-devices", "/settings/devices"],
  ["settings-developers", "/settings/developers"],
  ["settings-subscription", "/settings/subscription"],
  ["team", "/team"],
  ["affiliate", "/affiliate"],
  ["academy", "/academy"],
  ["help", "/help"],
  ["updates", "/updates"],
  ["onboarding", "/onboarding"],
];

interface Finding {
  name: string;
  width: number;
  status: number | null;
  scrollWidth: number;
  overflowers: string[];
  consoleErrors: string[];
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

async function measure(page: Page): Promise<{ scrollWidth: number; overflowers: string[] }> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const overflowers = [...document.querySelectorAll("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.right <= width + 1 || r.width === 0) return false;
        // An element inside its own horizontal scroller is fine.
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return false;
        }
        return true;
      })
      .slice(0, 4);
    // Nothing escaped on its own, yet the page still scrolls: list the elements
    // whose right edge IS the page's scroll width — one of them is the culprit.
    const suspects =
      overflowers.length > 0 || document.documentElement.scrollWidth <= width
        ? overflowers
        : [...document.querySelectorAll("body *")]
            .filter(
              (el) =>
                Math.abs(el.getBoundingClientRect().right - document.documentElement.scrollWidth) <= 1,
            )
            .slice(0, 8);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      overflowers: suspects.map(
        (el) =>
          `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? ""}].${String(el.className).slice(0, 70)} → ${Math.round(el.getBoundingClientRect().right)}px`,
      ),
    };
  });
}

test.describe("Shirorekha QA", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "one browser is enough for a look");
  test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

  test("every signed-in screen, desktop and phone", async ({ page, sharedAccount }) => {
    test.setTimeout(900_000);
    const findings: Finding[] = [];
    let errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 200));
    });

    // Seed first: seedEditorProject signs in itself, and a second sign-in on
    // an already signed-in page never finds the login form.
    const { projectId } = await seedEditorProject(page, sharedAccount, {
      title: "Shirorekha QA",
      chunks: smallFixtureChunks(),
    });
    const save = (): void => {
      writeFileSync(`${OUT}/report.json`, JSON.stringify(findings, null, 2));
    };

    for (const [width, height, tag] of [
      [1440, 900, "desk"],
      [390, 844, "phone"],
    ] as const) {
      await page.setViewportSize({ width, height });
      // QA_ROUTES=projects,studio narrows a rerun to the routes in question.
      const only = process.env["QA_ROUTES"]?.split(",");
      for (const [name, path] of ROUTES.filter(([n]) => only === undefined || only.includes(n))) {
        errors = [];
        const response = await page.goto(path, { waitUntil: "load" });
        await settle(page);
        const m = await measure(page);
        findings.push({ name, width, status: response?.status() ?? null, ...m, consoleErrors: errors });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- names are literals from this file
        writeFileSync(`${OUT}/${tag}-${name}.png`, await page.screenshot({ fullPage: true }));
        save();
      }
    }

    // The editor, on the project seeded above.
    for (const [width, height, tag] of [
      [1440, 900, "desk"],
      [1024, 768, "narrow"],
    ] as const) {
      await page.setViewportSize({ width, height });
      errors = [];
      const response = await page.goto(`/p/${projectId}`, { waitUntil: "load" });
      await page.waitForTimeout(4_000);
      await settle(page);
      const m = await measure(page);
      findings.push({ name: "editor", width, status: response?.status() ?? null, ...m, consoleErrors: errors });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- names are literals from this file
      writeFileSync(`${OUT}/${tag}-editor.png`, await page.screenshot());
    }

    save();
  });
});
