import { expect, test } from "@playwright/test";

import { API_ORIGIN, freshAccount, seedEditorProject } from "./editor-fixtures";
import { grantTestCredits, workspaceIdFromPage } from "./export-test-helpers";

/**
 * WebKit: asserts the graceful fallback to the cloud path where WebCodecs
 * (or AAC audio encoding) is missing. Safari's WebKit does not implement
 * `VideoEncoder`/`AudioEncoder.isConfigSupported` for AAC the way Chromium
 * does as of this writing (`probe.ts`'s support matrix), so the capability
 * probe reports `webCodecs: false` (or `audioEncoderAvailable`/AAC missing)
 * and `isBrowserExportEligible` returns `false` — the dialog must offer the
 * cloud path rather than attempt (and fail) a browser render.
 */
test.describe("browser export fallback (webkit)", () => {
  test.skip(
    ({ browserName }) => browserName !== "webkit",
    "this asserts the WebKit fallback specifically",
  );

  test("the capability probe reports the browser path as ineligible", async ({ page, browser }) => {
    // See `export.spec.ts`'s note: sign up in a wholly separate browser
    // context so `page` itself is still signed out when `seedEditorProject`
    // signs it in (a second page in the *same* context still shares cookies).
    const setupContext = await browser.newContext();
    const setupPage = await setupContext.newPage();
    const account = await freshAccount(setupPage, "export-fallback-e2e");
    await grantTestCredits(await workspaceIdFromPage(setupPage));
    await setupContext.close();
    const { projectId } = await seedEditorProject(page, account, {
      title: "A19 export fallback e2e",
    });

    await page.goto(`/export-harness?projectId=${projectId}`);
    await page.waitForFunction(() => window.__exportHarness?.ready === true, undefined, {
      timeout: 60_000,
    });

    const probe = await page.evaluate(async () => {
      const harness = window.__exportHarness;
      if (harness === undefined) throw new Error("harness not ready");
      const result = await harness.lib.probeExportCapabilities();
      return { webCodecs: result.webCodecs, eligible: harness.lib.isBrowserExportEligible(result) };
    });

    test
      .info()
      .annotations.push({ type: "webkit-webcodecs", description: String(probe.webCodecs) });
    expect(probe.eligible).toBe(false);
  });

  /**
   * ## A reported gap
   *
   * `apps/api/src/exports/decision.ts`'s `browserEligibility` only refuses
   * the browser path for `isMobile`, a 4K request without desktop-Chromium +
   * a file sink, or a duration over the caps — it never checks
   * `capabilities.codecs`/`capabilities.audioEncoder` for an ordinary
   * ≤1080p desktop request. A WebKit desktop probe therefore gets `path:
   * "browser"` back from a literal `mode: "auto"` POST even though it cannot
   * actually encode. `use-export-dialog.ts` defends against this correctly
   * — it computes `mode` from its own `isBrowserExportEligible(probe)`
   * *before* calling the API, and never sends `"auto"` for an ineligible
   * probe — so this test exercises that real contract (client decides, then
   * asks) rather than assuming the server alone gates an unsupported
   * browser. A non-Aksharo API caller that skipped the client-side probe
   * could still be told "browser" for this exact case; hardening
   * `browserEligibility` to also check `capabilities.codecs`/`audioEncoder`
   * is reported as an open item for A21.
   */
  test("POST /projects/{id}/exports still offers a working cloud path", async ({
    page,
    browser,
  }) => {
    const setupContext = await browser.newContext();
    const setupPage = await setupContext.newPage();
    const account = await freshAccount(setupPage, "export-fallback-cloud-e2e");
    await grantTestCredits(await workspaceIdFromPage(setupPage));
    await setupContext.close();
    const { projectId } = await seedEditorProject(page, account, {
      title: "A19 export fallback cloud e2e",
    });

    await page.goto(`/export-harness?projectId=${projectId}`);
    await page.waitForFunction(() => window.__exportHarness?.ready === true, undefined, {
      timeout: 60_000,
    });

    const accessToken = await page.evaluate(async () => {
      const response = await fetch("/api/session/refresh", { method: "POST" });
      const body = (await response.json()) as { accessToken: string };
      return body.accessToken;
    });

    const { capabilities, eligible } = await page.evaluate(async () => {
      const harness = window.__exportHarness;
      if (harness === undefined) throw new Error("harness not ready");
      const probe = await harness.lib.probeExportCapabilities();
      return {
        capabilities: harness.lib.toCapabilitiesRequest(probe),
        eligible: harness.lib.isBrowserExportEligible(probe),
      };
    });
    expect(eligible, "WebKit is expected to fail the client-side probe").toBe(false);

    // `use-export-dialog.ts`'s own rule: `mode` is never "auto" when the
    // client's own probe is ineligible.
    const response = await page.request.post(`${API_ORIGIN}/projects/${projectId}/exports`, {
      headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      data: { kind: "video", preset: "reels", mode: eligible ? "auto" : "cloud", capabilities },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const decision = (await response.json()) as { path: "browser" | "cloud"; reasons: string[] };
    expect(decision.path).toBe("cloud");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
