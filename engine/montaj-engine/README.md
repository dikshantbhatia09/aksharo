# montaj-engine

The native local engine binary: on-device transcription, VAD and audio clean for the desktop app, with per-platform build scripts and a model manager.

**Status:** placeholder — no code yet. Scaffolded by A01 so the workspace layout
matches `03-architecture/10-build-plan.md` section 1.
**Implemented by:** C03a (binary + model manager), C03b (quality gate), C04 (local mode). See `docs/PLAN.md` for scheduling and blockers.

## Intended stack

| Piece         | Choice                                                                       | Why                                       |
| ------------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| ASR           | whisper.cpp — Metal/CoreML on macOS, Vulkan/CUDA pack on Windows             | native speed, no Python (D36)             |
| Default model | `turbo-q5_0`, with `small` as the fallback                                   | quality/size balance on consumer hardware |
| VAD           | Silero ONNX                                                                  | shared with the cloud worker              |
| Audio clean   | `deep-filter`                                                                | same model family as the cloud path       |
| Media         | ffmpeg                                                                       | same tool as `apps/worker-media`          |
| Delivery      | signed sidecar binary next to the Electron app, backends detected at runtime |                                           |

The name `montaj-engine` is an internal binary name, never shown in the UI.

## Notes

**Gated on quality, not just on the build.** C03b must show a word-boundary error
of 80 ms or less against the cloud aligner on the Hinglish fixture, plus an agreed
WER band, before local mode ships. A00-10 spikes this first.

The binary is signed, version-pinned and hash-checked on launch; IPC is
localhost-only with a token (THREAT-MODEL T22).

## Before writing code here

1. Check `docs/PLAN.md` — this work package may be blocked on a Wave 0 human item.
2. Read `docs/CONTRACTS.md`; the queue, auth and storage contracts are frozen.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering
   codename and must never appear in a user-visible string, id or installer name.
