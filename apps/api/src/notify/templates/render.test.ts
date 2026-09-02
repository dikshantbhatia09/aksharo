import { beforeEach, describe, expect, it } from "vitest";

import { BRAND, CODENAME } from "@montaj/config";

import { escapeHtml, safeUrl } from "./layout.js";
import { EN_MESSAGES } from "./messages.en.js";
import { HI_MESSAGES } from "./messages.hi.js";
import {
  catalogueFor,
  normaliseLocale,
  placeholdersIn,
  renderNotification,
  resetTemplateCache,
  TemplateRenderError,
} from "./render.js";
import { NOTIFY_KINDS } from "../notify.kinds.js";

import type { TemplateData } from "./render.js";
import type { NotifyKind } from "../notify.kinds.js";

/**
 * Every variable each kind needs, with values chosen to be recognisable in a
 * snapshot. Plurals are exercised with a number that is not 1, and the singular
 * is covered by its own case below.
 */
const DATA: Readonly<Record<NotifyKind, TemplateData>> = {
  "verify-email": { name: "Asha", link: "https://app.example.test/verify?token=abc", hours: 24 },
  "magic-link": { name: "Asha", link: "https://app.example.test/magic?token=abc", minutes: 15 },
  "password-changed": { name: "Asha", link: "https://app.example.test/settings/sessions" },
  "device-approval": {
    name: "Asha",
    device: "Studio iMac",
    hostApp: "Premiere Pro",
    location: "Mumbai, India",
    link: "https://app.example.test/device?code=WXYZ",
    minutes: 10,
  },
  "login-new-device": {
    name: "Asha",
    device: "Pixel 9",
    location: "Pune, India",
    at: "14:32 IST",
    link: "https://app.example.test/settings/sessions",
  },
  "parental-waitlist": {},
  "renewal-notice": {
    name: "Asha",
    plan: "Creator",
    amount: "₹1,499",
    renewsOn: "12 October 2026",
    days: 3,
    link: "https://app.example.test/settings/plan",
  },
  "low-credits": { name: "Asha", minutes: 12, link: "https://app.example.test/billing/top-up" },
  "export-ready": {
    name: "Asha",
    project: "Diwali promo",
    days: 7,
    link: "https://app.example.test/exports/01J",
  },
  "share-comment": {
    name: "Asha",
    project: "Diwali promo",
    author: "Ravi",
    count: 3,
    link: "https://app.example.test/p/01J/review",
  },
  "streak-nudge": {
    name: "Asha",
    days: 1,
    level: 2,
    link: "https://app.example.test/billing",
  },
};

const UNSUBSCRIBE = "https://app.example.test/settings/notifications";

beforeEach(() => {
  resetTemplateCache();
});

describe("locale selection", () => {
  it("drops the region and falls back to English", () => {
    expect(normaliseLocale("hi-IN")).toBe("hi");
    expect(normaliseLocale("HI")).toBe("hi");
    expect(normaliseLocale("en_US")).toBe("en");
    expect(normaliseLocale("mr-IN")).toBe("en");
    expect(normaliseLocale(undefined)).toBe("en");
    expect(normaliseLocale("")).toBe("en");
  });

  it("hands back the catalogue for the language, with its own ICU tag", () => {
    expect(catalogueFor("hi-IN")).toBe(HI_MESSAGES);
    expect(catalogueFor("hi-IN").locale).toBe("hi-IN");
    expect(catalogueFor("fr")).toBe(EN_MESSAGES);
  });
});

describe("the two catalogues", () => {
  /**
   * The failure this prevents: a translator drops `{minutes}` from one sentence,
   * nothing breaks in English, and every Hindi-speaking user stops receiving
   * magic links because ICU throws at send time.
   */
  it("reference the same variables in every kind", () => {
    for (const kind of NOTIFY_KINDS) {
      const en = EN_MESSAGES.kinds[kind];
      const hi = HI_MESSAGES.kinds[kind];
      const namesOf = (strings: typeof en): string[] =>
        [
          ...placeholdersIn(strings.subject),
          ...placeholdersIn(strings.heading),
          ...strings.paragraphs.flatMap((line) => [...placeholdersIn(line)]),
          ...(strings.footnotes ?? []).flatMap((line) => [...placeholdersIn(line)]),
        ].sort();
      expect([...new Set(namesOf(hi))], `${kind} differs`).toEqual([...new Set(namesOf(en))]);
    }
  });

  it("give every kind a subject, a heading and at least one paragraph", () => {
    for (const catalogue of [EN_MESSAGES, HI_MESSAGES]) {
      for (const kind of NOTIFY_KINDS) {
        const strings = catalogue.kinds[kind];
        expect(strings.subject.length, `${catalogue.locale} ${kind}`).toBeGreaterThan(0);
        expect(strings.heading.length).toBeGreaterThan(0);
        expect(strings.paragraphs.length).toBeGreaterThan(0);
      }
    }
  });

  it("never writes a brand word or the codename into a string", () => {
    for (const catalogue of [EN_MESSAGES, HI_MESSAGES]) {
      const everything = JSON.stringify(catalogue);
      // Brand words arrive as `{brand}` / `{support}` from `@montaj/config`.
      expect(everything).not.toContain(BRAND.name);
      expect(everything.toLowerCase()).not.toContain(CODENAME);
    }
  });
});

