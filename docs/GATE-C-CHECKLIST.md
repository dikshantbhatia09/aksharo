# Gate C checklist — DaVinci Resolve script (`aksharo_core`, C08)

Manual first-run verification on a **real** DaVinci Resolve install. Nothing
in `plugins/resolve` has been run against a real Resolve — this repo's CI has
none installed, and human spike **A00-04** (Resolve scripting API coverage on
Free vs Studio, `docs/PLAN.md`) has not reported. Run this checklist once
A00-04 lands, on both DaVinci Resolve **Free** and **Studio**, before
promoting this work package past Gate C.

## Prerequisites

- [ ] DaVinci Resolve (Free) 19.1+ installed, a project open, a timeline with
      at least one video clip.
- [ ] A second run on DaVinci Resolve **Studio**, same version line.
- [ ] `pnpm release package-resolve --dry-run` produced a bundle (see
      `plugins/resolve/README.md`); its `install.sh`/`install.ps1` copies
      `aksharo_core.py` + `aksharo_core_app/` into Fusion's `Scripts/Utility`.

## 1. Script discovery (both Free and Studio)

- [ ] `aksharo_core` appears under **Workspace ▸ Scripts** after the
      installer runs and Resolve restarts.
- [ ] Running it prints the banner (`Aksharo — works with DaVinci Resolve` +
      the non-affiliation line) to the Resolve console (Workspace ▸ Console).
- [ ] Record whether the script's namespace contains a `resolve` global on
      **Free** (A00-04's core open question) — `aksharo_core.py` prints an
      explicit message if it does not; note the exact wording seen.

## 2. Loopback server

- [ ] After the script starts, confirm a process is listening on one port in
      `47841`-`47843` (e.g. `netstat -an | grep 4784` / `Get-NetTCPConnection`).
- [ ] `~/.aksharo/resolve.json` exists, mode `0600`, contains `port`, `bearer`,
      `pid`, `version`, `startedAt`.
- [ ] A `host.info` call over that port (with the file's bearer as
      `Authorization: Bearer <token>`) returns `{"hostApp":"resolve", ...}`.
- [ ] Record whether a long-running server inside Resolve's process causes any
      UI stalls or crashes (open question — no prior confirmation this is
      safe on Free).

## 3. Bridge pairing (B08b device-code flow)

- [ ] First run opens the system browser to the device-code verification URL.
- [ ] Approving the code registers a device (visible in **Settings ▸
      Devices** in the web app) and this script proceeds without further
      prompting.
- [ ] Killing and restarting Resolve re-uses the stored refresh token with no
      new browser prompt (`refresh_device_credentials`).
- [ ] Revoking the device from **Settings ▸ Devices** and restarting the
      script correctly falls back to the full device-code flow again.

## 4. Captions

- [ ] Pushing a transcript (`transcript.push`) creates a dedicated video track
      named "Aksharo Captions" with one Text+ clip per segment.
- [ ] Clip text, font, size, colour and position match the segment's style.
- [ ] A segment whose style is not Text+-renderable (A18a
      `assRenderable=false`) imports the alpha-overlay media instead, with no
      exception surfaced to the user.
- [ ] Each created clip carries a marker (Workspace ▸ Timeline ▸ Markers)
      whose custom data is `{"aksharo":{"projectId":...,"segmentId":...,"rev":...}}`.

## 5. Cuts

- [ ] Accepting a B20 `cut` pass item and re-running the apply step removes
      the mapped clip(s) with a ripple (no gap left behind).
- [ ] Confirm whether Ctrl/Cmd+Z undoes the whole apply step as one action or
      clip-by-clip (documented assumption: clip-by-clip, no grouped undo API
      is exposed by DaVinciResolveScript — `cuts.py`'s
      `NO_UNDO_GROUP_WARNING`). Record the actual behaviour observed.

## 6. Zooms

- [ ] Accepting a B19 `zoom` pass item sets a start/end Dynamic Zoom on the
      matching clip; confirm the property names this package guesses
      (`Zoom_Start`/`Zoom_End`/`Pan_*`/`Tilt_*`/`Ease` via
      `TimelineItem.SetProperty`) actually drive Resolve's Dynamic Zoom UI —
      **this is unverified against a real install** and is this checklist's
      single highest-risk item.
- [ ] Confirm the zoom only reflects the first/last keyframe of a
      multi-keyframe MKF2 curve, as documented, and note whether users find
      that acceptable or whether B19b/C08 needs to revisit the mapping.

## 7. Re-sync

- [ ] Editing a segment's text upstream and re-running the apply step
      replaces only that segment's clip (matching `rev`), leaving unrelated
      clips and their markers untouched.
- [ ] Deleting a segment upstream removes its clip and marker on the next
      re-sync.

## 8. Fusion Text+ macro (C08b)

Nothing below has been run against a real Fusion — `macro.py` generates and
parses a deliberately self-defined text subset (documented in
`plugins/resolve/aksharo_core_app/fusion/macro.py`'s module docstring), not
Fusion's real `.setting` serialisation. This section is the actual proof.

- [ ] Copy `plugins/resolve/aksharo_core_app/fusion/AksharoCaption.setting`
      into Fusion's `Macros` folder (paths in
      `plugins/resolve/installer/manifest.json`) and confirm it appears in
      Fusion's **Effects Library ▸ Macros** and loads onto a clip as a single
      Text+-based tool with no load error.
- [ ] Confirm all 11 published inputs
      (`Text`, `Font`, `Size`, `Colour`, `StrokeColour`, `StrokeWidth`,
      `ShadowOpacity`, `PositionY`, `HighlightColour`, `HighlightStart`,
      `HighlightEnd`) actually surface on the tool's Inspector, in that order,
      and that setting each one visibly changes the rendered text.
- [ ] Confirm `HighlightStart`/`HighlightEnd` keyframed 0→1 ramps actually
      drive a per-character/per-word colour or scale change on the underlying
      Text+ (this macro assumes Fusion's character-range styling can be
      expression-linked to a scalar input; that link has not been built or
      tested against real Fusion).
- [ ] Re-run `plugins/resolve/aksharo_core_app/captions.py`'s macro branch
      (`fusion_macro_available()` true) against a real timeline and confirm
      `host.append_text_plus`'s `fusion_macro`/`highlight_color`/
      `highlight_keyframes` params actually reach the dropped macro instance
      (this repo's `FakeResolveHost` only records them; `RealResolveHost`
      does not implement `append_text_plus` yet — A00-04).
- [ ] Cross-check 3 styles from each status in
      `plugins/resolve/docs/RESOLVE-STYLE-COVERAGE.md` (Supported/
      Approximate/Unsupported) by eye against the real Text+ result; file a
      follow-up against `classification_rules.json` for any row that looks
      wrong once verified.

## 9. Studio panel (C09)

Nothing below has been run against a real DaVinci Resolve Studio install —
`plugins/resolve-panel`'s automated tests exercise `MockWorkflowIntegrationHost`
and a mock JSON-RPC transport only (`plugins/resolve-panel/README.md`
"Known limitations"). This section is the actual proof, **Studio only**
(D24/D65 — the panel never loads on Free).

- [ ] `manifest.xml` is accepted by Resolve Studio's Workflow Integration
      host with no load error, and "Aksharo" appears as a dockable panel
      (Workflow Integration Plugins menu/palette — exact UI path TBD, record
      what you find).
- [ ] Confirm whether a `window.workflowIntegration`-style bridge global
      exists in the panel's JS context at all (`src/host/workflow-integration.ts`'s
      header comment, single highest-risk item for this section).
