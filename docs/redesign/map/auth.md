# Map: sign-in, sign-up, verification and public share pages

Area owner: auth/share designer (Shirorekha rebuild, 2026-09-25).
Spec: `docs/redesign/DESIGN.md`. HIG references: `~/.claude/skills/apple-design/references/hig/`.
Line numbers in the audit are from the files **before** this pass.

Contrast figures below are computed from the token hexes (WCAG 2.x relative luminance):

| Foreground | on `bg-0` #141217 | on `surface` #1f1c23 | on `bg-2` #2a262f | on `sunken` #0e0c10 | on `ink` #0b0a0c |
|---|---|---|---|---|---|
| `fg-0` #f1ece6 | 15.8 | 14.3 | 12.6 | 16.6 | 16.8 |
| `fg-1` #d6cfc8 | 12.1 | 10.9 | 9.6 | 12.6 | 12.8 |
| `fg-2` #a39a93 | 6.7 | 6.1 | 5.4 | 7.1 | 7.2 |
| `accent` #f0508a | 5.5 | 5.0 | **4.4 (fail)** | 5.8 | 5.9 |
| `accent-300` #f78bb0 | 8.2 | 7.4 | 6.6 | 8.6 | 8.7 |
| `rejected` #ef7d4f | 6.8 | 6.2 | 5.5 | 7.2 | 7.3 |
| `border` #36313a | 1.5 | 1.3 | 1.2 | 1.5 | 1.6 |
| `on-accent` on `accent` | 5.5 | | | | |

## Shared frame

### `components/auth/auth-card.tsx` — `AuthCard`
- **Job:** the one frame every auth screen sits in: wordmark, one `h1`, a card, an optional footer sentence.
- **Used by:** login, signup (4 stages), auth/callback, auth/desktop-landing, verify, magic, device.
- Findings:
  - **High** — title was an ad-hoc `<h1>` inside the card (`auth-card.tsx:35`), not `PageHeader`; no shirorekha anywhere in the auth flow. DESIGN › Signature; HIG layout.md › Visual hierarchy.
  - **Medium** — the card used `bg-bg-1 … p-6` rather than the card recipe; title and form competed inside one box, so the title didn't lead. HIG layout.md › Visual hierarchy ("Group related items").
  - **Medium** — the wordmark link home had no accessible name beyond "Aksharo" and a text-only height (~28 px) below the 32 px floor (`auth-card.tsx:26-31`). HIG accessibility.md › Mobility.
  - **Low** — 24 px side gutter at 360 px wide; spec says 16 px on mobile. DESIGN › Shape, space.

### `components/auth/google-button.tsx` — `GoogleButton`, `AuthDivider`
- **Job:** start Google OAuth (full navigation), and draw the "or" divider; both hide when OAuth isn't configured.
- Findings:
  - **High** — Google was the only `primary`; when `googleOAuthEnabled` is false (both hide) the sign-in and sign-up screens had **no** primary action at all, the email submit stayed an outline (`login-form.tsx:138`, `signup-form.tsx:302`). HIG buttons.md › Style ("prominent style for the most likely action").
  - **Low** — "or" at `text-2xs` uppercase (`google-button.tsx:68`): meta size on a label that separates two actions. DESIGN › Type.

### `components/auth/age-consent-step.tsx` — `AgeConsentStep`, `ConsentToggle`
- **Job:** onboarding step 0 (date of birth, jurisdiction, two opt-in consents) before an account exists.
- **Reached from:** signup stage 2 and the Google `status=registration` callback.
- Findings:
  - **High** — inline links `text-lime-500` (`:154`, `:158`) — the full accent as link text; spec reserves the accent for the primary and gives links `accent-300`. DESIGN › Components (`link`); HIG color.md › Best practices ("Avoid using the same color to mean different things").
  - **Medium** — radio rows showed no selected state beyond the tiny native dot; `accent-lime-500` legacy name (`:112-118`). DESIGN › Components (selected: `ring-1 ring-accent`); HIG accessibility.md › Vision ("Convey information with more than color alone").
  - **Medium** — the two consent switches sat in an unlabeled `div` (`:131`), so the group had no name for assistive tech. HIG accessibility.md › Vision (VoiceOver).
  - **Low** — pending label "Working…" says nothing about what's happening (`:177`). HIG writing.md › Best practices ("Be action oriented").
  - **Low** — legend "Where are you?" reads as location right now, not residence. judgment.

