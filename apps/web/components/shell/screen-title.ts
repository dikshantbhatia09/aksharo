/**
 * Where you are, for the top bar.
 *
 * Under Nocturne the header carried a breadcrumb over a 15 px display-face
 * tagline ("Every style, every word tunable"), and every page then repeated
 * its own title underneath. Under Shirorekha each page opens with a
 * `PageHeader` that owns the one title (and the one shirorekha bar), so the
 * top bar only has to say which section you are in — in the SAME words the
 * nav uses, so the rail's "Styles" never lands on a header that says
 * "Caption styles" (HIG Writing › Build language patterns). Sub-pages that the
 * nav does not name get a second segment ("Settings › Profile").
 *
 * The rail shows icons and one-word captions, which is why this stays at all:
 * with the 68 px rail, this line is the only persistent place name in the
 * chrome (HIG Toolbars › Titles — a short title that confirms location).
 */
export interface ScreenTitle {
  /** The section, named exactly as the nav names it. */
  readonly crumb: string;
  /** A sub-page inside the section, when the section alone is ambiguous. */
  readonly title?: string;
}

/**
 * Longest prefix wins, so `/settings/languages` resolves before `/settings`.
 * Order in this array is irrelevant; {@link screenTitleFor} sorts by length.
 */
const STUDIO: ScreenTitle = { crumb: "Studio" };

const TITLES: readonly (readonly [prefix: string, crumb: string, title?: string])[] = [
  ["/", "Studio"],
  ["/projects", "Projects"],
  ["/p", "Editor"],
  ["/studio/styles", "Styles"],
  ["/repurpose", "Clips pipeline"],
  ["/billing", "Plan and credits"],
  ["/billing/plans", "Plan and credits", "Plans"],
  ["/billing/methods", "Plan and credits", "Payment methods"],
  ["/billing/invoices", "Plan and credits", "Invoices"],
  ["/billing/usage", "Plan and credits", "Usage"],
  ["/settings", "Settings"],
  ["/settings/profile", "Settings", "Profile"],
  ["/settings/languages", "Settings", "Languages & defaults"],
  ["/settings/memory", "Settings", "What Aksharo learned"],
  ["/settings/devices", "Settings", "Devices & sessions"],
  ["/settings/privacy", "Settings", "Privacy"],
  ["/settings/notifications", "Settings", "Notifications"],
  ["/settings/support", "Settings", "Support"],
  ["/settings/subscription", "Settings", "Subscription"],
  ["/settings/developers", "Settings", "Developers"],
  ["/templates", "Templates"],
  ["/onboarding", "First run"],
  ["/academy", "Academy"],
  ["/plugins", "Plugins"],
  ["/plugins/keys", "Plugins", "Licence keys"],
  ["/team", "Team"],
  ["/affiliate", "Refer & earn"],
  ["/help", "Help"],
  ["/updates", "What's new"],
];

/** Resolves a pathname to its header pair. Unknown routes fall back to the studio. */
export function screenTitleFor(pathname: string | null): ScreenTitle {
  const path = pathname ?? "/";
  let best: (typeof TITLES)[number] | undefined;
  for (const entry of TITLES) {
    const [prefix] = entry;
    const matches = prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`);
    if (!matches) continue;
    if (best === undefined || prefix.length > best[0].length) best = entry;
  }
  if (best === undefined) return STUDIO;
  return best[2] === undefined ? { crumb: best[1] } : { crumb: best[1], title: best[2] };
}