- [ ] If it exists, confirm it can read `~/.aksharo/resolve.json`
      (`readDiscoveryFile()`) — if it cannot, this WP's discovery transport
      needs to change (see the README) before anything below can work.
- [ ] Once discovery works: the panel connects to the loopback server via
      `ws://127.0.0.1:<port>?token=<bearer>` and shows the current timeline
      name/fps (`host.info`/`timeline.current`). Confirm this WP's `?token=`
      query-param bearer fallback in
      `plugins/resolve/aksharo_core_app/server.py` (`_query_token`) actually
      authenticates — a real browser `WebSocket` cannot set the
      `Authorization` header the Python bridge client uses.
- [ ] `session.status` reflects the script's own sign-in state; a pending
      device-code pairing shows the code and opens the verification URL via
      `openExternalUrl`.
- [ ] "Caption this timeline" (`transcribe.start`) runs the mixdown -> upload
      -> transcribe pipeline (`plugins/resolve/aksharo_core_app/transcribe.py`)
      without the panel needing any Resolve API of its own.
- [ ] "Apply in Resolve" (`passes.list` + `apply.begin`/`apply.step`/
      `apply.commit`) applies accepted pass items onto the real timeline via
      the same `apply.*` methods C08's own bridge-driven apply uses; confirm
      it surfaces `cuts.py`'s no-grouped-undo warning (Gate C §5) the same
      way.
