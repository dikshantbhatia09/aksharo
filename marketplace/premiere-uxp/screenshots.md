# Screenshot list — Aksharo Panel (Adobe Exchange)

None of these exist yet — every one needs a real Premiere Pro install, which this build host
does not have (see `plugins/premiere-uxp/README.md`'s "No Premiere Pro ... toolchain exist on
the build host" and `docs/GATE-C-CHECKLIST.md`). Capture these once Gate C is run.

Adobe Exchange requires 3-5 screenshots, 1280x800 or 1920x1200, PNG, no client-confidential
project content.

1. **Panel docked in Premiere, sign-in screen** — the device-code pairing flow, code visible,
   no personal accounts in view.
2. **Transcript injected into Text-Based Editing** — a real (or demo) Hinglish transcript
   showing code-switched Hindi/English mixed script, proving the localisation story.
3. **MOGRT captions applied to the timeline** — the caption track with a few caption clips,
   the ApplyPanel's mode checklist visible with the dry-run preview count shown.
4. **Update banner** (optional but recommended) — `evaluateUpdateBanner`'s
   "update-available" state, showing the panel is actively maintained.
5. **Cuts/zooms/audio apply in progress** — the bridge progress UI mid-transaction (`apply.
step` events), demonstrating the one-transaction/rollback guarantee.

Every screenshot must show the panel titled "Aksharo Panel" (never the engineering codename)
and the non-affiliation footer line where visible in frame.
