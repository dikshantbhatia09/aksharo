# Shirorekha — Aksharo's design system (replaces Nocturne, 2026-09-25)

Branch `redesign/new-direction`. This file is the brief every screen is rebuilt
against. Tokens live in `packages/ui/src/styles/tokens.css` (runtime) and
`packages/ui/src/tokens.ts` (data); `tokens.test.ts` pins the two together.

## Thesis

Aksharo turns Hindi, Hinglish and Indic speech into captions and short clips.
It is named for the *akshar*, the written syllable. **The footage and the
words are the subject; the chrome is a quiet, warm charcoal frame around them,
and it is signed in one place only: the shirorekha**, the headline bar that
Devanagari letters hang from, drawn as a short rani-pink bar above each page
title.

What this is deliberately not: blue-grey-and-blurple SaaS dark mode (what
Nocturne was), near-black with an acid accent, cream-and-serif editorial, or a
broadsheet of hairlines.

## Colour

Dark-only, on purpose: this is a video tool and footage is judged against a
dark surround. (Apple's HIG prefers following the system appearance; the
trade-off is recorded here, not an oversight.)

| Role | Token / utility | Hex | Contrast note |
|---|---|---|---|
| Page | `bg-bg-0` | `#141217` | |
| Card / panel | `bg-surface` = `bg-bg-1` | `#1f1c23` | |
| Raised / hover well | `bg-bg-2` | `#2a262f` | accent text NOT legal here, use `text-accent-300` |
| Rail / timeline / inset | `bg-sunken` | `#0e0c10` | |
| Video canvas | `bg-ink` | `#0b0a0c` | the one near-black |
| Border | `border-border` | `#36313a` | |
| Primary text | `text-fg-0` | `#f1ece6` | 14.3:1 on surface |
| Secondary text | `text-fg-1` | `#d6cfc8` | 10.9:1 on surface |
| Muted text | `text-fg-2` | `#a39a93` | 6.1:1 on surface, 5.4 on bg-2 |
| Disabled | `text-fg-disabled` | `#7c746e` | disabled only, exempt |
| **Accent (rani)** | `accent`, `lime-500`, `mint` | `#f0508a` | 5.0:1 on surface as text; ink on it 5.5:1 |
| Accent ramp | `accent-100…900` | `#fde8f0 … #2e1420` | 300 = `#f78bb0`, text on tints/raised (≥ 6.5:1) |
| Neutral ramp | `neutral-100…950` | warm grey | |
| Signals | `proposed/warning` `#e8b04a`, `accepted` `#6fcf97`, `rejected` `#ef7d4f`, `info` `#7fa6f5` | | all ≥ 6:1 on surface |
| Captions (content) | `caption-fill/highlight/stroke` | `#fff / #ffd400 / #000` | never the accent |

**Accent budget, per screen:** one filled primary button, the shirorekha bar
on the page title, the active nav row (`bg-accent/14 text-accent-200` or
`text-fg-0` with an accent bar), the active tab indicator, a switch that is on,
a filled meter, a checked checkbox, an unread dot, a selected card's ring
(`ring-1 ring-accent`). That is all. The one saturated field in the product is
the marketing home page's stat band (`bg-section`, a dark rani `#3a1427`);
nothing inside the app may use it.
No accent headings, accent icons in lists, accent-tinted card backgrounds, or
gradients. Signals are never decoration.

Never raw hex or `white/NN` / `black/NN` in components. Hover tints on dark
use `neutral-100/7`, press `neutral-100/14`.

## Type

- **Inter** (`font-sans`): every control, label, table and paragraph.
  Body `text-sm` (14 px); nothing interactive below `text-xs` (12 px);
  `text-2xs` (11 px) only for meta such as shortcut hints and timestamps.
- **Anek Latin** (`font-display`): page titles (through `PageHeader`), the
  marketing hero, and large stat figures. Nowhere else. Titles use it at
  weight 600, `font-stretch: 92%`.
- **JetBrains Mono** (`font-mono`): timecodes, IDs, keys.
- Headings default to Inter 600 with -0.015em tracking.
- Scale: 11 / 12 / 14 / 16 / 18 / 22 / 28 / 36 / 44.

Devanagari and other Indic text falls back to the on-demand Noto families
(`packages/ui/src/fonts/indic.ts`); never force a Latin face on it.

## Shape, space, depth

- Radii: `rounded-sm` 6 (controls, chips), `rounded-md` 10 (cards, menus),
  `rounded-lg` 16 (dialogs, sheets, hero tiles). Pills stay `rounded-full`.
- 4 px grid. Page gutter 24 px desktop / 16 px mobile; section gap 32–40 px;
  card padding 20 px (16 px compact).
- Depth is a hairline plus ambient shadow (`shadow-sm/md/lg`), never glows,
  never stacked blur. Glass/blur only on floating chrome (menus, the command
  palette), never on content.
- Dividers are plain hairlines (`rule-fade`, `rule-fade-b` — names are
  historical, they no longer fade).

## Signature: the shirorekha

`shirorekha` utility (tokens.css) / `<PageHeader>` (`@montaj/ui`): a 32 × 3 px
rani bar above the page title. Allowed on: each page's title (exactly once),
the brand mark, and at most one hero moment per screen (e.g. the marketing
hero, the empty-state headline on Home). Forbidden on cards, list rows, dialog
titles, buttons.

## Components

- `Button variant="primary"`: rani fill, ink text, **once per surface**.
  `secondary`: outline. `ghost`: text-only neutral. `danger`: filled rejected.
  `link`: `accent-300`, underlined.
- `PageHeader {eyebrow?, title, description?, actions?, size?}`: the top of every
  page. Replace ad-hoc `<h1>` + description blocks with it.
- Cards: `rounded-md border border-border bg-surface p-5`. No accent fill.
  Selected: `ring-1 ring-accent`.
- Tabs: underline indicator in the accent, label `text-fg-0` when active,
  `text-fg-2` otherwise.
- Lists / tables: row hover `bg-neutral-100/5`, dividers `border-border`.
- Empty states: a one-line headline, one sentence, one action that starts the
  next step. No illustrations of clipart.
- Inputs: `bg-sunken border-neutral-600 rounded-sm` (the border is 4.25:1 on
  sunken, clearing WCAG 1.4.11's 3:1 for a control boundary — `border-border`
  is only 1.3:1 and is for cards and dividers, not controls). Focus = the
  global focus ring.
- Icons: lucide, 16 px in controls and 20 px in nav, `text-fg-2`, stroke 1.75.
  Every icon-only control has an `aria-label`.

## Accessibility floor (non-negotiable)

- Text contrast ≥ 4.5:1 (≥ 3:1 at 18 px+ or 14 px bold+). Use the table above.
- Hit targets ≥ 32 × 32 px for pointer controls, 44 × 44 on touch layouts.
- Visible focus on every interactive element (global ring; never
  `outline-none` without a replacement).
- No information by colour alone: status chips carry a word or icon.
- `prefers-reduced-motion` is honoured globally in tokens.css.
- Layouts work from 360 px wide with no horizontal page scroll.

## Writing

Sentence case everywhere (the product's existing convention; kept rather than
switched to Apple title case, and it must be consistent). Buttons say what
happens ("Export video", not "Submit"); an action keeps its name through the
flow. Errors say what went wrong and what to do, without apologising.

## Rules carried over from the codebase

- Never remove a `data-testid`.
- Keep `.panel-range`, `.panel-swatch`, `.panel-switch` native.
- Client code imports `@montaj/caption-styles/browser`, not the barrel.
- Links inside an `<li>` used as navigation need `no-underline`.
