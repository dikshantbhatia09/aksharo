"""``ai.pass`` (`passType: "zoom"` / `"reframe"`) — B19's edit passes.

Same shape as `processors/autocut_pass.py` (B18): stateless, pure-algorithm
work happens in `worker_ai.passes.{scenes,tracking,zoom,reframe}`, this module
only unwraps the job payload, calls into those modules, and reshapes the
result for the completion callback (`apps/api/src/passes/
passes-completion.handler.ts` turns it into a `MergePass` op).

`process_pass` in `autocut_pass.py` dispatches `passType == "zoom"` and
`"reframe"` here rather than building a second `ai.pass` runner, per the
brief's "reuse that plumbing" instruction.

### Payload shape (producer: `apps/api/src/passes/passes.service.ts`)

Real scene detection and face tracking need decoded video frames
(`proxy540.mp4`, A07) — extracting and decoding them is out of this work
package's scope (no video-decode dependency was added; see
`apps/worker-ai/worker_ai/passes/README.md`'s "Gap" note), so the producer is
expected to supply pre-extracted frame statistics and detections directly on
the job payload rather than this processor fetching and decoding media
itself::

    {
      "passId": "...", "passType": "zoom", "durationMs": 120000,
      "preset": "standard",
      "sceneFrames": [{"tMs": 0, "hue": 40, "sat": 60, "val": 80}, ...],
      "detections": [{"tMs": 0, "boxes": [{"x":0.1,"y":0.1,"w":0.2,"h":0.3}]}],
      "speakingSpeakerAt": {"0": "spk1"},
      "emphasisWords": [{"tMs": 4200}],
      "rmsSamples": [[0, 0.02], [200, 0.03], ...],
      "words": [[0, 300, "hi"], [350, 600, "there"]],
      "cutRanges": [[1000, 1500]],
      "protectedRanges": [[5000, 6000]]
    }

`reframe` additionally reads `sourceAspect`/`targetAspect` (defaults 16/9,
9/16), `deadzoneFraction` and `maxVelocityPerS`.
"""

from __future__ import annotations

import os
import struct
from typing import Any

from worker_ai.callbacks import JobUsage
from worker_ai.passes.frame_sampling import FrameSample, sample_frames, sample_rms
from worker_ai.passes.reframe import build_reframe_track
from worker_ai.passes.scenes import FrameStat, SceneBoundary, detect_scenes, scene_ranges
from worker_ai.passes.tracking import BrightBlobDetector, Detection, FrameDetector, track_subject
from worker_ai.passes.zoom import (
    Cue,
    ZoomEvent,
    build_zoom_events,
    detect_energy_cues,
    detect_sentence_start_cues,
)
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.processors.proxy_media import download_proxy
from worker_ai.storage import StorageError
from worker_ai.ulid import new_ulid

__all__ = ["pack_keyframes", "process_reframe", "process_zoom"]

_KEYFRAME_MAGIC = b"MKF2"
_KEYFRAME_VERSION = 1
_EASE_TO_FLOAT = {"linear": 0.0, "inOut": 1.0}

#: Keyframe payload rule (CONTRACTS §2, added 2026-09-03 after B19b): a packed
#: MKF2 curve <= 64 KiB rides inline as base64 on `PassItem.payload.keyframes`;
#: a larger one is uploaded to derived storage and referenced by
#: `keyframesRef`. The worker (not the API) does the upload, mirroring B10's
#: `ai.clean` — the one other processor in this worker that writes derived
#: media rather than only reading it.
INLINE_LIMIT_BYTES = 64 * 1024


def pack_keyframes(rows: list[tuple[float, float, float, float, str]]) -> bytes:
    """Byte-for-byte the same little-endian packed format
    `@montaj/edg`'s `encodeKeyframes` writes (`packages/edg/src/passes/
    keyframes.ts`, the one codec after B19b unified `MKF1`/`MKF2`): a 12-byte
    header (magic `MKF2`, version, count) then 20 bytes per row
    (`tMs, zoom, cx, cy, ease`, each an IEEE-754 binary32; `ease` packed as
    `0.0 = "linear"`, `1.0 = "inOut"`).
    """
    ordered = sorted(rows, key=lambda row: row[0])
    header = struct.pack("<4sII", _KEYFRAME_MAGIC, _KEYFRAME_VERSION, len(ordered))
    body = b"".join(
        struct.pack("<fffff", t_ms, zoom, cx, cy, _EASE_TO_FLOAT[ease])
        for t_ms, zoom, cx, cy, ease in ordered
    )
    return header + body