### `components/auth/blocked-minor.tsx` — `BlockedMinor`
- **Job:** explain the D60 age block and offer the parental-consent waiting list.
- Findings:
  - **High** — the only action (join the waiting list) was `secondary`; no primary on the surface (`:77-84`). HIG buttons.md › Style.
  - **Low** — success state not announced (`:34`); heading "You are on the list" is vague. HIG writing.md › Best practices.

## Routes

### `/login` — `app/(site)/login/{page,login-form}.tsx`
- **Job:** sign an existing account in with Google or email + password, then return to `?next=`.
- **Reached from:** marketing header "Sign in", middleware redirect for any protected route (`/home`, `/settings`, `/device`…), expired-session redirect (`?reason=expired`), `/verify` success (`?verified=1`).
- Findings:
  - **High** — no primary when Google is off (see GoogleButton). HIG buttons.md › Style.
  - **High** — `text-lime-500` links (`:81`, `:149`). DESIGN › Components (`link`).
  - **Low** — submit "Sign in" doesn't name the method next to "Continue with Google". HIG managing-accounts.md › Best practices ("Always identify the authentication method").
  - States: error inline with `role="alert"` ✓ (rejected 6.2:1 on surface); pending label ✓; expired/verified subtitles ✓.

### `/signup` — `app/(site)/signup/{page,signup-form}.tsx`
- **Job:** create an account in two steps (credentials, then age + consents) and confirm by email.
- **Reached from:** marketing CTAs, `/login` footer, `/r/<code>` affiliate redirect (`?ref=`).
- Findings:
  - **High** — no primary on step 1 when Google is off; `text-lime-500` links (`:164`, `:176`, `:235`). HIG buttons.md › Style.
  - **Medium** — step 2 said "Step 1 of 2 done" in the subtitle and titled itself "A couple of legal things"; step 1 had no step marker, so the flow's length was unclear. HIG writing.md › Best practices ("Give clear guidance … processes with multiple steps").
  - **Low** — "Back" doesn't say where. HIG writing.md › Best practices.
  - **Low** — blocked title "We cannot open an account yet" (HIG writing.md: avoid "we").

### `/auth/callback` — `app/(site)/auth/callback/{page,callback-view}.tsx`
- **Job:** finish Google OAuth: exchange the handoff code (existing account) or collect age + consent (new account).
- **Reached from:** Google redirect only.
- Findings:
  - **Medium** — error recovery buttons were `secondary` though they are the only action (`:74`, `:142`). HIG buttons.md › Style.
  - **Medium** — "Signing you in / One moment." not announced (no `role="status"`) (`:151`). HIG loading.md › Best practices; HIG accessibility.md › Vision.
  - **Low** — "Almost there" title says nothing about the step. HIG writing.md.

### `/auth/desktop-landing` — `app/(site)/auth/desktop-landing/{page,landing-view}.tsx`
- **Job:** hand a desktop sign-in back to the app through a deep link, with a visible fallback button.
- **Reached from:** links the desktop app builds; OAuth for desktop clients.
- Findings:
  - **Medium** — error title "Something went wrong" is generic; its one action was `secondary` (`:46-51`). HIG writing.md › Best practices ("Write clear error messages").
  - **High** — `text-lime-500` link (`:68`).

### `/auth/magic-link`, `/auth/verify-email` — redirect-only `page.tsx`
- **Job:** forward the URLs already in people's inboxes to `/magic` and `/verify`. No UI; no findings.

### `/verify` — `app/(site)/verify/{page,verify-view}.tsx`
- **Job:** confirm an email address from the confirmation link, then send the person to sign in.
- Findings:
  - **Medium** — recovery action `secondary` (`:51`, `:64`); pending copy not announced (`:73`). HIG buttons.md › Style; HIG loading.md.

### `/magic` — `app/(site)/magic/{page,magic-view}.tsx`
- **Job:** request a one-time sign-in link, or consume one (`?token=`).
- Findings:
  - **High** — the form's only submit was `secondary` (`:92`); `text-lime-500` link (`:59`).
  - **Medium** — "Check your inbox" state had no way back to fix a mistyped address. HIG writing.md › Best practices ("Provide clear next steps").
  - **Medium** — consume pending not announced (`:144`).

