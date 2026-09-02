# Gate C checklist — first real Premiere Pro run

This plugin was built entirely against `MockPremiereHost` (`src/host/premiere.ts`): there is no
Premiere Pro, Adobe UXP Developer Tool, or signed `.ccx` toolchain on the build host, and the
human spike **A00-03** (UXP API feasibility on Premiere 25.6+) has not reported at the time
C05a landed. Everything outside `src/host/premiere.ts` is fully unit-tested and does not
change when Gate C runs; this checklist is only for `createRealPremiereHost()` and the UXP
Developer Tool load/package path.

## Prerequisites

- [ ] Premiere Pro 25.6.0 or later installed.
- [ ] Adobe UXP Developer Tool (UDT) installed and signed in.
- [ ] `pnpm --filter @montaj/premiere-uxp build` run once so `plugins/premiere-uxp/dist/panel.js` exists.
- [ ] Real plugin icons added at `plugins/premiere-uxp/icons/{dark,light,plugin-icon}.png` (not
      committed by C05a — the host guard rule "never commit binaries" applies to this branch;
      add them locally before loading, or as a follow-up WP that does commit binaries).

## Load and manifest checks

- [ ] `Add Plugin...` in UDT against `plugins/premiere-uxp/manifest.json` loads without a
      manifest-schema error (confirms manifestVersion 5 fields are accepted as written).
- [ ] The panel entrypoint (`aksharo.panel.main`) opens and renders the sign-in screen.
- [ ] `requiredPermissions.network.domains` is sufficient — no CORS/network-permission console
      error when the panel calls the loopback bridge (`127.0.0.1:47831-3`) or `api.aksharo.ai`.

## `createRealPremiereHost()` — verify each call, then delete the matching GATE-C comment

- [ ] `Application.version` — confirm it's a property (not `getVersion()`), format matches
      `"25.6.0"`-style parsing in `evaluateUpdateBanner`/`compareSemver`.
- [ ] `Project.getActiveProject()` / `Project.getActiveSequence()` — confirm names, and that
      calling with no project open resolves `undefined` rather than rejecting.
- [ ] `Sequence` properties — confirm `name`, `frameRate` shape (fps + NTSC/drop-frame flag),
      `frameSizeHorizontal`/`frameSizeVertical`, and how in/out is exposed (ticks vs. frames;
      `TickTime`'s ticks-per-second constant) — `getActiveSequence()` currently returns
      `inOut: undefined` until this is confirmed; wire the real conversion once it is.
- [ ] `Sequence.getSelection()` (or the real method name) for `getSelectedClips()`.
- [ ] Sequence/selection/in-out change events — find the real event name(s) on `Application`
      or `Sequence` and replace the no-op `onSequenceChange()` unsubscribe stub.
- [ ] `EncoderManager` — find the exact call for an **audio-only WAV** mixdown (mono 16 kHz and
      48 kHz stereo) of an in/out range, not the AAC 64 kbps mixdown `05-system-architecture.md`
      §6 describes for the audio-only _export_ case — confirm these are the same or different
      encoder presets. `requestMixdown()` currently throws until this is confirmed.
- [ ] `uxp.storage.localFileSystem` — confirm how to get a byte-readable entry for a path
      `EncoderManager` wrote to (a plugin-owned temp folder vs. an OS temp dir the plugin needs
      an explicit permission for). `readFile()` currently throws until this is confirmed.
- [ ] `uxp.shell.openExternal` — confirm the device-code/pairing-approval URL actually opens
      the system browser (not an in-panel webview).

## Packaging

- [ ] `pnpm release package-ccx --dry-run` produces a `.ccx`; unzip it and confirm
      `manifest.json` and `dist/panel.js` are both present at the archive root.
- [ ] Load the packaged `.ccx` (not just the unpacked folder) through UDT once real icons
      exist, to catch any path issue `index.html`'s relative `dist/...` references might hit
      inside a zip.

## C06 apply modes — additional `createRealPremiereHost()` calls to verify

- [ ] `importTranscript` — confirm `Transcript.createImportTextSegmentsAction`'s exact
      segment/word JSON shape, and how an existing Aksharo-tagged transcript is identified so a
      second import replaces only that transcript (not the whole sequence's transcripts).
- [ ] `insertMogrt` — confirm `Project#importMGTItem` (or the real call name) inserts at an
      explicit track index/start, or needs a separate placement step; confirm the returned
      item id shape.
- [ ] `setMogrtParams`/`getMogrtParams` — confirm whether a MOGRT's `ComponentParam`s are
      addressed by `displayName` or by index (this WP's `src/apply/mogrtCaptions.ts` builds
      both a by-name object and an index-ordered array so either answer is a small host-adapter
      change, not an apply-mode rewrite); run the start-up self-test
      (`runMogrtSelfTest` in `src/apply/mogrtCaptions.ts`) against the real `.mogrt` first.
- [ ] MOGRT keyframed highlight — `computeWordHighlightWindows` only computes per-word time
      windows; confirm whether `HighlightStart`/`HighlightEnd` can be keyframed inside one MOGRT
      instance via a component-keyframe API, or whether per-word highlight needs one MOGRT
      instance per word instead (a materially different apply-mode shape — raise as a contract
      question if so, per the brief).
- [ ] `rippleDelete` — confirm the real ripple-delete call and its effect on linked audio and
      other tracks (esp. the dedicated caption track this WP inserts MOGRTs onto).
- [ ] `setMotionKeyframes` — confirm `Component` property names (`Scale`, `Position`) and the
      keyframe/ease enum against MKF2's `Ease` (`linear`/`inOut`).
- [ ] `importMediaToBin`/`placeOnTrack` — confirm `Project#importFiles`'s completion signal
      (event vs. resolved promise) and insert-vs-overwrite placement semantics.
- [ ] `replaceAudioRange` — confirm whether "mute a range" needs a gain-automation node (range
      scoped) rather than a track-level mute toggle (whole-track) — the B10/B10b brief needs the
      range-scoped behaviour.
- [ ] `transaction` — confirm `Project#executeTransaction`'s rollback-on-throw semantics match
      `MockPremiereHost#transaction`'s (an uncaught error inside the callback undoes every
      action group made so far); until verified, do not rely on `runApply.ts`'s abort path
      leaving the sequence exactly as it was.
- [ ] `setItemMetadata`/`getItemMetadata`/`listAksharoItems` — confirm markers support an
      arbitrary JSON payload (not string-only) and that a marker can attach to a `TrackItem`
      (not just the `Sequence`), for per-item host-id map entries the re-sync op depends on.
- [ ] `removeItem` — confirm `TrackItem#remove`'s ripple behaviour (does removing a re-synced
      item shift neighbouring clips the way `rippleDelete` does, or leave a gap?).

## Once this checklist is green

Delete the `GATE-C:` comments in `src/host/premiere.ts` that this checklist resolved, add a
regression test only where the real call's _shape_ changed (not its Gate-C status), and file a
follow-up work package for anything discovered here that changes `PremiereHost`'s public
interface (a contract change other WPs may depend on).
