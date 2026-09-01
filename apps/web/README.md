# @montaj/web

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind v4 + shadcn/ui. One
codebase for the marketing site and the studio, split by route group.

**Status:** A01 scaffold — one placeholder page per route group, a `/health`
route handler and a Playwright smoke test.

## Route groups

| Group     | URL       | Purpose                                          | Built in |
| --------- | --------- | ------------------------------------------------ | -------- |
| `(site)`  | `/`       | marketing, pricing, styles gallery, downloads    | A24      |
| `(app)`   | `/studio` | authenticated studio: projects, editor, timeline | A13–A17  |
| `(share)` | `/share`  | public review links, comments, approvals         | B15      |
| `(admin)` | `/admin`  | staff console behind its own guard + MFA         | B13      |

Route groups do not affect the URL — `app/(site)/page.tsx` is `/`. They exist so
each surface can own its layout, auth boundary and error handling.

## Run

```bash
pnpm --filter @montaj/web dev     # http://localhost:3000
```

## Styling

Tailwind v4 is configured **in CSS** (`app/globals.css`), not in a JS config
file. shadcn/ui is wired through `components.json` with the `new-york` style and
CSS variables; `components/ui/button.tsx` is the first component and shows the
pattern. A13 replaces these tokens with the real design system and moves the
shared primitives into `@montaj/ui`.

```bash
pnpm --filter @montaj/web exec shadcn@latest add dialog
```

## Tests

```bash
pnpm --filter @montaj/web test              # vitest units (lib/, components/)
pnpm --filter @montaj/web test:e2e:install  # once: download Chromium + WebKit
pnpm --filter @montaj/web test:e2e          # Playwright, chromium + webkit
```

WebKit is a **blocking** lane, not a bonus: Safari is a large share of the Indian
mobile audience and its WebCodecs behaviour differs, so the browser-native export
(A19) has to work there too.

Playwright starts `next dev` itself (`webServer` in `playwright.config.ts`) and
reuses a server you already have running locally.

## Notes

- `next-env.d.ts` is committed here, unlike the Next.js default, so `tsc --noEmit`
  works before a build has ever run — which is what `pnpm typecheck` does in CI.
- `eslint.ignoreDuringBuilds` is on because linting is its own turbo task using
  the shared flat config; the build must not run a second, different pass.
