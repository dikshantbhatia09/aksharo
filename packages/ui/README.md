# @montaj/ui

The Aksharo design system: the tokens of `03-architecture/08-ux-design-system.md` §1
and the components of §2.

**Status:** implemented (A13).

## Consumed as source

The package exports TypeScript, not a build: `apps/web` lists it in
`transpilePackages`, so Next compiles the `"use client"` boundaries with the rest
of the app. `pnpm --filter @montaj/ui build` is therefore a type-check gate, not
an emit, and nothing here ends up in `dist/`.

Two lines wire it into an app:

```ts
// next.config.ts
transpilePackages: ["@montaj/ui"],
```

```css
/* app/globals.css */
@import "tailwindcss";
@import "@montaj/ui/tokens.css";
@source "../../../packages/ui/src"; /* so Tailwind scans the components too */
```

## Tokens

`src/styles/tokens.css` **is** the Tailwind preset — v4 is configured in CSS, so
the `@theme` block registers every colour, radius, type step and motion token as
a utility namespace (`bg-bg-1`, `text-fg-2`, `border-border`, `rounded-md`,
`text-2xs`). `src/tokens.ts` carries the same values as data for code that has to
reason about a colour (a canvas overlay, a generated image); `tokens.test.ts`
fails if the two drift.

| Group    | Tokens                                                                  |
| -------- | ----------------------------------------------------------------------- |
| Surfaces | `bg-0` `bg-1` `bg-2` `border` `overlay`                                 |
| Text     | `fg-0` `fg-1` `fg-2` `fg-disabled`                                      |
| Accent   | `lime-500` `lime-600` `on-accent`                                       |
| Signals  | `proposed` `accepted` `rejected` `info` `warning`                       |
| Captions | `caption-fill` `caption-highlight` `caption-stroke`                     |
| Radii    | `sm` 8px · `md` 12px · `lg` 16px                                        |
| Motion   | `--animate-duration-fast/base/slow` (120/160/200 ms), `--ease-out-soft` |

The studio is **dark-only** in v1: there is one palette on `:root` and no light
override. `prefers-reduced-motion` collapses UI transitions — caption animation
is content and is governed by export settings, not by this rule.

**Focus** is one lime double-ring on `:focus-visible`, defined once. **Prose
links** (inside `p`, `li`, `dd`, …) are underlined, because lime-on-black is
colour alone and axe is right to call that a failure.

## Type

`next/font` mints `--font-inter`, `--font-bricolage` and `--font-jetbrains-mono`
in the app; this package only consumes them, with a system fallback so a
component rendered outside Next still has type. The nine Indic Noto families are
**not** preloaded: `loadIndicFont(script)` inserts one the first time that script
is actually rendered (08 §1).

## Layout

```
src/tokens.ts            palette, radii and motion as data
src/styles/tokens.css    the Tailwind v4 preset and the base layer
src/lib/cn.ts            clsx + tailwind-merge
src/fonts/indic.ts       on-demand Noto loading, language → script
src/primitives/          shadcn/ui over Radix: button, input, label, dialog,
                         sheet, tabs, tooltip, dropdown-menu, toast (sonner),
                         command (cmdk), toggles, surface
src/components/          CreditMeter, JobProgress, UpgradeGate, StatusChip,
                         LangChip, ShortcutHint, EmptyState
```

Every component state is rendered on `/(admin)/ui-kit` in `apps/web`, which the
Playwright suite screenshots into `apps/web/e2e/__screenshots__/` and runs axe
over — so an inaccessible primitive fails a test rather than shipping into
thirty screens.

## Scripts

| Script                               | What it does                                    |
| ------------------------------------ | ----------------------------------------------- |
| `pnpm --filter @montaj/ui build`     | `tsc --noEmit`: the type-check gate             |
| `pnpm --filter @montaj/ui typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/ui lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/ui test`      | Vitest + Testing Library (jsdom)                |

Coverage gate 60/50, the UI tier of CONTRACTS §9.