- [ ] Confirm `packageResolve.ts`'s `panel/` install paths
      (`release.config.ts`'s `resolvePanel.installPaths`) are where Resolve
      Studio actually looks for Workflow Integration plugins on each OS —
      this WP guessed them; C10's installer (once it lands) should use the
      confirmed path instead.

## Sign-off

| Item             | Free | Studio | Notes |
| ---------------- | ---- | ------ | ----- |
| Script discovery |      |        |       |
| Loopback server  |      |        |       |
| Bridge pairing   |      |        |       |
| Captions         |      |        |       |
| Cuts             |      |        |       |
| Zooms            |      |        |       |
| Re-sync          |      |        |       |
| Fusion macro     |      |        |       |
| Studio panel     | n/a  |        |       |

Record the Resolve build number tested and file follow-up issues for any
`host/resolve.py` assumption that turned out wrong — that file is the single
place to fix.

## 10. Local engine quality gate (C03b)

Nothing below has been run against real whisper.cpp/Metal/Vulkan/CUDA/Silero/
deep-filter binaries — this repo's CI (`.github/workflows/local-engine-bench.yml`)
only runs `apps/engine/bench/**`'s harness against C03a's `FakeBackend`
(plumbing, threshold math and report format; the report itself says so). A00-10
spikes the real backends; **the quality gate only passes from the run below**,
once a real `EngineBackend` implementation exists behind the same
`apps/engine/src/backends/types.ts` seam `FakeBackend` implements today.

### Prerequisites

- [ ] A real `EngineBackend` (whisper.cpp/Silero/deep-filter, `metal-coreml` |
      `vulkan` | `cuda` | `cpu`) is wired into `apps/engine/src/main.ts` for
      this machine's detected backend (A00-10).
- [ ] `pnpm --filter @montaj/config build && pnpm --filter @montaj/bridge-core
build && pnpm --filter @montaj/engine-client build` (the harness talks to
      the engine over the built `@montaj/engine-client`, same as `apps/desktop`).
- [ ] `pnpm --filter @montaj/worker-ai setup` (the metrics-bridge venv;
      `apps/engine/bench/metrics-bridge.ts` shells out to it for WER/CER via
      D08's `worker_ai.evals.local_engine`).

### Exact command, per machine profile

Run from the repo's own checkout (not a work-package worktree), on the target
machine:

```bash
pnpm --filter @montaj/engine bench
```

This is the **same command** for every profile — `apps/engine/bench/run.ts`
detects the machine's tier/backend itself (`../src/detection.ts`, cores/RAM/
GPU) and reports it in the output; it does not need a `--profile` flag. Expect:

| Profile | Platform                          | What should be true                                               |
| ------- | --------------------------------- | ----------------------------------------------------------------- |
| A       | Apple Silicon, >=16GB RAM         | backend `metal-coreml`; 5-minute clip <=60s                       |
| B       | Windows, >=8 cores/16GB RAM + GPU | backend `vulkan` (or `cuda` if the CUDA pack is installed); <=90s |
| C       | 4-8 cores/8GB                     | backend `cpu` (small model); <=120s                               |
| D       | <8GB RAM, or below the C floor    | local engine disabled — nothing to run here                       |

### Paste results here

- [ ] `docs/verification/local-engine-<profile>-<date>.md`/`.json` were
      generated (the harness writes both; commit them alongside this checklist
      update).
- [ ] The report's "Gate status" line reads **PASS** (not "not evaluated" —
      that means it ran against `FakeBackend` again by mistake; check
      `apps/engine/src/main.ts`'s backend construction).
- [ ] Median word-boundary error <= 80ms vs. the cloud aligner on the Hinglish
      fixture (`apps/engine/fixtures/hinglish-reference.json`'s `hinglish-sample`
      and `a23-90s` items — the first real audio pass over the real 90s A23
      clip, once it exists, replaces the `a23-90s` item's "not wired into
      FakeBackend" note with a real score).
- [ ] WER within the fixture's recorded band (`apps/engine/bench/
thresholds.ts`'s `defaultQualityGateConfig.werBand`, until A00-05's real
      target replaces it).
- [ ] Tier match: the report's "Server-reported tier" equals "Harness-detected
      tier" — a mismatch means `detection.ts`'s real CUDA/Vulkan probing
      (`main.ts`, still A00-10/C03b's open item per `apps/engine/README.md`)
      disagrees with what this machine actually has.
- [ ] Record the machine's exact spec (cores, RAM, GPU model/driver) next to
      the report filename below, so a future regression can be traced to a
      real hardware change rather than guessed at.

| Profile | Machine spec | Report filename | Result |
| ------- | ------------ | --------------- | ------ |
| A       |              |                 |        |
| B       |              |                 |        |
| C       |              |                 |        |
