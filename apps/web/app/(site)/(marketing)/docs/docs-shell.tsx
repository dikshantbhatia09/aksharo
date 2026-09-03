"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { Input } from "@montaj/ui";

import type { DocsNavSection, DocsSearchDoc } from "@/lib/docs/schema";

import { loadDocsSearchIndex } from "@/lib/docs/search";

/** `path.split("/")` for `/docs/developers/v1/projects` -> readable crumbs:
 * Docs / Developers / V1 / Projects. Labels come from the nav where a segment
 * matches a known href, so "Developers" reads correctly instead of the raw
 * "developers" segment; unmatched segments (a dynamic `[slug]`, `v1`) fall
 * back to a humanised version of the segment itself. */
function useBreadcrumb(nav: readonly DocsNavSection[]): { label: string; href: string }[] {
  const pathname = usePathname();
  return React.useMemo(() => {
    const segments = pathname.split("/").filter(Boolean); // ["docs", ...]
    const crumbs: { label: string; href: string }[] = [{ label: "Docs", href: "/docs" }];
    let href = "";
    for (const segment of segments) {
      href += `/${segment}`;
      if (href === "/docs") continue;
      const known = nav
        .flatMap((section) => [{ href: section.href, label: section.label }, ...section.items])
        .find((entry) => entry.href === href);
      const label =
        known?.label ?? segment.charAt(0).toUpperCase() + segment.slice(1).replaceAll("-", " ");
      crumbs.push({ label, href });
    }
    return crumbs;
  }, [pathname, nav]);
}

function DocsBreadcrumb({ nav }: { readonly nav: readonly DocsNavSection[] }): React.JSX.Element {
  const crumbs = useBreadcrumb(nav);
  return (
    <nav aria-label="Breadcrumb" data-testid="docs-breadcrumb" className="text-fg-2 text-xs">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((crumb, index) => (
          <li key={crumb.href} className="flex items-center gap-1">
            {index > 0 ? <span aria-hidden>/</span> : null}
            {index === crumbs.length - 1 ? (
              <span className="text-fg-1" aria-current="page">
                {crumb.label}
              </span>
            ) : (
              <Link href={crumb.href} className="hover:text-fg-1 hover:underline">
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function DocsSidebar({ nav }: { readonly nav: readonly DocsNavSection[] }): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav aria-label="Docs navigation" data-testid="docs-sidebar" className="flex flex-col gap-6">
      {nav.map((section) => (
        <div key={section.id}>
          <Link
            href={section.href}
            className="text-fg-0 text-sm font-semibold hover:underline"
            data-testid={`docs-nav-section-${section.id}`}
          >
            {section.label}
          </Link>
          {section.items.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1.5 border-l pl-3">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={pathname === item.href ? "page" : undefined}
                    className={
                      pathname === item.href
                        ? "text-accent text-xs font-medium"
                        : "text-fg-2 hover:text-fg-0 text-xs"
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </nav>
  );
}

function DocsSearch({ searchIndex }: { readonly searchIndex: string }): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const index = React.useMemo(() => loadDocsSearchIndex(searchIndex), [searchIndex]);
  const results: DocsSearchDoc[] = React.useMemo(() => {
    if (query.trim() === "") return [];
    return index.search(query).map((result) => ({
      id: String(result.id),
      title: String(result.title),
      summary: String(result.summary),
      body: "",
      section: result.section as DocsSearchDoc["section"],
      href: String(result.href),
    }));
  }, [query, index]);

  return (
    <div className="relative" data-testid="docs-search">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search the docs"
        aria-label="Search the docs"
        data-testid="docs-search-input"
      />
      {query.trim() !== "" ? (
        <ul
          className="bg-bg-0 border-border absolute z-10 mt-1 flex w-full flex-col gap-1 rounded-md border p-1 shadow-md"
          data-testid="docs-search-results"
        >
          {results.length === 0 ? (
            <li className="text-fg-2 px-2 py-1.5 text-xs">No docs match &quot;{query}&quot;.</li>
          ) : (
            results.map((result) => (
              <li key={result.id}>
                <Link href={result.href} className="block rounded-sm px-2 py-1.5 hover:bg-bg-2">
                  <p className="text-fg-0 text-xs font-medium">{result.title}</p>
                  <p className="text-fg-2 text-2xs">{result.summary}</p>
                </Link>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function DocsShell({
  nav,
  searchIndex,
  children,
}: {
  readonly nav: readonly DocsNavSection[];
  readonly searchIndex: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[240px_1fr]">
      <aside className="flex flex-col gap-6 lg:sticky lg:top-16 lg:h-fit">
        <DocsSearch searchIndex={searchIndex} />
        <DocsSidebar nav={nav} />
      </aside>
      <div className="flex flex-col gap-6" data-testid="docs-content">
        <DocsBreadcrumb nav={nav} />
        {children}
      </div>
    </div>
  );
}
