/**
 * The marketing site's footer: every page carries the legal links, the
 * grievance officer contact and the Adobe/Blackmagic attribution line
 * (08-ux-design-system.md §Marketing site legal footer and plugin naming).
 */

"use client";

import Link from "next/link";

import { BRAND } from "@montaj/config";

import { useRuntimeConfig } from "@/components/providers";
import { ATTRIBUTION_LINE, GRIEVANCE_OFFICER } from "@/content/site/legal";
import {
  FOOTER_COMPARE_NAV,
  FOOTER_LEGAL_NAV,
  FOOTER_PRODUCT_NAV,
  visibleNav,
  type SiteNavItem,
} from "@/content/site/nav";

function FooterColumn({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly SiteNavItem[];
}): React.JSX.Element {
  return (
    <div>
      <h2 className="text-fg-2 text-xs font-semibold tracking-wide uppercase">{title}</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="text-fg-1 hover:text-fg-0 text-sm">
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter(): React.JSX.Element {
  // Plugins and Download lead to products that are not in this release (P0-12).
  const { flags } = useRuntimeConfig();

  return (
    <footer className="border-border border-t" data-testid="site-footer">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 py-12 sm:px-6 md:grid-cols-4">
        <div className="col-span-2 md:col-span-1">
          <p className="font-display text-fg-0 text-lg font-semibold">{BRAND.name}</p>
          <p className="text-fg-2 mt-2 text-sm">
            Captions, cuts and polish for Indian video creators.
          </p>
          <p className="text-fg-2 mt-4 text-sm">
            <a href={`mailto:${BRAND.supportEmail}`} className="hover:text-fg-0">
              {BRAND.supportEmail}
            </a>
          </p>
        </div>

        <FooterColumn title="Product" items={visibleNav(FOOTER_PRODUCT_NAV, flags)} />
        {FOOTER_COMPARE_NAV.length > 0 ? (
          <FooterColumn title="Compare" items={FOOTER_COMPARE_NAV} />
        ) : null}
        <FooterColumn title="Legal" items={FOOTER_LEGAL_NAV} />
      </div>

      <div className="border-border border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 sm:px-6">
          <p className="text-fg-2 text-xs">{ATTRIBUTION_LINE}</p>
          <p className="text-fg-2 text-xs">
            Grievance Officer:{" "}
            <a href={`mailto:${GRIEVANCE_OFFICER.email}`} className="hover:text-fg-0 underline">
              {GRIEVANCE_OFFICER.email}
            </a>{" "}
            — see the{" "}
            <Link href="/legal/grievance" className="hover:text-fg-0 underline">
              Grievance Officer page
            </Link>{" "}
            for our published response timelines.
          </p>
          <p className="text-fg-2 text-xs">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
