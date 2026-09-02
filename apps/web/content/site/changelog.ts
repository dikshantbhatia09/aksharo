/**
 * The public changelog (A24 brief: "changelog page reading from
 * `changelog_entries` when B12 lands (static JSON now)").
 *
 * `ChangelogEntry` mirrors the shape a future `changelog_entries` table row
 * would take, so `/changelog` swaps its data source without changing its
 * rendering. The list starts empty on purpose: the product has not launched
 * (13-launch-plan.md is a *pre*-launch plan), and a marketing changelog listing
 * features as "shipped" before they are live to a customer would be exactly the
 * kind of unverified claim the rest of this work package goes out of its way
 * not to make. The page still renders correctly with zero entries.
 */

export interface ChangelogEntry {
  readonly id: string;
  readonly date: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

export const CHANGELOG_ENTRIES: readonly ChangelogEntry[] = [];
