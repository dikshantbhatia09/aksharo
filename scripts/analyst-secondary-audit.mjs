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

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function snap(page, name) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`📸 Saved screenshot: ${name}.png`);
  return filePath;
}

async function runSecondaryAudit() {
  console.log("🚀 Starting Analyst Secondary Audit: Subtitles, Downloads, Billing, Settings, Navigation");
  console.log("-------------------------------------------------------------------------------------");

  const errors = [];
  const networkErrors = [];

  const browser = await chromium.launch({
    headless: true,
    slowMo: 50,
    args: ["--disable-web-security", "--window-size=1440,900"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`[Console Error] ${msg.text()}`);
      console.log(`[Console Error] ${msg.text()}`);
    }
  });

  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("/favicon.ico")) {
      networkErrors.push(`[${res.status()}] ${res.request().method()} ${res.url()}`);
      console.warn(`[Network HTTP ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });

  try {
    // -------------------------------------------------------------
    // STEP 1: AUTHENTICATION
    // -------------------------------------------------------------
    console.log("\n[Step 1] Logging in as dikshantbhatia36@gmail.com...");
    await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    await page.fill('input[name="email"]', auditEmail);
    await page.fill('input[name="password"]', auditPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    console.log("✅ Authenticated successfully.");
    await page.waitForTimeout(1500);

    // -------------------------------------------------------------
    // STEP 2: SUBTITLES EXPORT AUDIT
    // -------------------------------------------------------------
    console.log("\n[Step 2] Testing Subtitle Export on Project 01M280AXK3M2Q58M32W7DKW0NA...");
    await page.goto("http://localhost:3000/p/01M280AXK3M2Q58M32W7DKW0NA", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const skipBtn = await page.$('button:has-text("Skip")');
    if (skipBtn) await skipBtn.click();

    const exportTopBtn = await page.$('button:has-text("Export"):not([data-testid="export-start"])');
    if (exportTopBtn) {
      await exportTopBtn.click();
      await page.waitForTimeout(1500);

      console.log("[Step 2] Switching to Subtitles tab...");
      const subtitlesTabTrigger = await page.$('[data-testid="export-tab-subtitles"]');
      if (subtitlesTabTrigger) {
        await subtitlesTabTrigger.click();
        await page.waitForTimeout(1000);
        await snap(page, "13_subtitles_tab_active");

        const srtCheckbox = await page.$('[data-testid="export-subtitle-format-srt"]');
        if (srtCheckbox) {
          const checked = await srtCheckbox.isChecked();
          if (!checked) await srtCheckbox.check();
        }

        console.log("[Step 2] Starting Subtitle Export...");
        const exportStartBtn = await page.$('[data-testid="export-start"]');
        if (exportStartBtn) {
          await exportStartBtn.click();
          await page.waitForTimeout(2000);

          console.log("[Step 2] Waiting for subtitle render completion...");
          let subtitleDownloadUrl = null;
          for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(2000);
            const status = await page.evaluate(() => {
              const dl = document.querySelector('[data-testid="export-download"] a');
              const err = document.querySelector('[data-testid="export-error"]');
              const cloudDl = document.querySelector('[data-testid="export-cloud-download"] a');
              return {
                downloadHref: dl ? dl.href : (cloudDl ? cloudDl.href : null),
                errorText: err ? err.textContent : null,
              };
            });

            if (status.errorText) {
              console.error("❌ Subtitle export error:", status.errorText);
              break;
            }
            if (status.downloadHref) {
              subtitleDownloadUrl = status.downloadHref;
              console.log("✅ Subtitle export ready! Download URL:", subtitleDownloadUrl);
              await snap(page, "13_subtitles_export_ready");
              break;
            }
          }

          if (subtitleDownloadUrl) {
            console.log("[Step 2] Verifying download URL fetch...");
            const dlResponse = await context.request.get(subtitleDownloadUrl);
            console.log(`[Step 2] Download HTTP status: ${dlResponse.status()}`);
            if (dlResponse.ok()) {
              const text = await dlResponse.text();
              console.log(`[Step 2] Subtitle sample content (first 200 chars):\n${text.slice(0, 200)}...`);
            }
          }
        }
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1000);
    }

    // -------------------------------------------------------------
    // STEP 3: PROJECTS PAGE AUDIT
    // -------------------------------------------------------------
    console.log("\n[Step 3] Auditing Projects list (/projects)...");
    await page.goto("http://localhost:3000/projects", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await snap(page, "14_projects_list");

    const projectCardsCount = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid^="project-card"], a[href^="/p/"]');
      return cards.length;
    });
    console.log(`[Step 3] Found ${projectCardsCount} project card(s) on /projects.`);

    // -------------------------------------------------------------
    // STEP 4: BILLING & CREDITS AUDIT
    // -------------------------------------------------------------
    console.log("\n[Step 4] Auditing Billing & Credits (/billing)...");
    await page.goto("http://localhost:3000/billing", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await snap(page, "15_billing_overview");

    const billingInfo = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      return {
        hasStudio: bodyText.includes("Studio"),
        hasCredits: bodyText.includes("credits") || bodyText.includes("Credit"),
      };
    });
    console.log("[Step 4] Billing page details:", billingInfo);

    console.log("[Step 4] Checking /billing/usage...");
    await page.goto("http://localhost:3000/billing/usage", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, "15_billing_usage");

    console.log("[Step 4] Checking /billing/plans...");
    await page.goto("http://localhost:3000/billing/plans", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, "15_billing_plans");

    // -------------------------------------------------------------
    // STEP 5: SETTINGS AUDIT
    // -------------------------------------------------------------
    console.log("\n[Step 5] Auditing Settings (/settings)...");
    await page.goto("http://localhost:3000/settings", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, "16_settings_profile");

    console.log("[Step 5] Checking /settings/languages...");
    await page.goto("http://localhost:3000/settings/languages", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, "17_settings_languages");

    console.log("[Step 5] Checking /settings/developers...");
    await page.goto("http://localhost:3000/settings/developers", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, "18_settings_developers");

    // -------------------------------------------------------------
    // STEP 6: ACADEMY & HELP AUDIT
    // -------------------------------------------------------------
    console.log("\n[Step 6] Auditing Academy (/academy)...");
    await page.goto("http://localhost:3000/academy", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, "19_academy_page");

    console.log("[Step 6] Auditing Help (/help)...");
    await page.goto("http://localhost:3000/help", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await snap(page, "20_help_page");

    console.log("\n================ AUDIT SUMMARY ================");
    console.log(`Total Console Errors Recorded: ${errors.length}`);
    console.log(`Total Network Errors (>=400) Recorded: ${networkErrors.length}`);
    if (networkErrors.length > 0) {
      console.log("Network error details:", networkErrors);
    }
    console.log("===============================================");

  } catch (err) {
    console.error("❌ Secondary Audit Error:", err);
    await snap(page, "98_secondary_audit_error");
  } finally {
    await browser.close();
  }
}

runSecondaryAudit().catch(console.error);
