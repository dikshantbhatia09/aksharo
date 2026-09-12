import pkg from "../apps/web/node_modules/@playwright/test/index.js";
const { chromium } = pkg;
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const auditEmail = process.env.AKSHARO_AUDIT_EMAIL;
const auditPassword = process.env.AKSHARO_AUDIT_PASSWORD;
if (!auditEmail || !auditPassword) {
  throw new Error("Set AKSHARO_AUDIT_EMAIL and AKSHARO_AUDIT_PASSWORD before running this audit.");
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-web-security", "--window-size=1440,900"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', auditEmail);
  await page.fill('input[name="password"]', auditPassword);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("/login"));

  // Navigate to newly created project
  await page.goto("http://localhost:3000/p/01M281T2HZ6M0FZ8NQR5X2KVDM", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(5000);

  const skip = await page.$('button:has-text("Skip")');
  if (skip) {
    await skip.click();
    await page.waitForTimeout(1000);
  }

  const shotPath = path.resolve(__dirname, "../docs/analyst-audit/screenshots/12_new_project_editor.png");
  await page.screenshot({ path: shotPath });
  console.log(`Saved screenshot: ${shotPath}`);

  await browser.close();
}

main().catch(console.error);
