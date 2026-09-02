import { SiteFooter } from "./_components/site-footer";
import { SiteHeader } from "./_components/site-header";

import type { ReactNode } from "react";

/**
 * The marketing shell: header, a skip link and a footer, wrapping every page
 * under `(site)/(marketing)` — home, features, styles, pricing, plugins,
 * download, `/vs/*`, `/legal/*` and `/changelog`.
 *
 * Nested one level inside `(site)`, not applied to the group itself, so A13's
 * auth pages (`login`, `signup`, `device`, `magic`, `verify`, `auth/*`), which
 * sit directly under `(site)`, are unaffected and keep their own minimal
 * chrome.
 */
export default function MarketingLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" data-testid="marketing-main">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
