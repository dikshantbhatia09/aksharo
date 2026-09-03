# Gate C checklist — first real After Effects run

This plugin was built entirely against `MockAeHost` (`src/host/ae.ts`): there is no After
Effects, CEP inspector, or signed `.zxp` toolchain on the build host. `createRealAeHost()`
throws `NOT_IMPLEMENTED_ON_THIS_HOST` for every method until this checklist is run; every other
module (layer-spec builder, style classification, apply-mode selection, sign-in, upload) is
fully unit-tested against the mock and does not change when Gate C runs.

## Prerequisites

- [ ] After Effects 24.0 or later installed (see `CSXS/manifest.xml`'s `Host` entry — confirm
      the actual minimum CEP-12-capable version and adjust if 24.0 turns out wrong).
- [ ] A CEP debug/inspector tool (e.g. the CEP-Resources `.debug` file + Chrome DevTools remote
      debugging, or a UDT-equivalent for CEP) to see panel console errors.
- [ ] `pnpm --filter @montaj/ae-cep build` run once so `plugins/ae-cep/dist/panel.js` exists.
- [ ] Real plugin icons added under `plugins/ae-cep/icons/` and the `CSXS/manifest.xml`
      `<Icons>` block restored (not committed by C05b — the host guard rule "never commit
      binaries" applies to this branch; add them locally, or as a follow-up WP that does commit
      binaries, before loading into a real After Effects).
- [ ] The extension is installed into CEP's extensions folder (or symlinked there) per the CEP
      12 Cookbook's "how CEP finds extensions" section, since there is no drag-and-drop loader
      for CEP the way UDT provides for UXP.

## Load and manifest checks

- [ ] `CSXS/manifest.xml` loads without a manifest-schema error (confirms the `ExtensionBundleId`/
      `Host`/`RequiredRuntime` fields are accepted as written).
- [ ] The panel (`Window > Extensions > Aksharo`) opens and renders the sign-in screen.
- [ ] The loopback bridge call (`127.0.0.1:47831-3`) and `api.aksharo.ai` calls succeed with no
      CORS/network error (CEP panels have no manifest-declared network allow-list the way UXP
      does — confirm nothing else blocks it).

## `createRealAeHost()` — verify each call, then delete the matching GATE-C comment

- [ ] `app.version` — confirm format matches this WP's version parsing assumption
      (`"24.0.0"`-style).
- [ ] `app.project.activeItem instanceof CompItem` — confirm this is the correct way to read
      "the active composition" and that it's `null` (not throwing) when no project/comp is open.
- [ ] `CompItem.workAreaStart`/`workAreaDuration` — confirm these are in seconds (as
      `readComp()` in `src/jsx/aksharo.jsx` assumes) and not frames.
- [ ] `app.project.renderQueue` / AME hand-off (`mixdownToWav`) — confirm the exact call
      sequence for an **audio-only WAV** render via Adobe Media Encoder: whether an explicit
      audio-only output-module _template_ must exist first (this WP's `aksharo.jsx` reads
      `outputModule(1)` and sets `.file` directly, without selecting a named template — confirm
      this actually produces audio-only output, or find the real template-selection call), and
      whether `queueInAME(false)` blocks until the render finishes or only enqueues it (the
      panel currently treats the ExtendScript call as synchronous with the file ready on
      return — confirm or add a poll/callback).
- [ ] CEP panel file reads (`readFile`) — confirm whether the panel's own JS context can read
      a local file directly (`window.cep_node`'s `fs`, if Node integration is enabled in the
      manifest) or must round-trip through an `evalScript` call that reads/base64-encodes the
      file in ExtendScript instead.
- [ ] `layers.addText` / `TextDocument` (`addTextLayers`) — confirm the exact property names
      this WP assumes (`font`, `fontSize`, `fillColor`, `strokeColor`, `strokeWidth`,
      `applyStroke`) against a real `TextDocument`, and confirm font-family string -> installed
      font resolution behaves as expected for every family in
      `src/styles/ae-style-map.ts`'s `BUNDLED_FONT_FAMILIES`.
- [ ] `Layer#sourceRectAtTime` (background box sizing in `addTextLayers`) — confirm it returns
      correct bounds immediately after a text layer is created in the same script execution
      (before AE has run a full frame update), or whether a `app.project.activeItem.time = ...`
      nudge / explicit refresh is needed first.
- [ ] `comp.layers.addSolid` (background box layer) — confirm the parameter order/units this WP
      assumes (`color[0..1], name, width, height, pixelAspect, duration`).
- [ ] `app.project.importFile` + `comp.layers.add` (`importOverlay`) — confirm this is the
      correct pattern for importing an alpha-channel render and placing it on the active comp.
- [ ] `MarkerValue` on an `AVLayer`'s `Marker` property (`tagLayer`/`getLayerMetadata`) —
      confirm a marker's `.comment` accepts an arbitrary JSON string of the length this WP's
      metadata payloads need, and confirm `removeKey`/`setValueAtTime` is the right way to
      replace an existing tag (vs. accumulating markers on re-apply).
- [ ] `app.beginUndoGroup`/`endUndoGroup` — confirm a thrown ExtendScript error still leaves
      `endUndoGroup()` callable (this WP's `aksharo.jsx` wraps every undo-grouped call in
      `try/finally`; confirm the `finally` branch actually runs when AE's own dialog/alert
      interrupts a script mid-execution, which ExtendScript's error model can behave
      unexpectedly around).
- [ ] `system.callSystem`/CEP shell-open (`openExternalUrl`) — confirm the device-code/pairing
      approval URL opens the OS default browser and not an in-AE dialog.

## Packaging

- [ ] `pnpm release sign-zxp --dry-run` produces a `.zxp` staged from the real
      `plugins/ae-cep` tree (not the placeholder-plugin path in `signZxp.ts`); unzip it and
      confirm `CSXS/manifest.xml`, `index.html`, `dist/panel.js`, and `src/jsx/aksharo.jsx` are
      all present, and that no `node_modules`/`src/**/*.ts`/test files leaked in.
- [ ] Load the packaged (unsigned dry-run) `.zxp` through the CEP debug-install path once real
      icons exist, to catch any relative-path issue `index.html`'s `dist/...` references or
      `CSXS/manifest.xml`'s `ScriptPath` might hit inside a zip.

## Once this checklist is green

Delete the `GATE C:` comments in `src/jsx/aksharo.jsx` and `src/host/ae.ts` that this checklist
resolved, replace `createRealAeHost()`'s `notImplemented` stubs with real `CSInterface.evalScript`
calls into `$.aksharo.*`, add a regression test only where the real call's _shape_ changed (not
its Gate-C status), and file a follow-up work package for anything discovered here that changes
`AeHost`'s public interface (a contract change other WPs may depend on).