def _payload_needs_sampling(payload: dict[str, Any]) -> bool:
    """True when the producer sent no pre-extracted frame/audio statistics —
    the common case now that `passes.service.ts` no longer sends them empty
    (B19b) — so this processor should sample the proxy itself. A payload that
    already carries `detections`/`sceneFrames`/`rmsSamples` (a unit test's own
    fixture, or a future producer that samples upstream) is honoured as-is.
    """
    return not (
        _nonempty_list(payload.get("detections"))
        or _nonempty_list(payload.get("sceneFrames"))
        or _nonempty_list(payload.get("rmsSamples"))
    )


def _nonempty_list(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def _build_face_detector(frames: list[FrameSample]) -> FrameDetector:
    """The B19b detector seam (brief ruling 6): `PASS_FACE_DETECTOR=yunet`
    would select a real ONNX face detector, but its weights are not
    provisioned in this work package (H-22 provisions them at image build),
    so any other value — including unset — keeps the `BrightBlobDetector`
    stand-in `worker_ai.passes.tracking` already ships.
    """
    requested = os.environ.get("PASS_FACE_DETECTOR", "").strip().lower()
    if requested == "yunet":
        weights = os.environ.get("PASS_FACE_DETECTOR_WEIGHTS", "").strip()
        if not weights:
            raise JobFailureError(
                "worker/config_missing",
                "PASS_FACE_DETECTOR=yunet needs PASS_FACE_DETECTOR_WEIGHTS "
                "(a weights path provisioned at image build, H-22); it is not "
                "set, so this deployment cannot run the real detector yet",
                retryable=False,
            )
        raise JobFailureError(
            "worker/not_implemented",
            "a YuNet FrameDetector is not implemented in this work package "
            "(brief ruling 6) — unset PASS_FACE_DETECTOR to use the "
            "BrightBlobDetector stand-in",
            retryable=False,
        )
    return BrightBlobDetector(frames=[sample.gray for sample in frames])


async def _sample_from_proxy(
    context: JobContext, duration_ms: int
) -> tuple[list[FrameStat], list[dict[str, Any]], list[tuple[int, float]]]:
    """Download the 540p proxy (CONTRACTS §6) and sample scene-cut frame
    stats, subject-tracking detections and RMS audio energy at 10 Hz (brief
    ruling 4). Raises `JobFailureError` (`worker/proxy_required`,
    non-retryable) when no proxy key can be resolved, and
    `worker/storage_unavailable` (retryable) when the download itself fails —
    the API producer is expected to have already rejected a project with no
    proxy (`passes/proxy_required`), so reaching this function without one
    means the media row changed underneath the job.
    """
    destination = await download_proxy(context)

    frames = sample_frames(destination, duration_ms)
    scene_frames = [
        FrameStat(t_ms=frame.t_ms, hue=frame.hue, sat=frame.sat, val=frame.val) for frame in frames
    ]
    detector = _build_face_detector(frames)
    detections: list[dict[str, Any]] = []
    for index, frame in enumerate(frames):
        boxes = detector.detect(index, frame.t_ms)
        detections.append(
            {
                "tMs": frame.t_ms,
                "boxes": [
                    {"x": box.x, "y": box.y, "w": box.w, "h": box.h, "score": box.score}
                    for box in boxes
                ],
            }
        )
    rms_samples = sample_rms(destination, duration_ms)
    return scene_frames, detections, rms_samples


async def process_zoom(context: JobContext) -> ProcessorOutcome:
    payload = context.envelope.payload
    pass_id = context.payload_str("passId", required=True)
    preset = context.payload_str("preset", default="standard")
    duration_ms = _int(payload.get("durationMs"), default=0)

    if _payload_needs_sampling(payload):
        await context.progress(5, message="sampling frames and audio from the proxy")
        scene_frames, detections, rms_samples = await _sample_from_proxy(context, duration_ms)
        payload = {
            **payload,
            "sceneFrames": [
                {"tMs": f.t_ms, "hue": f.hue, "sat": f.sat, "val": f.val} for f in scene_frames
            ],
            "detections": detections,
            "rmsSamples": [[t, v] for t, v in rms_samples],
        }

    await context.progress(10, message="detecting scenes")
    scene_cuts_ms = _scene_cut_points(payload, duration_ms)

    await context.progress(30, message="tracking subject")
    subject_track = _subject_track(payload, duration_ms)
    subject_points = [(p.t_ms, p.cx, p.cy) for p in subject_track]

    await context.progress(50, message="detecting cues")
    cues = _detect_cues(payload)

    cut_ranges = _read_ranges(payload.get("cutRanges"))
    protected_ranges = _read_ranges(payload.get("protectedRanges"))
    guarded = [*cut_ranges, *protected_ranges]

    await context.progress(70, message=f"building zoom events ({len(cues)} cues)")
    events = build_zoom_events(
        cues,
        subject_points,
        preset=preset,
        scene_cuts=scene_cuts_ms,
        cut_ranges=guarded,
    )
    await context.progress(90, message=f"{len(events)} zoom events proposed")

    return ProcessorOutcome(
        result={
            "passId": pass_id,
            "passType": "zoom",
            "preset": preset,
            "items": [_zoom_item_wire(context, pass_id, event) for event in events],
        },
        usage=JobUsage(media_seconds=duration_ms / 1000 if duration_ms else None),
    )


async def process_reframe(context: JobContext) -> ProcessorOutcome:
    payload = context.envelope.payload
    pass_id = context.payload_str("passId", required=True)
    duration_ms = _int(payload.get("durationMs"), default=0)
    source_aspect = _float(payload.get("sourceAspect"), default=16 / 9)
    target_aspect = _float(payload.get("targetAspect"), default=9 / 16)
    deadzone_fraction = _float(payload.get("deadzoneFraction"), default=0.08)
    max_velocity_per_s = _float(payload.get("maxVelocityPerS"), default=0.8)

    if _payload_needs_sampling(payload):
        await context.progress(5, message="sampling frames and audio from the proxy")
        scene_frames, detections, rms_samples = await _sample_from_proxy(context, duration_ms)
        payload = {
            **payload,
            "sceneFrames": [
                {"tMs": f.t_ms, "hue": f.hue, "sat": f.sat, "val": f.val} for f in scene_frames
            ],
            "detections": detections,
            "rmsSamples": [[t, v] for t, v in rms_samples],
        }

    await context.progress(10, message="detecting scenes")
    scene_cuts_ms = _scene_cut_points(payload, duration_ms)
    ranges = scene_ranges(
        [SceneBoundary(at_ms=cut_ms, score=0.0) for cut_ms in scene_cuts_ms],
        duration_ms,
    )

    await context.progress(40, message="tracking subject")
    subject_track = _subject_track(payload, duration_ms)
    subject_points = [(p.t_ms, p.cx, p.cy) for p in subject_track]

    await context.progress(70, message="building reframe track")
    result = build_reframe_track(
        subject_points,
        scene_ranges=ranges,
        source_aspect=source_aspect,
        target_aspect=target_aspect,
        deadzone_fraction=deadzone_fraction,
        max_velocity_per_s=max_velocity_per_s,
    )
    await context.progress(90, message=f"{len(result.keyframes)} reframe keyframes")

    if not result.keyframes:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.pass (reframe) produced no keyframes: empty subject track or scene ranges",
            retryable=False,
        )

    packed = pack_keyframes(
        [(float(k.t_ms), k.scale, k.cx, k.cy, k.ease) for k in result.keyframes]
    )
    aspect_label = _aspect_label(target_aspect)

    return ProcessorOutcome(
        result={
            "passId": pass_id,
            "passType": "reframe",
            "items": [
                {
                    **_keyframe_storage_fields(context, pass_id, packed),
                    "startMs": 0,
                    "endMs": duration_ms,
                    "aspect": aspect_label,
                    "letterboxScenes": list(result.letterbox_scenes),
                    "reason": "reframe",
                    "confidence": 0.7,
                }
            ],
        },
        usage=JobUsage(media_seconds=duration_ms / 1000 if duration_ms else None),
    )


