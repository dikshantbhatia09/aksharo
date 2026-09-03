# Runbook — breach notification pipeline (the two clocks)

[breach-first-hour.md](breach-first-hour.md) is the detailed, minute-by-minute
containment and evidence-preservation procedure — read that one first, during
an actual incident. This runbook is the piece it does not cover: **which
regulators get notified, on which clock, and where that state lives**
(`breach_incidents` — `apps/api/src/privacy/breach-incidents.service.ts`, B16).

There are **two independent clocks**, not one. Missing the shorter one because
you were only tracking the longer one is the failure mode this page exists to
prevent.

## Clock 1 — DPDP Act, Data Protection Board of India: 72 hours, no harm threshold

D61 / `05-system-architecture.md` §8: users are notified **without delay, in
plain language**, and the Data Protection Board within **72 hours of
detection** — with **no harm threshold**: unlike some other regimes, DPDP does
not let you decide internally that a breach was "low risk" and skip
notification. If personal data was or may have been exposed, the clock starts.

- Starts at `detectedAt` (`BreachIncident.detectedAt` — when _you_ found out,
  not when the breach occurred).
- `BreachIncidentsService.templates()` (`GET /admin/privacy/breach-incidents/:id/templates`)
  renders the Board report and user notice drafts from `breach-templates.ts` —
  every bracket in them is a human decision, never invented.
- `boardNoticeHoursRemaining` on every `BreachIncidentView` is the running
  countdown; the admin console (B13b) surfaces it so nobody has to do the
  arithmetic under pressure.
- Track `boardNotifiedAt` and `usersNotifiedAt` on the same row
  (`PATCH /admin/privacy/breach-incidents/:id`) — both are real, separate
  events, and DPDP requires both.

## Clock 2 — CERT-In Directions (Section 70B, IT Act): 6 hours

Separately from DPDP, the **CERT-In Directions of 28 April 2022** (issued
under Section 70B of the Information Technology Act, 2000) require certain
categories of cyber incident to be reported to CERT-In **within 6 hours of
noticing or being brought to notice of such incidents** — a much shorter clock
than DPDP's 72 hours, and one that exists regardless of whether personal data
was involved (it covers a broader set of cyber-security incidents, not only
data breaches). The reportable categories include, among others: unauthorised
access to IT systems, data breaches, data leaks, and attacks on servers/systems
that could affect the organisation's service.

**[DRAFT — H-27]** Whether a specific incident meets CERT-In's reportable
categories, the exact reporting channel (CERT-In's incident reporting form /
email, currently `incident@cert-in.org.in` per CERT-In's public guidance — to
be reconfirmed with counsel before relying on it operationally) and the
report's required fields are a legal-review item, not something this runbook
invents. What is not in doubt: **the 6-hour clock is shorter than the 72-hour
one and starts from the same `detectedAt`** — so the practical rule for
whoever is running `breach-first-hour.md` is:

1. The moment you declare an incident that involves unauthorised access, a
   data breach/leak, or a system compromise (not only ones with personal data)
   — start **both** clocks, out loud, in the incident channel.
2. Decide within the first hour, with counsel if reachable, whether this
   incident is CERT-In-reportable. If genuinely unsure, report it: a
   defensive report costs little; a missed mandatory one does not.
3. File the CERT-In report by hour 6. This will usually be well before the
   DPDP Board notice is ready, and that is expected — they are different
   documents for different regulators with different content requirements.
4. Continue the DPDP 72-hour track exactly as `breach-first-hour.md` and this
   page's Clock 1 describe; a CERT-In filing does not substitute for it.

## Where this connects to B16's incident model

Everything above operates on the same `BreachIncident` row from creation
(`POST /admin/privacy/breach-incidents`) to close, mirroring `breach-first-hour.md`'s
"Afterwards" step. The one thing this work package adds to that model: track
the CERT-In filing timestamp in the incident's free-text `scope`/notes until a
later work package promotes it to its own column if this proves to need
structured querying (it has not yet been reportable-in-anger, so a schema
change is speculative right now).

## One tabletop before GA

D61 requires one tabletop exercise before general availability. Run this
runbook and `breach-first-hour.md` end to end against a fabricated scenario,
with both clocks started for real (i.e., actually check the wall clock and
write down when each notional deadline would land) — the drill exists to prove
someone knows CERT-In's clock exists at all, not only DPDP's.
