# Adobe trademark usage form — checklist (human action, H-24)

Adobe requires a signed Trademark Usage Guidelines acknowledgement (and, for some
categories, a separate trademark permission request) before an Exchange listing that
references "Premiere Pro"/"After Effects" goes live. **No submission has been made — this
is prep only.** The actual submission is `HUMAN-ACTIONS.md` item **H-24**; this WP does not
edit that file (frozen list, human-owned) — its exact text is reproduced below for the
final report instead of being written there directly.

## Checklist (fill in immediately before submission, not now)

- [ ] Read Adobe's current Partner Trademark Guidelines (URL changes — re-fetch at
      submission time, don't rely on a cached copy).
- [ ] Confirm listing copy uses "Adobe Premiere Pro" / "Adobe After Effects" on first
      mention, "Premiere Pro" / "After Effects" only afterward — never "Adobe" dropped
      entirely, never "Premiere" alone as a product name.
- [ ] Confirm the non-affiliation line is present on every page/screen that names Adobe
      (D65 — already true in `plugins/premiere-uxp/src/ui/components/Footer.tsx`,
      `apps/web/content/site/plugins-data.ts`'s `ATTRIBUTION_LINE`, and this folder's
      `listing.md`).
- [ ] Confirm no Adobe logo, icon, or brand asset is bundled in the `.ccx` or shown in any
      screenshot without Adobe's separate logo-usage permission (different from the
      trademark-name permission).
- [ ] Confirm the plugin id `ai.aksharo.panel` and product name "Aksharo Panel" contain no
      Adobe trademark themselves (they don't).
- [ ] Submit Adobe's trademark usage / permission request through the Exchange developer
      console, attach the listing copy above, and record Adobe's response (approved /
      changes requested) before the actual Exchange submission.
- [ ] Once approved, proceed to the real Exchange submission (separate human action, not
      part of this checklist or of H-24 itself unless the orchestrator folds it in).

## H-24 text (reported, not written to HUMAN-ACTIONS.md by this WP)

> **H-24 — Adobe Exchange trademark usage form.** Before submitting the Aksharo Panel
> listing to Adobe Exchange, a human must read Adobe's current Partner Trademark
> Guidelines and submit the trademark usage / permission request through the Exchange
> developer console (marketplace/premiere-uxp/adobe-trademark-checklist.md has the
> detailed checklist). This gates the Exchange listing only — the `.ccx` direct download
> (C10) ships independently of Marketplace approval.