### `/device` — `app/(site)/device/{page,device-view}.tsx`
- **Job:** let a signed-in person approve or deny a device-code sign-in after checking who is asking.
- **Reached from:** the desktop app / NLE panels (`?user_code=`); middleware sends signed-out visitors to `/login?next=/device`.
- Findings:
  - **High** — code-entry submit was `secondary`, labelled "Continue" (`:107`). HIG buttons.md › Style/Content.
  - **Medium** — deny used the legacy `outline` variant (`:169`); facts list had no accessible name; long values (hostnames) could push the label off a 360 px row (`:202-205`). HIG layout.md › Adaptability.
  - **Low** — "Checking that code / One moment." not announced.
  - Approve `primary` + deny `secondary` at equal size is correct (HIG buttons.md › Style: "Use style — not size").

### `/developers` — `app/(site)/developers/{page,developers-docs,code-tabs,…-snippets}.tsx`
- **Job:** the public `/v1` API reference (auth, scopes, limits, endpoints from `openapi.json`, webhooks, errors).
- **Reached from:** Settings → Developers, marketing footer/docs links, direct.
- Findings:
  - **High** — ad-hoc `font-display` `<h1>` (`:97`), no `PageHeader`; page had no `<main>` landmark and no link home (it sits outside the marketing layout). DESIGN › Signature; HIG accessibility.md › Vision (VoiceOver).
  - **Medium** — eight sections, no on-page navigation. HIG layout.md › Visual hierarchy ("progressive disclosure").
  - **Medium** — tables: headers without `scope`, no caption; horizontally scrolling tables and `<pre>` blocks not keyboard-focusable (`:128`, `:167`, `:207`, `code-tabs.tsx:29`). HIG accessibility.md › Speech (keyboard).
  - **Medium** — code blocks on `bg-bg-2` (raised well) instead of an inset. DESIGN › Colour (`bg-sunken` = inset).
  - **Low** — body copy in `text-fg-2` for long reference prose (6.7:1, passes, but `fg-1` reads better for paragraphs). judgment.
  - **Low** — literal `*raw*` asterisks rendered in the webhook paragraph (`:229`). judgment (copy bug).

### `/r/[code]` — `app/(site)/r/[code]/route.ts`
- **Job:** affiliate landing: record a click, set a 60-day cookie, redirect to `/signup?ref=`. No UI; 404 when affiliates are off. No design findings.

### `/share` — `app/(share)/share/page.tsx`
- **Job:** redirect the bare route home (guarded by the `publicShares` surface flag). No UI.

### `/share/[token]` — `app/(share)/share/[token]/{page,share-viewer}.tsx`
- **Job:** the public review page: watch the captioned preview, comment, approve/request changes, report abuse.
- **Reached from:** a share link someone sent (editor → Share). No session.
- Findings:
  - **Critical** — password field and comment fields had **no labels**, only placeholders (`:69-77`, `:215-238`); placeholder text disappears on typing and isn't a reliable accessible name. HIG text-fields.md › Best practices; HIG writing.md › "Show hints in text fields".
  - **High** — raw `text-red-400` error (`:82`), raw inputs/selects bypassing the `Input` primitive (`:69`, `:129`, `:144`, `:215`). DESIGN › Colour ("Never raw …").
  - **High** — scope shown as the raw enum ("approve") in an **accent** badge (`:366`): accent spent on decoration, and the words aren't user copy. DESIGN › Accent budget; HIG writing.md.
  - **High** — no primary anywhere: "Approve" and "Unlock" were default (`secondary`) buttons (`:78`, `:295`). HIG buttons.md › Style.
  - **High** — `h1` ad hoc, no `PageHeader` (`:363`, `:47`, `:61`).
  - **Medium** — decide / add-comment / report mutations had no error state at all. HIG writing.md › "Write clear error messages"; HIG feedback.md.
  - **Medium** — comments had no loading, error or empty state. HIG writing.md › "Provide clear next steps on any blank screens"; HIG loading.md.
  - **Medium** — "Report this content" was a 16 px-tall text button (`:99-106`). HIG accessibility.md › Mobility.
  - **Medium** — "Post comment" disabled until a name is typed, with nothing saying the name is required. HIG text-fields.md › "Validate fields when it makes sense".
  - **Low** — preview placeholder on `bg-bg-1` rather than the video canvas `bg-ink`. DESIGN › Colour.
  - **Low** — loading and ack messages not announced.

## Changes made

