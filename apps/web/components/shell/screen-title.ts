/**
 * The header's two lines.
 *
 * The canvas's header is a breadcrumb in 9.5 px uppercase over a 15 px title —
 * "LIBRARY / 24 projects", "PLAN AND CREDITS / Creator, renews 1 Oct". It is
 * the only place in the shell that names where you are, because the rail
 * shows an icon and a one-word caption and nothing else.
 *
 * The title is the specific half and often depends on data the header does not
 * have (a project's name, a credit balance), so `crumb` here is always right
 * and `title` is the fallback a screen can override by passing its own through
 * {@link ScreenTitle}.
 */
export interface ScreenTitle {
  readonly crumb: string;
  readonly title: string;
}

/**
 * Longest prefix wins, so `/settings/languages` resolves before `/settings`.
 * Order in this array is irrelevant; {@link screenTitleFor} sorts by length.
 */
const STUDIO: ScreenTitle = { crumb: "Aksharo studio", title: "Your studio" };

const TITLES: readonly (readonly [prefix: string, crumb: string, title: string])[] = [
  ["/", STUDIO.crumb, STUDIO.title],
  ["/projects", "Library", "Every project"],
  ["/p", "Project", "Caption editor"],
  ["/studio/styles", "Caption styles", "Every style, every word tunable"],
  ["/repurpose", "Repurpose run", "One long video, nine posts"],
  ["/billing", "Plan and credits", "Your plan and what it buys"],
  ["/settings", "Settings", "Your studio, your defaults"],
  ["/settings/profile", "Settings", "Profile"],
  ["/settings/languages", "Settings", "Languages and defaults"],
  ["/settings/memory", "Settings", "What Aksharo learned"],
  ["/settings/devices", "Settings", "Devices and sessions"],
  ["/settings/privacy", "Settings", "Privacy"],
  ["/settings/notifications", "Settings", "Notifications"],
  ["/settings/support", "Settings", "Support"],
  ["/settings/subscription", "Settings", "Subscription"],
  ["/settings/developers", "Settings", "Developers"],
  ["/onboarding", "First run", "Four questions, then you are in"],
  ["/academy", "Academy", "Learn the studio"],
  ["/plugins", "Plugins", "Premiere, After Effects and Resolve"],
  ["/team", "Team", "Seats and roles"],
  ["/affiliate", "Refer and earn", "Your referral programme"],
  ["/help", "Help", "Guides and support"],
  ["/updates", "Updates", "What is new"],
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
  return { crumb: best[1], title: best[2] };
}
