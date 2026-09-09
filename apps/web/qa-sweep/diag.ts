import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Page } from "@playwright/test";

export const OUT_DIR =
  process.env["QA_OUT"] ??
  "C:/Users/diksh/AppData/Local/Temp/claude/c--Dikshant-Crest-Mond/25f6dbc3-77fc-4d70-986a-42df9821b042/scratchpad/qa";

const LOG = `${OUT_DIR}/issues.ndjson`;

export interface Issue {
  kind: string;
  where: string;
  detail: string;
}

export function record(issue: Issue): void {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${JSON.stringify(issue)}\n`, "utf8");
}

/** Attach console / pageerror / failed-request / 4xx-5xx listeners. */
export function watch(page: Page, label: string): void {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    record({ kind: "console", where: `${label} :: ${page.url()}`, detail: msg.text().slice(0, 600) });
  });
  page.on("pageerror", (error) => {
    record({ kind: "pageerror", where: `${label} :: ${page.url()}`, detail: String(error).slice(0, 600) });
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (failure.includes("ERR_ABORTED")) return;
    record({
      kind: "requestfailed",
      where: `${label} :: ${page.url()}`,
      detail: `${request.method()} ${request.url().slice(0, 200)} — ${failure}`,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    record({
      kind: `http${String(response.status())}`,
      where: `${label} :: ${page.url()}`,
      detail: `${response.request().method()} ${response.url().slice(0, 200)}`,
    });
  });
}

export interface Overflow {
  scrollWidth: number;
  clientWidth: number;
  offenders: string[];
}

/** Horizontal overflow of the document plus the widest offending elements. */
export async function overflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const offenders: string[] = [];
    if (de.scrollWidth > de.clientWidth + 1) {
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right <= de.clientWidth + 1 && rect.left >= -1) continue;
        const style = getComputedStyle(el);
        if (style.position === "fixed") continue;
        const cls = typeof el.className === "string" ? el.className.slice(0, 90) : "";
        offenders.push(
          `<${el.tagName.toLowerCase()} class="${cls}" data-testid="${el.getAttribute("data-testid") ?? ""}"> left=${String(Math.round(rect.left))} right=${String(Math.round(rect.right))}`,
        );
      }
    }
    return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, offenders: offenders.slice(0, 6) };
  });
}

export async function shot(page: Page, name: string): Promise<string> {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}