- `AuthCard` now renders `PageHeader` (one shirorekha per auth screen) above a card-recipe box (`rounded-md border border-border bg-surface p-5 sm:p-6`); optional `eyebrow` prop (additive); 16 px mobile gutter; wordmark link has `aria-label="Aksharo home"` and a 32 px target. Exports `AUTH_LINK_CLASS` (`text-accent-300`, underlined) and every `text-lime-500` link across the area uses it.
- One primary per surface everywhere:
  - login / signup step 1: Google is `primary` when it renders, otherwise the email submit is (`variant={googleOAuthEnabled ? "secondary" : "primary"}`).
  - magic request, device code entry, waiting list, and every single-action error screen (callback, desktop landing, verify, magic): the one action is now `primary`.
  - device deny `outline` → `secondary`.
  - share: "Unlock" and "Approve" are `primary`; "Post comment" is `primary` only on comment-scope links (on approve links Approve keeps the slot).
- Copy: "Sign in with email"; "Forgot your password?"; signup step markers ("Step 1 of 2", "Step 2 of 2 · Your age and privacy"); "Create your Aksharo account"; "Back to your details"; "An account can't be opened yet"; Google registration "Last step · Your age and privacy"; "This sign-in link is incomplete" with a real next step; device "Check code"; "Creating your account…"; share scope in words ("View only / Can comment / Can approve"); share empty/error copy says what to do.
- Accessibility: `role="status"` on every pending/"signing you in" line and success ack; labelled password, name, email, comment and report fields (via `Field`/`Input`/`label`); password error tied with `aria-describedby`; consent switches wrapped in a named `fieldset`; selected jurisdiction row gets `ring-1 ring-accent`; device facts `dl` wraps long values (not given an `aria-label`: a `dl` has no role that takes a name, and the card title already says what it lists); "Report this content" 32 px target; developers tables get `scope="col"`, `<caption>`, focusable scroll regions; code blocks focusable and named.
- Share: raw inputs/select → `Input`/`Field` + a token-styled select; `text-red-400` → `text-rejected`; error states added for unlock, comment, decision and report mutations; comments get loading/error/empty states and a divided list in one card; decision bar and recorded decision in card recipe, recorded state shows a signal badge with a word; preview wells on `bg-ink`; grievance link `text-fg-1` underlined.
- Developers: `<main>` landmark, wordmark link home, `PageHeader` (eyebrow "Developers"), "On this page" nav, anchored `DocSection`s (Inter `h2`), a shared `DocTable`, paragraphs in `fg-1`, code on `bg-sunken`, `*raw*` → `<em>raw</em>`, endpoint empty state.
- No `data-testid` removed or renamed; no API calls, hooks, props contracts or redirects changed. Small UI-only additions: magic "Use a different email" (`request.reset()`), decision buttons disabled while a decision is saving, endpoint-table empty state.

## Reviewer pass

- Share password field: dropped `autoComplete="current-password"`; a share-link password is not the viewer's account password, and the hint made browsers offer the saved Aksharo login.
- Share report select: `bg-bg-1` + `hover:border-fg-2/60` → `bg-sunken` + `hover:border-border-hover`, matching the `Input` primitive beside it.
- Share report acknowledgement: no longer promises review by the grievance officer (not something this page can guarantee).
- Device facts: removed `aria-label` from the `dl` (prohibited on an element with no nameable role; axe flags it).
- Google registration subtitle: "it decides" was ambiguous (read as Google deciding); now "your age decides".

Verification (from `apps/web`): `pnpm exec tsc --noEmit` clean; `npx vitest run` over the owned dirs + `components/shell/app-shell.test.tsx` (the `AuthCard` tests) — 5 files, 32 tests pass; `eslint` on every changed file — 0 errors; `prettier --write` applied.

## Deferred

- **Wordmark in `font-display`** (`AuthCard`, developers page): kept, as the brand mark, matching the sidebar wordmark (`components/shell/sidebar.tsx`). If the system decides the wordmark must be Inter, change both together.
- **Input border** (`packages/ui/src/primitives/input.tsx`): the primitive now fills with `bg-sunken` per spec (the share report select matches it), but `border-border` is 1.3:1 against the card — below WCAG 1.4.11's 3:1 for a control boundary. Shared primitive; see sharedRequests.
- **Suspense `fallback={null}`** on login/verify/magic/device/callback/desktop-landing pages: blank until the client subtree resolves. With `dynamic = "force-dynamic"` at the root it rarely shows; low value, left.
- **Report form category select** is still a native `<select>` styled here; a `Select` primitive exists in `@montaj/ui` but would change the test's `report-abuse-category` element type.
- **`/developers` still has no site header/footer** (it lives outside the `(marketing)` layout); moving it is a routing change outside this area.
- **Share page: comment timestamps** are not clickable to seek the preview — a feature, not a redesign.
