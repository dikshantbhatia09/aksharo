import { BRAND } from "@montaj/config";

import type { MetadataRoute } from "next";

import { LEGAL_DOCS } from "@/content/site/legal";
import { loadHelpArticles } from "@/lib/content/loader";
import { loadApiGroups } from "@/lib/docs/openapi";
import { loadPluginGuides } from "@/lib/docs/plugin-guides";
import { API_VERSIONS } from "@/lib/docs/schema";

/**
 * `/sitemap.xml`. Lives under `(site)` — a route group is stripped from the
 * URL the same way for a metadata file as for a page, so this resolves at the
 * domain root regardless of nesting.
 *
 * Excludes `/legal/*` (marked `noindex` — draft, pending counsel) and the auth
 * pages A13 owns (`/login`, `/signup`, …), which have no reason to rank.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = `https://${BRAND.domain}`;
  const now = new Date();

  const staticRoutes = [
    "/",
    "/features",
    "/styles",
    "/pricing",
    "/plugins",
    "/download",
    "/changelog",
    "/docs",
    "/docs/guides",
    "/docs/plugins",
    "/docs/developers",
  ];

  const docsGuideRoutes = loadHelpArticles().map((article) => `/docs/guides/${article.slug}`);
  const docsPluginRoutes = loadPluginGuides().map((guide) => `/docs/plugins/${guide.slug}`);
  const docsApiRoutes = API_VERSIONS.flatMap((version) => [
    `/docs/developers/${version}`,
    ...loadApiGroups().map((group) => `/docs/developers/${version}/${group.tag}`),
  ]);

  return [
    ...staticRoutes.map((path) => ({
      url: `${base}${path}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: path === "/" ? 1 : 0.7,
    })),
    ...[...docsGuideRoutes, ...docsPluginRoutes, ...docsApiRoutes].map((path) => ({
      url: `${base}${path}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    // Legal docs are `noindex` (drafts pending counsel) but still worth listing
    // for a crawler that already found them via the footer.
    ...LEGAL_DOCS.map((doc) => ({
      url: `${base}/legal/${doc.slug}`,
      lastModified: now,
      changeFrequency: "yearly" as const,
      priority: 0.2,
    })),
  ];
}