def _aspect_label(target_aspect: float) -> str:
    if abs(target_aspect - 1.0) < 1e-6:
        return "1:1"
    return "9:16"


def _keyframe_storage_fields(context: JobContext, pass_id: str, packed: bytes) -> dict[str, Any]:
    """Mint this item's id and decide inline vs. derived storage for its
    packed keyframes (CONTRACTS §2 keyframe payload rule, B19b).

    The item id is minted here, not by the API's completion handler, because
    the derived key (`ws/{workspaceId}/passes/{passId}/{itemId}.mkf`,
    CONTRACTS §6) needs it before the object can be uploaded — the API is
    told to use this id verbatim rather than minting its own.
    """
    item_id = new_ulid()
    if len(packed) <= INLINE_LIMIT_BYTES:
        return {"itemId": item_id, "keyframes": packed.hex()}

    store = context.services.derived_store
    if store is None:
        raise JobFailureError(
            "worker/storage_unconfigured",
            "R2_ENDPOINT, R2_BUCKET_DERIVED and the R2 credentials are required "
            "to upload a keyframe curve over the 64 KiB inline limit",
            retryable=False,
        )
    key = f"ws/{context.envelope.workspace_id}/passes/{pass_id}/{item_id}.mkf"
    local = context.workdir / f"{item_id}.mkf"
    local.write_bytes(packed)
    try:
        store.upload(local, key)
    except StorageError as error:
        raise JobFailureError("worker/storage_unavailable", str(error), retryable=True) from error
    return {"itemId": item_id, "keyframesRef": key}


