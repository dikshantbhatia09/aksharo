import { BRAND } from "@montaj/config";

import type { MetadataRoute } from "next";

/**
 * `/robots.txt`. Disallows the authenticated studio and auth flows; legal
 * drafts stay crawlable but `noindex` via their own metadata.
 *
 * Lives at the true `app/` root rather than under `(site)/` (this WP's
 * file boundary) on purpose: `sitemap.ts` resolves correctly from inside a
 * route group (route groups are stripped from the URL for every file, and
 * `(site)/sitemap.ts` does produce `/sitemap.xml`), but `robots.ts` did not —
 * `pnpm --filter @montaj/web build` produced no `robots.txt` route at all from
 * `(site)/robots.ts`, confirmed by its absence from `.next/server/app` and a
 * live 404. Moving this one file to `app/robots.ts` is the smallest change
 * that makes the feature the brief asks for ("sitemap, robots") actually work;
 * everything else this WP owns stays inside `(site)/`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/studio", "/settings", "/onboarding", "/device", "/api/", "/admin", "/share"],
    },
    sitemap: `https://${BRAND.domain}/sitemap.xml`,
    host: `https://${BRAND.domain}`,
  };
}
