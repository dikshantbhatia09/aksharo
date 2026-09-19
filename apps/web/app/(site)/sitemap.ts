import { BRAND } from "@montaj/config";

import type { MetadataRoute } from "next";

import { isServerSurfaceEnabled } from "@/content/site/launch-surfaces";
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
 *
 * Excludes unreleased surfaces (e.g. `/download`, `/plugins`, `/docs/plugins/*`)
 * when their corresponding launch surfaces are not enabled (RLS-006 crawler gate).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = `https://${BRAND.domain}`;
  const now = new Date();

  const pluginsEnabled = isServerSurfaceEnabled("plugins");
  const desktopEnabled = isServerSurfaceEnabled("desktop");

  const staticRoutes = [
    "/",
    "/features",
    "/styles",
    "/pricing",
    ...(pluginsEnabled ? ["/plugins"] : []),
    ...(desktopEnabled ? ["/download"] : []),
    "/changelog",
    "/docs",
    "/docs/guides",
    ...(pluginsEnabled ? ["/docs/plugins"] : []),
    "/docs/developers",
  ];

  const docsGuideRoutes = loadHelpArticles().map((article) => `/docs/guides/${article.slug}`);
  const docsPluginRoutes = pluginsEnabled
    ? loadPluginGuides().map((guide) => `/docs/plugins/${guide.slug}`)
    : [];
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
  ];
}