def _zoom_item_wire(context: JobContext, pass_id: str, event: ZoomEvent) -> dict[str, Any]:
    packed = pack_keyframes([(float(k.t_ms), k.scale, k.cx, k.cy, k.ease) for k in event.keyframes])
    return {
        **_keyframe_storage_fields(context, pass_id, packed),
        "startMs": event.start_ms,
        "endMs": event.end_ms,
        "scaleFrom": 1.0,
        "scaleTo": event.keyframes[2].scale if len(event.keyframes) > 2 else 1.0,
        "target": {
            "x": max(0.0, event.keyframes[0].cx - 0.15),
            "y": max(0.0, event.keyframes[0].cy - 0.15),
            "w": 0.3,
            "h": 0.3,
        },
        "reason": event.reason,
        "confidence": round(event.confidence, 4),
    }


def _scene_cut_points(payload: dict[str, Any], duration_ms: int) -> list[int]:
    explicit = payload.get("sceneCuts")
    if isinstance(explicit, list):
        return [_int(v, default=0) for v in explicit]
    frames_raw = payload.get("sceneFrames")
    if not isinstance(frames_raw, list) or len(frames_raw) < 2:
        return []
    frames = [
        FrameStat(
            t_ms=_int(item.get("tMs"), default=0),
            hue=_float(item.get("hue"), default=0.0),
            sat=_float(item.get("sat"), default=0.0),
            val=_float(item.get("val"), default=0.0),
        )
        for item in frames_raw
        if isinstance(item, dict)
    ]
    boundaries = detect_scenes(frames)
    return [b.at_ms for b in boundaries]


def _subject_track(payload: dict[str, Any], duration_ms: int) -> list[Any]:
    raw = payload.get("detections")
    speaking_raw = payload.get("speakingSpeakerAt")
    speaking_speaker_at: dict[int, str] = {}
    if isinstance(speaking_raw, dict):
        for key, value in speaking_raw.items():
            if isinstance(value, str):
                speaking_speaker_at[_int(key, default=0)] = value

    if not isinstance(raw, list) or not raw:
        return []

    frames: list[tuple[int, list[Detection]]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        t_ms = _int(item.get("tMs"), default=0)
        boxes_raw = item.get("boxes")
        boxes: list[Detection] = []
        if isinstance(boxes_raw, list):
            for box in boxes_raw:
                if not isinstance(box, dict):
                    continue
                boxes.append(
                    Detection(
                        t_ms=t_ms,
                        x=_float(box.get("x"), default=0.0),
                        y=_float(box.get("y"), default=0.0),
                        w=_float(box.get("w"), default=0.0),
                        h=_float(box.get("h"), default=0.0),
                        score=_float(box.get("score"), default=1.0),
                        speaker_id=(
                            box.get("speakerId") if isinstance(box.get("speakerId"), str) else None
                        ),
                    )
                )
        frames.append((t_ms, boxes))

    return track_subject(frames, speaking_speaker_at=speaking_speaker_at)


def _detect_cues(payload: dict[str, Any]) -> list[Cue]:
    cues: list[Cue] = []

    emphasis_raw = payload.get("emphasisWords")
    if isinstance(emphasis_raw, list):
        for item in emphasis_raw:
            if isinstance(item, dict) and "tMs" in item:
                cues.append(
                    Cue(
                        t_ms=_int(item.get("tMs"), default=0),
                        kind="emphasis",
                        confidence=0.9,
                        reason="emphasis",
                    )
                )

    rms_raw = payload.get("rmsSamples")
    if isinstance(rms_raw, list):
        samples: list[tuple[int, float]] = []
        for item in rms_raw:
            if isinstance(item, list) and len(item) == 2:
                samples.append((_int(item[0], default=0), _float(item[1], default=0.0)))
        cues.extend(detect_energy_cues(samples))

    words_raw = payload.get("words")
    if isinstance(words_raw, list):
        words: list[tuple[int, int, str]] = []
        for item in words_raw:
            if isinstance(item, list) and len(item) == 3:
                words.append((_int(item[0], default=0), _int(item[1], default=0), str(item[2])))
        cues.extend(detect_sentence_start_cues(words))

    return cues


def _read_ranges(raw: Any) -> list[tuple[int, int]]:
    if not isinstance(raw, list):
        return []
    ranges: list[tuple[int, int]] = []
    for item in raw:
        if isinstance(item, list) and len(item) == 2:
            ranges.append((_int(item[0], default=0), _int(item[1], default=0)))
    return ranges


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _float(value: Any, *, default: float) -> float:
    if isinstance(value, bool) or value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    return default
