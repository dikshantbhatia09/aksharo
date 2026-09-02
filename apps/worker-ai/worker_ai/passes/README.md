# `worker_ai.passes`

Pure, dependency-light algorithms behind the `ai.pass` queue's pass kinds. Every
module here takes plain data in and returns plain data out — no network, no
database, no job queue — so each one is fast to property-test in isolation; the
thin queue adapters that unwrap a job payload and call into these modules live
in `apps/worker-ai/worker_ai/processors/`.

| Module        | Pass kind(s)            | Landed in |
| ------------- | ----------------------- | --------- |
| `autocut.py`  | `cut`                   | B18       |
| `scenes.py`   | (shared: scene cuts)    | B19       |
| `tracking.py` | (shared: subject track) | B19       |
| `zoom.py`     | `zoom`                  | B19       |
| `reframe.py`  | `reframe`               | B19       |

## Scene detection (`scenes.py`)

`detect_scenes` re-implements PySceneDetect's `ContentDetector` metric directly
(the mean of the three HSV channels' absolute frame-to-frame deltas, flagged as
a cut past a threshold, default 27.0 on a 0..255 scale — PySceneDetect's own
default) rather than depending on the `scenedetect` package. That is a
deliberate, in-scope call, not an oversight: the algorithm is public and
well-known (not a model), and re-implementing it keeps this worker's
dependency footprint the same shape as every other pass here — pure Python
plus `numpy`, no extra native/video-decode dependency chain, fixture-testable
without an actual video file. `scene_ranges` turns cut points into `[start,
end)` windows.

## Subject tracking (`tracking.py`)

The brief calls for OpenCV's YuNet ONNX face detector at 5 fps plus an IoU/
Kalman tracker, a saliency-centre fallback, and a one-euro filter. This module
ships the parts that do not require a model:

- `OneEuroFilter` — the standard adaptive smoothing filter (Casiez, Roussel,
  Vogel 2012), tuned here for camera-motion cadence.
- `IouTracker` — links one chosen detection per frame into a running track by
  intersection-over-union against the previous frame.
- `track_subject` — the full pipeline: per-frame detection → multi-face
  resolution (speaking speaker via diarisation overlap, else largest box) →
  IoU linking → held-last-known-centre on a miss → saliency fallback when a
  whole scene has no detection → one-euro smoothing.
- `FrameDetector` — the seam a face detector plugs into (`detect(frame_index,
t_ms) -> list[Detection]`).

**Gap, documented rather than silently worked around:** YuNet's ONNX weight is
a pinned-checksum binary this CPU-only, no-download work package cannot fetch
or commit (the same "no downloads into the repo" constraint A10/B18 worked
under). `BrightBlobDetector` — the brightest axis-aligned rectangle in a
grayscale frame — stands in for it in the synthetic tracking tests (a
rendered "moving rectangle face", per the brief's own test spec); wiring a
real YuNet `cv2.FaceDetectorYN` session only requires a new `FrameDetector`
implementation, no change to `track_subject` or its callers. This is flagged
in the final report as an open question: whether a follow-up work package
should add `opencv-python-headless` + a pinned YuNet download step to the
worker image build (outside a source checkout), the way A07's frame
extraction likely already depends on `ffmpeg` being present in the image
rather than the repo.

## Zoom pass (`zoom.py`)

Cues: emphasis words (A11, passed in by the processor), audio RMS z-score > 2
(`detect_energy_cues`), and sentence starts after a pause
(`detect_sentence_start_cues`). `build_zoom_events` turns accepted cues into
punch-in events:

| Preset     | Scale target |
| ---------- | ------------ |
| `subtle`   | 1.15         |
| `standard` | 1.20         |
| `punchy`   | 1.30         |

Every event ramps 1.0 → target over 180 ms ease-out-cubic
(`ease_out_cubic`), holds >= 600 ms, returns over 260 ms — four keyframe rows
per event. Rate limit: at most one zoom every 2.5 s (earliest cue wins on a
collision, breaking ties toward the higher-confidence one); an event that
would straddle a scene cut, or overlap an accepted `cut` pass item's range, is
dropped rather than shortened.

## Reframe pass (`reframe.py`)

`build_reframe_track` samples the subject track at 10 Hz and produces a
horizontal crop-window centre curve for 16:9 → 9:16/1:1 output: an 8%-of-width
deadzone (no pan while the subject stays inside it), a maximum pan velocity
cap once it leaves the deadzone, a hard cut (no pan, straight jump) at every
scene boundary, and a `letterbox_scenes` flag for scenes the caller judged
multi-subject wide shots. The 10 Hz samples are simplified with
`rdp_simplify` (Ramer–Douglas–Peucker) before being packed, so a steady pan
collapses to its shape-defining points rather than 10 samples/second of
near-duplicates.

## Packed keyframe payload

Both passes emit rows in the shared format documented in
`packages/edg/README.md` (`packKeyframes`/`unpackKeyframes`) and mirrored here
for a reader who only has this worker checked out:

```
offset  size  field
0       4     magic   ASCII "MKF1"
4       4     version uint32 LE, currently 1
8       4     count   uint32 LE, number of rows
12      16*n  rows    n x { tMs: f32, cx: f32, cy: f32, scale: f32 }, all LE
```

`tMs` is milliseconds relative to the pass item's own `startMs`; `cx`/`cy` are
the subject/crop centre normalised to the source frame (0..1); `scale` is the
zoom factor (>= 1). The processor packs these with a small pure-Python encoder
mirroring `@montaj/edg`'s TypeScript one byte-for-byte (`struct.pack("<4sIII",
...)` for the header, `struct.pack("<ffff", ...)` per row) — see
`apps/worker-ai/tests/test_reframe_zoom_pass_processor.py` for the round-trip
against the TypeScript decoder's exact byte expectations.

## Models used

| Model                                  | Used for            | Status this WP                                                                                                                                              |
| -------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PySceneDetect `ContentDetector` metric | Scene-cut detection | Re-implemented directly (public algorithm, not a weighted model) — see above                                                                                |
| YuNet (`face_detection_yunet`) ONNX    | Face detection      | **Not wired** — no pinned checksum download in this CPU-only, no-download environment; `FrameDetector` seam ready, `BrightBlobDetector` stands in for tests |
| One Euro Filter                        | Track smoothing     | Re-implemented directly (public algorithm)                                                                                                                  |

No model weight is downloaded or committed by this work package.