describe("rendering", () => {
  it.each(NOTIFY_KINDS)("renders %s in English", (kind) => {
    const rendered = renderNotification({
      kind,
      locale: "en-IN",
      data: DATA[kind],
      unsubscribeUrl: UNSUBSCRIBE,
    });
    expect(rendered.locale).toBe("en");
    expect({ subject: rendered.subject, text: rendered.text }).toMatchSnapshot();
  });

  it.each(NOTIFY_KINDS)("renders %s in Hindi", (kind) => {
    const rendered = renderNotification({
      kind,
      locale: "hi-IN",
      data: DATA[kind],
      unsubscribeUrl: UNSUBSCRIBE,
    });
    expect(rendered.locale).toBe("hi");
    expect({ subject: rendered.subject, text: rendered.text }).toMatchSnapshot();
  });

  it("produces the same HTML shell for one kind, in both languages", () => {
    const english = renderNotification({ kind: "export-ready", data: DATA["export-ready"] });
    const hindi = renderNotification({
      kind: "export-ready",
      locale: "hi",
      data: DATA["export-ready"],
    });
    expect(english.html).toMatchSnapshot("export-ready.en.html");
    expect(hindi.html).toContain('<html lang="hi"');
    expect(hindi.html).not.toBe(english.html);
  });

  it("never emits a remote image, and therefore never a tracking pixel", () => {
    for (const kind of NOTIFY_KINDS) {
      const { html } = renderNotification({ kind, data: DATA[kind], unsubscribeUrl: UNSUBSCRIBE });
      expect(html, kind).not.toMatch(/<img/i);
      expect(html, kind).not.toMatch(/background-image/i);
    }
  });

  it("puts the button URL in the body as text as well, so a stripped button is not a dead end", () => {
    const { html, text } = renderNotification({
      kind: "verify-email",
      data: DATA["verify-email"],
    });
    const link = String(DATA["verify-email"]["link"]);
    expect(text).toContain(link);
    expect(html).toContain(escapeHtml(link));
    expect(
      html.match(new RegExp(escapeHtml(link).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
    ).toHaveLength(2);
  });

  it("selects the singular and the plural from the same string", () => {
    const one = renderNotification({
      kind: "share-comment",
      data: { ...DATA["share-comment"], count: 1 },
    });
    const many = renderNotification({
      kind: "share-comment",
      data: { ...DATA["share-comment"], count: 4 },
    });
    expect(one.subject).toContain("1 new comment");
    expect(one.subject).not.toContain("comments");
    expect(many.subject).toContain("4 new comments");
  });

  it("drops the host-app clause when there is no host app", () => {
    const withHost = renderNotification({ kind: "device-approval", data: DATA["device-approval"] });
    const withoutHost = renderNotification({
      kind: "device-approval",
      data: { ...DATA["device-approval"], hostApp: "none" },
    });
    expect(withHost.text).toContain("sign in to Aksharo from Premiere Pro");
    expect(withoutHost.text).toContain("sign in to Aksharo.");
    expect(withoutHost.text).not.toContain("Premiere Pro");
  });

  it("uses the language's own fallback when a name is missing", () => {
    const english = renderNotification({
      kind: "verify-email",
      data: { link: "https://app.example.test/v", hours: 24 },
    });
    const hindi = renderNotification({
      kind: "verify-email",
      locale: "hi",
      data: { link: "https://app.example.test/v", hours: 24 },
    });
    expect(english.text).toContain("Hi there,");
    expect(hindi.text).toContain("नमस्ते जी,");
  });

  it("escapes a value that contains markup, in the HTML and not in the text", () => {
    const rendered = renderNotification({
      kind: "export-ready",
      data: { ...DATA["export-ready"], project: '<script>alert("x")</script>' },
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.text).toContain("<script>");
  });

  it("refuses a javascript: link and falls back to the brand site", () => {
    const rendered = renderNotification({
      kind: "export-ready",

      data: { ...DATA["export-ready"], link: "javascript:alert(1)" },
    });
    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.text).toContain(`https://${BRAND.domain}/`);
  });

  it("adds the unsubscribe line only to the kinds that allow it", () => {
    const nudge = renderNotification({
      kind: "low-credits",
      data: DATA["low-credits"],
      unsubscribeUrl: UNSUBSCRIBE,
    });
    const transactional = renderNotification({
      kind: "verify-email",
      data: DATA["verify-email"],
      unsubscribeUrl: UNSUBSCRIBE,
    });
    expect(nudge.html).toContain(UNSUBSCRIBE);
    expect(nudge.text).toContain("Turn off these emails");
    expect(transactional.html).not.toContain(UNSUBSCRIBE);
  });

  it("fails loudly when a variable is missing rather than rendering a gap", () => {
    expect(() => renderNotification({ kind: "renewal-notice", data: { name: "Asha" } })).toThrow(
      TemplateRenderError,
    );
  });

  it("caches a compiled message without changing the output", () => {
    const first = renderNotification({ kind: "low-credits", data: DATA["low-credits"] });
    const second = renderNotification({ kind: "low-credits", data: DATA["low-credits"] });
    expect(second.html).toBe(first.html);
  });
});

describe("safeUrl", () => {
  it("passes http and https through and replaces everything else", () => {
    expect(safeUrl("https://example.test/a?b=1")).toBe("https://example.test/a?b=1");
    expect(safeUrl("http://example.test/")).toBe("http://example.test/");
    expect(safeUrl("data:text/html,<b>")).toBe(`https://${BRAND.domain}/`);
    expect(safeUrl("not a url")).toBe(`https://${BRAND.domain}/`);
  });
});

describe("placeholdersIn", () => {
  it("finds simple and argument placeholders and ignores literals", () => {
    expect(
      [...placeholdersIn("Hi {name}, {count, plural, one {#} other {#}} left")].sort(),
    ).toEqual(["count", "name"]);
    expect([...placeholdersIn("nothing here")]).toEqual([]);
  });
});
