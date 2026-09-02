# `worker_ai.passes`

Pure, dependency-light algorithms behind the `ai.pass` queue's pass kinds. Every
module here takes plain data in and returns plain data out — no network, no
database, no job queue — so each one is fast to property-test in isolation; the
thin queue adapters that unwrap a job payload and call into these modules live
in `apps/worker-ai/worker_ai/processors/`.

| Module              | Pass kind(s)                 | Landed in |
| ------------------- | ---------------------------- | --------- |
| `autocut.py`        | `cut`                        | B18       |
| `scenes.py`         | (shared: scene cuts)         | B19       |
| `tracking.py`       | (shared: subject track)      | B19       |
| `zoom.py`           | `zoom`                       | B19       |
| `reframe.py`        | `reframe`                    | B19       |
| `frame_sampling.py` | (shared: proxy frames + RMS) | B19b      |

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
rendered "moving rectangle face", per the brief's own test spec) and, as of
B19b, in production too: `processors/reframe_zoom_pass._build_face_detector`
gates a real detector behind `PASS_FACE_DETECTOR=yunet` +
`PASS_FACE_DETECTOR_WEIGHTS` (a weights path provisioned at image build,
H-22); with either unset (the only supported configuration right now) it uses
`BrightBlobDetector` over the frames `frame_sampling.py` decoded from the
proxy. Wiring a real YuNet `cv2.FaceDetectorYN` session only requires a new
`FrameDetector` implementation plus removing that gate's "not implemented"
raise — no change to `track_subject`, `frame_sampling.py` or their callers.

## Frame and RMS sampling from the proxy (`frame_sampling.py`, B19b)

B19 shipped `zoom`/`reframe` against pre-extracted frame statistics and
detections the producer (`apps/api/src/passes/passes.service.ts`) was
expected to supply but never did — every request enqueued the pass with
`sceneFrames`/`detections`/`rmsSamples` sent empty, so `zoom` ran on
emphasis-only cues with a fixed `(0.5, 0.5)` saliency centre and `reframe`
failed outright (`worker/invalid_payload`: no subject track to reframe
around). B19b closes this: `processors/reframe_zoom_pass._sample_from_proxy`
downloads the project's 540p proxy (CONTRACTS §6) when the producer sent no
statistics (`_payload_needs_sampling`) and samples it at 10 Hz:

- `frame_sampling.sample_frames` decodes video frames via ffmpeg's `fps`
  filter, downscaled to `<= 320` px wide, piped out as raw `rgb24` (no JPEG
  encode/decode round trip — `apps/worker-media/src/frames/sample.ts` is the
  TS-side JPEG helper for a consumer that wants encoded frames instead), into
  grayscale numpy arrays for `BrightBlobDetector`/a future `FrameDetector`
  plus the mean HSV per frame `scenes.detect_scenes` wants (0..255 scale,
  matching `FrameStat`'s OpenCV convention).
- `frame_sampling.sample_rms` decodes the proxy's audio track with the same
  `worker_ai.audio.read_pcm` every other processor uses and reduces it to one
  RMS value per 100 ms window.

The API producer rejects `zoom`/`reframe` outright (`passes/proxy_required`, 409) when the project's primary media has no proxy yet, so by the time a job
reaches this function a proxy is expected to exist; a download failure is
still handled (`worker/storage_unavailable`, retryable) for the case where the
media row changed underneath the job.

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

## Packed keyframe payload (MKF2, codec unified B19b)

Both passes emit rows in the shared format documented in
`packages/edg/README.md` (`@montaj/edg`'s `encodeKeyframes`/`decodeKeyframes`,
`packages/edg/src/passes/keyframes.ts`) and mirrored here for a reader who
only has this worker checked out:

```
offset  size  field
0       4     magic   ASCII "MKF2"
4       4     version uint32 LE, currently 1
8       4     count   uint32 LE, number of rows
12      20*n  rows    n x { tMs: f32, zoom: f32, cx: f32, cy: f32, ease: f32 }, all LE
```

`tMs` is milliseconds relative to the pass item's own `startMs`; `cx`/`cy` are
the subject/crop centre normalised to the source frame (0..1); `zoom` is the
zoom factor (>= 1); `ease` is packed as a float (`0.0 = "linear"`,
`1.0 = "inOut"`). `processors/reframe_zoom_pass.pack_keyframes` mirrors
`@montaj/edg`'s encoder byte-for-byte (`struct.pack("<4sII", ...)` for the
header, `struct.pack("<fffff", ...)` per row) — see
`apps/worker-ai/tests/test_reframe_zoom_pass_processor.py` for the round-trip
against the TypeScript decoder's exact byte expectations. B19 shipped a
second codec here (`MKF1`, `{tMs, cx, cy, scale}` rows, no per-row `ease`) that
`@montaj/edg`'s `src/keyframes.ts` also implemented; B19b's CONTRACTS §2
amendment deleted `MKF1` — `MKF2` is the only wire format now.

### Storage: inline vs. derived (B19b)

`_keyframe_storage_fields` (`processors/reframe_zoom_pass.py`) decides per
item: a packed curve `<= 64 KiB` rides inline as hex on the wire result's
`keyframes` field (the API completion handler re-encodes it to base64 for
`PassItem.payload.keyframes`); a larger one is uploaded by this worker itself
— via `ObjectStore.upload`, the same direct-write path B10's `ai.clean`
established — to `ws/{workspaceId}/passes/{passId}/{itemId}.mkf` (CONTRACTS
§6), and only `keyframesRef` is sent on the wire. Either way this function
mints the item's id (`worker_ai.ulid.new_ulid`), because the derived key needs
it before the object can exist; the API's completion handler uses that id
verbatim rather than minting its own.

## Models used

| Model                                  | Used for            | Status this WP                                                                                                                                              |
| -------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PySceneDetect `ContentDetector` metric | Scene-cut detection | Re-implemented directly (public algorithm, not a weighted model) — see above                                                                                |
| YuNet (`face_detection_yunet`) ONNX    | Face detection      | **Not wired** — no pinned checksum download in this CPU-only, no-download environment; `FrameDetector` seam ready, `BrightBlobDetector` stands in for tests |
| One Euro Filter                        | Track smoothing     | Re-implemented directly (public algorithm)                                                                                                                  |

No model weight is downloaded or committed by this work package.
