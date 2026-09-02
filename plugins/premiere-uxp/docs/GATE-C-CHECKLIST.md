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

## Once this checklist is green

Delete the `GATE-C:` comments in `src/host/premiere.ts` that this checklist resolved, add a
regression test only where the real call's _shape_ changed (not its Gate-C status), and file a
follow-up work package for anything discovered here that changes `PremiereHost`'s public
interface (a contract change other WPs may depend on).
