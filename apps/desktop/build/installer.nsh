; Custom NSIS hooks for the Aksharo Windows installer (C10).
;
; electron-builder's `nsis.include` mechanism: this file is spliced into the generated
; installer/uninstaller script and can define any of electron-builder's named macros
; (`customInstall`, `customUnInstall`, `customInit`, ...) without replacing its own
; per-user-install/silent-uninstall/deep-link-registration scaffolding.
;
; Per-user install (electron-builder.yml `nsis.perMachine: false`) means `$PROFILE` is this
; user's own profile directory, matching `packages/bridge-core/src/discovery.ts`'s
; `aksharoDir()` (`homedir()/.aksharo`) -- the local bridge's discovery file a Premiere/AE/
; Resolve plugin polls to find the running desktop app's port + pairing bearer. An uninstall
; must remove just that one file, never the whole `.aksharo` directory (it may also hold
; licence-key/device state a reinstall should still see).

!macro customUnInstall
  Delete "$PROFILE\.aksharo\bridge.json"
!macroend
