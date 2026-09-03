/**
 * Static copy for the `/docs` landing sections. Not MDX: unlike the
 * academy/help/changelog collections (B12's `content/{academy,help,changelog}`),
 * every `/docs` section's substantive body already lives elsewhere — help
 * article MDX (B12), plugin READMEs (C05a/C05b/C08), the OpenAPI document —
 * so this file holds only the four section blurbs the `/docs` index page
 * shows above those generated lists.
 */
export interface DocsSectionSummary {
  readonly id: "guides" | "plugins" | "developers" | "legal";
  readonly title: string;
  readonly description: string;
  readonly href: string;
}

export const DOCS_SECTIONS: readonly DocsSectionSummary[] = [
  {
    id: "guides",
    title: "Guides",
    description: "How-tos for editing, captions and styles, exporting, billing and your account.",
    href: "/docs/guides",
  },
  {
    id: "plugins",
    title: "Plugins",
    description:
      "Install and use the Aksharo panel inside Premiere Pro, After Effects and DaVinci Resolve.",
    href: "/docs/plugins",
  },
  {
    id: "developers",
    title: "Developers",
    description:
      "The public API: authentication, endpoints, webhooks, rate limits and SDK snippets.",
    href: "/docs/developers",
  },
  {
    id: "legal",
    title: "Legal",
    description:
      "Terms of Service, Privacy notice, Acceptable Use Policy and the Data Processing Addendum.",
    href: "/legal",
  },
];
