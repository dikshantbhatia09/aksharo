"""Automated Multi-Cam Director Engine & Multi-Speaker Grid Switcher (Pillar 3 §03).

Translates Pyannote speaker diarization turns and multi-participant face
bounding boxes (3 to 5+ speakers) into a timed Edit Decision List (EDL) of
camera cuts (`LayoutCut[]`):

1. Dynamically cuts between ``SOLO`` full-screen close-ups (1080 × 1920) of
   whoever is actively speaking during monologues (> 3.0s).
2. Switches to a ``TRI_PANEL`` stack (Active Speaker in Top 60% = 1080 × 1152,
   Two Panelists in Bottom 40% = two 540 × 768 reaction tiles) or a ``GRID_4``
   2×2 grid (four 540 × 960 tiles) during rapid dialogue turnarounds (< 1.8s per
   turn), overlapping speech, or group laughter/reactions.
3. Enforces **shot duration hysteresis** (minimum 2.0s / 60-frame hold time) and
   rejects brief non-dialogue vocalizations (< 1.2s coughs or affirmative
   backchannels like *"yeah"*, *"uh-huh"*) so false switches are suppressed
   (>= 98.5% rejection SLA) and switch decision latency remains <= 50ms per cut.
4. Applies AutoCut lead-in (250ms before first spoken word) and lead-out (350ms
   after last spoken word) padding for natural visual pacing.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from worker_ai.callbacks import JobUsage
from worker_ai.logging_setup import get_logger
from worker_ai.passes.faces import MIN_FACE_HEIGHT, FaceBox, FaceSample, bound_faces
from worker_ai.processors.context import JobContext, ProcessorOutcome

__all__ = [
    "DEFAULT_CANVAS_HEIGHT",
    "DEFAULT_CANVAS_WIDTH",
    "DEFAULT_SOURCE_HEIGHT",
    "DEFAULT_SOURCE_WIDTH",
    "FALSE_SWITCH_MAX_DURATION_SEC",
    "LEAD_IN_PADDING_SEC",
    "LEAD_OUT_PADDING_SEC",
    "LAYOUT_GRID_4",
    "LAYOUT_SOLO",
    "LAYOUT_SPLIT_2",
    "LAYOUT_TRI_PANEL",
    "MIN_HOLD_FRAMES_30FPS",
    "MIN_SHOT_DURATION_SEC",
    "RAPID_TURNAROUND_THRESHOLD_SEC",
    "SOLO_MONOLOGUE_THRESHOLD_SEC",
    "STATE_GRID",
    "STATE_SOLO",
    "DiarizedTurn",
    "DirectorStateMachine",
    "LayoutCut",
    "LayoutPaneAssignment",
    "SpeakerFaceBox",
    "apply_layout_override",
    "apply_lead_padding",
    "build_layout_edl",
    "cluster_multispeaker_faces",
    "compute_crop_rect_for_pane",
    "compute_pane_assignments",
    "enforce_minimum_shot_duration",
    "filter_non_dialogue_vocalizations",
    "generate_director_edl",
    "normalise_diarization_turns",
    "normalise_speaker_boxes",
    "plan_multispeaker_edl",
    "process_director",
]

_log = get_logger(__name__)

# ---------------------------------------------------------------------------
# Director Constants & SLAs (Pillar 3 §03)
# ---------------------------------------------------------------------------

MIN_SHOT_DURATION_SEC: float = 2.0
MIN_HOLD_FRAMES_30FPS: int = 60
FALSE_SWITCH_MAX_DURATION_SEC: float = 1.2
LEAD_IN_PADDING_SEC: float = 0.25
LEAD_OUT_PADDING_SEC: float = 0.35
SOLO_MONOLOGUE_THRESHOLD_SEC: float = 3.0
RAPID_TURNAROUND_THRESHOLD_SEC: float = 1.8

DEFAULT_SOURCE_WIDTH: int = 1920
DEFAULT_SOURCE_HEIGHT: int = 1080
DEFAULT_CANVAS_WIDTH: int = 1080
DEFAULT_CANVAS_HEIGHT: int = 1920

LAYOUT_SOLO: str = "SOLO"
LAYOUT_SPLIT_2: str = "SPLIT_2"
LAYOUT_TRI_PANEL: str = "TRI_PANEL"
LAYOUT_GRID_4: str = "GRID_4"

STATE_SOLO: str = "STATE_SOLO"
STATE_GRID: str = "STATE_GRID"

_NON_DIALOGUE_TOKENS: frozenset[str] = frozenset(
    {
        "yeah",
        "yep",
        "yup",
        "uh-huh",
        "uh huh",
        "mm-hmm",
        "mm hmm",
        "mhm",
        "hmm",
        "uh",
        "um",
        "ah",
        "oh",
        "right",
        "okay",
        "ok",
        "sure",
        "true",
        "wow",
        "[cough]",
        "[throat_clear]",
        "[grunt]",
        "[breath]",
    }
)


def _floor_even(value: float, minimum: int = 2) -> int:
    return max(minimum, int(math.floor(value / 2.0)) * 2)


def _round_even(value: float, minimum: int = 2) -> int:
    return max(minimum, int(round(value / 2.0)) * 2)


def _median_float(values: Sequence[float], default: float = 0.5) -> float:
    if not values:
        return default
    ordered = sorted(float(v) for v in values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return 0.5 * (ordered[mid - 1] + ordered[mid])


# ---------------------------------------------------------------------------
# Data Contracts
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DiarizedTurn:
    """Normalised speaker speech turn in seconds."""

    speaker_id: str
    start_sec: float
    end_sec: float
    is_reaction: bool = False
    is_vocal_noise: bool = False
    text: str = ""

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)


@dataclass(frozen=True, slots=True)
class SpeakerFaceBox:
    """Normalised (0..1) face bounding box for a tracked participant."""

    speaker_id: str
    x: float
    y: float
    width: float
    height: float

    @property
    def center_x(self) -> float:
        return self.x + self.width / 2.0

    @property
    def center_y(self) -> float:
        return self.y + self.height / 2.0


class LayoutPaneAssignment(dict[str, Any]):
    """One pane assignment inside a :class:`LayoutCut` matching the TypeScript
    ``LayoutCut["paneAssignments"][number]`` contract.
    """

    def __init__(
        self,
        *,
        speaker_id: str,
        crop_rect: Mapping[str, int],
        canvas_position: Mapping[str, int],
    ) -> None:
        crop = {
            "x": int(crop_rect["x"]),
            "y": int(crop_rect["y"]),
            "width": int(crop_rect["width"]),
            "height": int(crop_rect["height"]),
        }
        canvas = {
            "x": int(canvas_position["x"]),
            "y": int(canvas_position["y"]),
            "width": int(canvas_position["width"]),
            "height": int(canvas_position["height"]),
        }
        super().__init__(
            speakerId=str(speaker_id),
            cropRect=crop,
            canvasPosition=canvas,
        )

    @property
    def speaker_id(self) -> str:
        return str(self["speakerId"])

    @property
    def speakerId(self) -> str:  # noqa: N802
        return str(self["speakerId"])

    @property
    def crop_rect(self) -> dict[str, int]:
        return dict(self["cropRect"])

    @property
    def cropRect(self) -> dict[str, int]:  # noqa: N802
        return dict(self["cropRect"])

    @property
    def canvas_position(self) -> dict[str, int]:
        return dict(self["canvasPosition"])

    @property
    def canvasPosition(self) -> dict[str, int]:  # noqa: N802
        return dict(self["canvasPosition"])


class LayoutCut(dict[str, Any]):
    """One timed camera cut and multi-pane layout assignment in the Director EDL
    (Pillar 3 §03 §4.1).
    """

    def __init__(
        self,
        *,
        start_sec: float,
        end_sec: float,
        layout_type: str,
        active_speaker_id: str,
        pane_assignments: Sequence[LayoutPaneAssignment | Mapping[str, Any]],
    ) -> None:
        panes = [
            p
            if isinstance(p, LayoutPaneAssignment)
            else LayoutPaneAssignment(
                speaker_id=str(p["speakerId"]),
                crop_rect=p["cropRect"],
                canvas_position=p["canvasPosition"],
            )
            for p in pane_assignments
        ]
        super().__init__(
            startSec=round(float(start_sec), 4),
            endSec=round(float(end_sec), 4),
            layoutType=str(layout_type),
            activeSpeakerId=str(active_speaker_id),
            paneAssignments=panes,
        )
        self._panes = tuple(panes)

    @property
    def start_sec(self) -> float:
        return float(self["startSec"])

    @property
    def startSec(self) -> float:  # noqa: N802
        return float(self["startSec"])

    @property
    def end_sec(self) -> float:
        return float(self["endSec"])

    @property
    def endSec(self) -> float:  # noqa: N802
        return float(self["endSec"])

    @property
    def duration_sec(self) -> float:
        return round(float(self["endSec"]) - float(self["startSec"]), 4)

    @property
    def durationSec(self) -> float:  # noqa: N802
        return self.duration_sec

    @property
    def layout_type(self) -> str:
        return str(self["layoutType"])

    @property
    def layoutType(self) -> str:  # noqa: N802
        return str(self["layoutType"])

    @property
    def active_speaker_id(self) -> str:
        return str(self["activeSpeakerId"])

    @property
    def activeSpeakerId(self) -> str:  # noqa: N802
        return str(self["activeSpeakerId"])

    @property
    def pane_assignments(self) -> list[LayoutPaneAssignment]:
        return list(self._panes)

    @property
    def paneAssignments(self) -> list[LayoutPaneAssignment]:  # noqa: N802
        return list(self._panes)


# ---------------------------------------------------------------------------
# Normalisation & Multi-Speaker Face Clustering (3..5+ Speakers)
# ---------------------------------------------------------------------------


def normalise_diarization_turns(
    raw_turns: Sequence[Any],
) -> list[DiarizedTurn]:
    """Normalise Pyannote diarization segments or turn dicts/tuples into sorted
    :class:`DiarizedTurn` instances in seconds.
    """
    turns: list[DiarizedTurn] = []
    for item in raw_turns:
        speaker_id = "SPEAKER_00"
        start_sec = 0.0
        end_sec = 0.0
        is_reaction = False
        is_vocal_noise = False
        text = ""

        if isinstance(item, DiarizedTurn):
            turns.append(item)
            continue
        elif isinstance(item, Mapping):
            speaker_id = str(
                item.get(
                    "speakerId",
                    item.get("speaker_id", item.get("speaker", item.get("activeSpeakerId", "SPEAKER_00"))),
                )
            )
            if "startSec" in item or "endSec" in item or "start_sec" in item or "end_sec" in item:
                start_sec = float(item.get("startSec", item.get("start_sec", 0.0)))
                end_sec = float(item.get("endSec", item.get("end_sec", start_sec)))
            elif "startMs" in item or "endMs" in item or "start_ms" in item or "end_ms" in item:
                start_sec = float(item.get("startMs", item.get("start_ms", 0.0))) / 1000.0
                end_sec = float(item.get("endMs", item.get("end_ms", 0.0))) / 1000.0
            else:
                raw_s = float(item.get("start", 0.0))
                raw_e = float(item.get("end", raw_s))
                # Heuristic: if timestamps are > 1000 and look like milliseconds
                if raw_e > 1000.0 and raw_e - raw_s >= 50.0:
                    start_sec = raw_s / 1000.0
                    end_sec = raw_e / 1000.0
                else:
                    start_sec = raw_s
                    end_sec = raw_e

            text = str(item.get("text", item.get("utterance", ""))).strip()
            vocal_type = str(item.get("vocalType", item.get("vocal_type", item.get("kind", "")))).lower()
            is_reaction = bool(
                item.get("isReaction", item.get("is_reaction", False))
                or item.get("isLaughter", item.get("is_laughter", False))
                or vocal_type in ("laughter", "reaction", "applause", "group_reaction")
                or speaker_id.upper() in ("GROUP", "ALL", "LAUGHTER", "REACTION")
            )
            is_vocal_noise = bool(
                item.get("isVocalNoise", item.get("is_vocal_noise", False))
                or item.get("isBackchannel", item.get("is_backchannel", False))
                or vocal_type in ("cough", "grunt", "backchannel", "filler", "vocalization", "noise")
            )
        elif hasattr(item, "speaker_id") and (hasattr(item, "start_ms") or hasattr(item, "start_sec")):
            speaker_id = str(item.speaker_id)
            if hasattr(item, "start_sec"):
                start_sec = float(item.start_sec)
                end_sec = float(item.end_sec)
            else:
                start_sec = float(item.start_ms) / 1000.0
                end_sec = float(item.end_ms) / 1000.0
        elif isinstance(item, Sequence) and len(item) >= 3:
            if isinstance(item[0], str):
                speaker_id = str(item[0])
                start_sec = float(item[1])
                end_sec = float(item[2])
            else:
                start_sec = float(item[0])
                end_sec = float(item[1])
                speaker_id = str(item[2])
            if len(item) >= 4 and isinstance(item[3], bool):
                is_reaction = bool(item[3])
        else:
            continue

        if end_sec <= start_sec:
            continue

        clean_text = text.lower().strip(" .,!?\"'")
        if clean_text and clean_text in _NON_DIALOGUE_TOKENS:
            is_vocal_noise = True

        turns.append(
            DiarizedTurn(
                speaker_id=speaker_id,
                start_sec=max(0.0, start_sec),
                end_sec=max(0.0, end_sec),
                is_reaction=is_reaction,
                is_vocal_noise=is_vocal_noise,
                text=text,
            )
        )

    turns.sort(key=lambda t: (t.start_sec, -t.duration_sec, t.speaker_id))
    return turns


def cluster_multispeaker_faces(
    samples_or_boxes: Sequence[Any],
    *,
    num_speakers: int | None = None,
    max_speakers: int = 5,
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
) -> dict[str, SpeakerFaceBox]:
    """Cluster detected faces across video frames into 1..``max_speakers``
    distinct participant tracks (``SPEAKER_00`` .. ``SPEAKER_0{N-1}``), ordered
    from left to right (and top to bottom for 2×2 Zoom grids).
    """
    sw = max(1.0, float(source_width))
    sh = max(1.0, float(source_height))

    per_sample: list[list[FaceBox]] = []
    flat_boxes: list[FaceBox] = []

    def _to_box(raw: Any) -> FaceBox | None:
        if isinstance(raw, FaceBox):
            x, y, w, h, s = raw.x, raw.y, raw.w, raw.h, raw.score
        elif isinstance(raw, Mapping):
            x = float(raw.get("x", raw.get("left", 0.0)))
            y = float(raw.get("y", raw.get("top", 0.0)))
            w = float(raw.get("w", raw.get("width", 0.12)))
            h = float(raw.get("h", raw.get("height", 0.18)))
            s = float(raw.get("score", 0.95))
        elif isinstance(raw, Sequence) and len(raw) >= 4:
            x, y, w, h = float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3])
            s = float(raw[4]) if len(raw) >= 5 else 0.95
        else:
            return None

        if x > 1.5 or y > 1.5 or w > 1.5 or h > 1.5:
            x /= sw
            y /= sh
            w /= sw
            h /= sh
        if w <= 0.0 or h < MIN_FACE_HEIGHT:
            return None
        return FaceBox(
            x=min(1.0, max(0.0, x)),
            y=min(1.0, max(0.0, y)),
            w=min(1.0, max(0.02, w)),
            h=min(1.0, max(MIN_FACE_HEIGHT, h)),
            score=s,
        )

    for entry in samples_or_boxes:
        if isinstance(entry, FaceSample):
            usable = list(bound_faces(entry.boxes)[:max_speakers])
            if usable:
                per_sample.append(usable)
                flat_boxes.extend(usable)
        elif (
            isinstance(entry, Sequence)
            and len(entry) == 2
            and isinstance(entry[0], (int, float))
            and isinstance(entry[1], Sequence)
        ):
            sample_boxes = [b for raw_b in entry[1] if (b := _to_box(raw_b)) is not None]
            sample_boxes.sort(key=lambda b: b.w * b.h, reverse=True)
            kept = sample_boxes[:max_speakers]
            if kept:
                per_sample.append(kept)
                flat_boxes.extend(kept)
        else:
            box = _to_box(entry)
            if box is not None:
                flat_boxes.append(box)

    if not flat_boxes:
        return {
            "SPEAKER_00": SpeakerFaceBox("SPEAKER_00", 0.35, 0.25, 0.30, 0.45),
        }

    if num_speakers is not None:
        k = max(1, min(max_speakers, int(num_speakers)))
    elif per_sample:
        counts = sorted(len(s) for s in per_sample)
        p75_count = counts[min(len(counts) - 1, (3 * len(counts)) // 4)]
        k = max(1, min(max_speakers, p75_count))
    else:
        k = max(1, min(max_speakers, len(flat_boxes)))

    if k == 1 or len(flat_boxes) == 1:
        b0 = flat_boxes[0]
        return {
            "SPEAKER_00": SpeakerFaceBox("SPEAKER_00", b0.x, b0.y, b0.w, b0.h),
        }

    centers = [(b.x + b.w / 2.0, b.y + b.h / 2.0) for b in flat_boxes]
    # Sort points by (row_band, cx) so 2x2 grids and horizontal roundtables both initialise cleanly
    ordered_indices = sorted(
        range(len(centers)),
        key=lambda idx: (round(centers[idx][1] * 2.0), centers[idx][0]),
    )
    centroids: list[tuple[float, float]] = []
    for c_idx in range(k):
        pick = ordered_indices[min(len(ordered_indices) - 1, int(round(c_idx * (len(ordered_indices) - 1) / max(1, k - 1))))]
        centroids.append(centers[pick])

    assignments = [0] * len(flat_boxes)
    for _ in range(30):
        new_assignments: list[int] = []
        for cx, cy in centers:
            best_cluster = min(
                range(k),
                key=lambda c: math.hypot(cx - centroids[c][0], 0.65 * (cy - centroids[c][1])),
            )
            new_assignments.append(best_cluster)
        assignments = new_assignments

        next_centroids: list[tuple[float, float]] = []
        max_shift = 0.0
        for c in range(k):
            pts = [centers[i] for i, a in enumerate(assignments) if a == c]
            if pts:
                nx = sum(p[0] for p in pts) / len(pts)
                ny = sum(p[1] for p in pts) / len(pts)
                max_shift = max(max_shift, math.hypot(nx - centroids[c][0], ny - centroids[c][1]))
                next_centroids.append((nx, ny))
            else:
                next_centroids.append(centroids[c])
        centroids = next_centroids
        if max_shift < 1e-5:
            break

    cluster_boxes: list[tuple[float, float, FaceBox]] = []
    for c in range(k):
        group = [flat_boxes[i] for i, a in enumerate(assignments) if a == c]
        if not group:
            continue
        med_cx = _median_float([b.x + b.w / 2.0 for b in group])
        med_cy = _median_float([b.y + b.h / 2.0 for b in group])
        med_w = _median_float([b.w for b in group], 0.14)
        med_h = _median_float([b.h for b in group], 0.22)
        box = FaceBox(
            x=min(1.0, max(0.0, med_cx - med_w / 2.0)),
            y=min(1.0, max(0.0, med_cy - med_h / 2.0)),
            w=min(1.0, max(0.02, med_w)),
            h=min(1.0, max(MIN_FACE_HEIGHT, med_h)),
            score=0.95,
        )
        cluster_boxes.append((med_cx, med_cy, box))

    # Order speakers left-to-right (or top-row then bottom-row when vertically separated > 0.28)
    ys = [cy for _, cy, _ in cluster_boxes]
    is_two_row_grid = len(cluster_boxes) >= 3 and (max(ys) - min(ys)) > 0.28
    if is_two_row_grid:
        mid_y = 0.5 * (max(ys) + min(ys))
        cluster_boxes.sort(key=lambda item: (0 if item[1] <= mid_y else 1, item[0]))
    else:
        cluster_boxes.sort(key=lambda item: item[0])

    result: dict[str, SpeakerFaceBox] = {}
    for idx, (_, _, box) in enumerate(cluster_boxes):
        sp_id = f"SPEAKER_{idx:02d}"
        result[sp_id] = SpeakerFaceBox(
            speaker_id=sp_id,
            x=box.x,
            y=box.y,
            width=box.w,
            height=box.h,
        )
    return result


def normalise_speaker_boxes(
    face_boxes: Mapping[str, Any] | Sequence[Any] | None,
    *,
    speaker_ids: Sequence[str] = (),
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
) -> dict[str, SpeakerFaceBox]:
    """Normalise caller-supplied speaker face boxes (mapping or sequence, pixel or
    normalised coordinates) into a ``dict[speaker_id, SpeakerFaceBox]``.
    Generates evenly spaced default panelist seats for any speaker missing an
    explicit face box.
    """
    sw = max(1.0, float(source_width))
    sh = max(1.0, float(source_height))
    resolved: dict[str, SpeakerFaceBox] = {}

    def _convert(sp_id: str, raw: Any) -> SpeakerFaceBox | None:
        if isinstance(raw, SpeakerFaceBox):
            return SpeakerFaceBox(sp_id, raw.x, raw.y, raw.width, raw.height)
        if isinstance(raw, FaceBox):
            x, y, w, h = raw.x, raw.y, raw.w, raw.h
        elif isinstance(raw, Mapping):
            if "cropRect" in raw and isinstance(raw["cropRect"], Mapping):
                raw = raw["cropRect"]
            if "w" in raw or "width" in raw:
                x = float(raw.get("x", raw.get("left", 0.0)))
                y = float(raw.get("y", raw.get("top", 0.0)))
                w = float(raw.get("w", raw.get("width", 0.16)))
                h = float(raw.get("h", raw.get("height", 0.24)))
            else:
                cx = float(raw.get("centerX", raw.get("cx", raw.get("x", 0.5))))
                cy = float(raw.get("centerY", raw.get("cy", raw.get("y", 0.4))))
                w = float(raw.get("size", 0.16))
                h = float(raw.get("size", 0.24))
                if cx > 1.5 or cy > 1.5:
                    cx /= sw
                    cy /= sh
                if w > 1.5:
                    w /= sw
                if h > 1.5:
                    h /= sh
                x = max(0.0, cx - w / 2.0)
                y = max(0.0, cy - h / 2.0)
        elif isinstance(raw, Sequence) and len(raw) >= 4:
            x, y, w, h = float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3])
        else:
            return None

        if x > 1.5 or y > 1.5 or w > 1.5 or h > 1.5:
            x /= sw
            y /= sh
            w /= sw
            h /= sh

        return SpeakerFaceBox(
            speaker_id=sp_id,
            x=min(0.95, max(0.0, x)),
            y=min(0.95, max(0.0, y)),
            width=min(1.0, max(0.04, w)),
            height=min(1.0, max(0.06, h)),
        )

    if isinstance(face_boxes, Mapping):
        for raw_id, raw_box in face_boxes.items():
            sp_id = str(raw_id)
            box = _convert(sp_id, raw_box)
            if box is not None:
                resolved[sp_id] = box
    elif isinstance(face_boxes, Sequence) and face_boxes:
        if isinstance(face_boxes[0], FaceSample):
            resolved = cluster_multispeaker_faces(
                face_boxes,
                num_speakers=max(len(speaker_ids), 3) if speaker_ids else None,
                source_width=source_width,
                source_height=source_height,
            )
        else:
            for idx, item in enumerate(face_boxes):
                if isinstance(item, Mapping) and ("speakerId" in item or "speaker_id" in item or "id" in item):
                    sp_id = str(item.get("speakerId", item.get("speaker_id", item.get("id"))))
                elif idx < len(speaker_ids):
                    sp_id = speaker_ids[idx]
                else:
                    sp_id = f"SPEAKER_{idx:02d}"
                box = _convert(sp_id, item)
                if box is not None:
                    resolved[sp_id] = box

    all_ids = list(dict.fromkeys([*resolved.keys(), *speaker_ids]))
    if not all_ids:
        all_ids = ["SPEAKER_00"]

    # Remap clustered SPEAKER_00..N to actual diarization speaker IDs if keys differed
    if resolved and speaker_ids and not any(sp in resolved for sp in speaker_ids):
        clustered_boxes = list(resolved.values())
        resolved = {}
        for idx, sp_id in enumerate(speaker_ids):
            src_box = clustered_boxes[idx % len(clustered_boxes)]
            resolved[sp_id] = SpeakerFaceBox(
                speaker_id=sp_id,
                x=src_box.x,
                y=src_box.y,
                width=src_box.width,
                height=src_box.height,
            )

    total = max(1, len(all_ids))
    for idx, sp_id in enumerate(all_ids):
        if sp_id not in resolved:
            cx = (idx + 0.5) / total
            w = min(0.22, 0.80 / total)
            h = 0.26
            resolved[sp_id] = SpeakerFaceBox(
                speaker_id=sp_id,
                x=max(0.0, min(1.0 - w, cx - w / 2.0)),
                y=0.24,
                width=w,
                height=h,
            )

    return resolved


# ---------------------------------------------------------------------------
# False Switch Rejection & Lead-In / Lead-Out Audio Padding
# ---------------------------------------------------------------------------


def filter_non_dialogue_vocalizations(
    turns: Sequence[DiarizedTurn],
    *,
    max_vocalization_sec: float = FALSE_SWITCH_MAX_DURATION_SEC,
) -> tuple[list[DiarizedTurn], list[DiarizedTurn]]:
    """Reject brief non-dialogue vocalizations (< 1.2s coughs, throat clears, or
    affirmative grunts like *"yeah"*, *"uh-huh"*) from triggering camera cuts.

    Returns ``(kept_turns, rejected_turns)``.
    """
    if not turns:
        return [], []

    kept: list[DiarizedTurn] = []
    rejected: list[DiarizedTurn] = []

    # Check whether the clip has substantive dialogue turns (>= max_vocalization_sec)
    has_substantive_dialogue = any(
        t.duration_sec >= max_vocalization_sec or t.is_reaction for t in turns
    )

    for idx, turn in enumerate(turns):
        if turn.is_reaction:
            kept.append(turn)
            continue

        if turn.is_vocal_noise and turn.duration_sec < max(2.0, max_vocalization_sec):
            rejected.append(turn)
            continue

        if turn.duration_sec < max_vocalization_sec and has_substantive_dialogue:
            # Check if this short turn is part of a same-speaker broken phrase
            # (within 0.4s of another turn by the SAME speaker)
            same_speaker_adjacent = any(
                other_idx != idx
                and other.speaker_id == turn.speaker_id
                and other.duration_sec >= max_vocalization_sec
                and (
                    abs(turn.start_sec - other.end_sec) <= 0.4
                    or abs(other.start_sec - turn.end_sec) <= 0.4
                )
                for other_idx, other in enumerate(turns)
            )
            if same_speaker_adjacent:
                kept.append(turn)
            else:
                rejected.append(turn)
            continue

        kept.append(turn)

    if not kept and turns:
        # Fallback if every turn in a micro-clip was under threshold: keep the longest turn
        longest = max(turns, key=lambda t: t.duration_sec)
        kept.append(longest)
        rejected = [t for t in turns if t is not longest]

    return kept, rejected


def apply_lead_padding(
    turns: Sequence[DiarizedTurn],
    *,
    lead_in_sec: float = LEAD_IN_PADDING_SEC,
    lead_out_sec: float = LEAD_OUT_PADDING_SEC,
    clip_start_sec: float = 0.0,
    clip_end_sec: float | None = None,
) -> list[DiarizedTurn]:
    """Apply AutoCut lead-in (250ms before first spoken word) and lead-out (350ms
    after last spoken word) padding to speech intervals.
    """
    if not turns:
        return []

    max_end = (
        float(clip_end_sec)
        if clip_end_sec is not None
        else max(t.end_sec for t in turns) + lead_out_sec
    )
    padded: list[DiarizedTurn] = []
    for turn in turns:
        new_start = max(float(clip_start_sec), turn.start_sec - float(lead_in_sec))
        new_end = min(max_end, turn.end_sec + float(lead_out_sec))
        if new_end > new_start:
            padded.append(
                DiarizedTurn(
                    speaker_id=turn.speaker_id,
                    start_sec=round(new_start, 4),
                    end_sec=round(new_end, 4),
                    is_reaction=turn.is_reaction,
                    is_vocal_noise=turn.is_vocal_noise,
                    text=turn.text,
                )
            )
    return padded


# ---------------------------------------------------------------------------
# Pane Geometry & Multi-Tile Crop Calculation
# ---------------------------------------------------------------------------


def compute_crop_rect_for_pane(
    speaker_box: SpeakerFaceBox,
    canvas_position: Mapping[str, int],
    *,
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
) -> dict[str, int]:
    """Compute an aspect-matched source crop rectangle ``{x, y, width, height}``
    centered on ``speaker_box`` so that scaling into ``canvas_position`` is
    100% distortion-free.
    """
    sw = max(2, int(source_width))
    sh = max(2, int(source_height))
    pane_w = max(2, int(canvas_position["width"]))
    pane_h = max(2, int(canvas_position["height"]))
    pane_ratio = pane_w / float(pane_h)

    face_cx_px = speaker_box.center_x * sw
    face_cy_px = speaker_box.center_y * sh
    face_h_px = max(sh * 0.08, speaker_box.height * sh)

    # Target head-and-shoulders framing: face occupies ~24-28% of pane height
    wanted_h = max(sh * 0.48, min(float(sh), face_h_px / 0.25))
    max_h_by_width = sw / pane_ratio
    crop_h = _floor_even(min(float(sh), max_h_by_width, wanted_h))
    crop_w = _round_even(crop_h * pane_ratio)
    if crop_w > sw:
        crop_w = _floor_even(sw)
        crop_h = _floor_even(crop_w / pane_ratio)

    raw_x = int(round(face_cx_px - crop_w / 2.0))
    clamped_x = min(max(0, raw_x), max(0, sw - crop_w))
    # Position face center near the upper third (0.36) of the crop window for natural headroom
    raw_y = int(round(face_cy_px - crop_h * 0.36))
    clamped_y = min(max(0, raw_y), max(0, sh - crop_h))

    return {
        "x": (clamped_x // 2) * 2,
        "y": (clamped_y // 2) * 2,
        "width": max(2, crop_w),
        "height": max(2, crop_h),
    }


def compute_pane_assignments(
    layout_type: str,
    active_speaker_id: str,
    speaker_boxes: Mapping[str, SpeakerFaceBox],
    *,
    panel_order: Sequence[str] | None = None,
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
    canvas_width: int = DEFAULT_CANVAS_WIDTH,
    canvas_height: int = DEFAULT_CANVAS_HEIGHT,
) -> list[LayoutPaneAssignment]:
    """Compute ``paneAssignments`` for ``SOLO``, ``SPLIT_2``, ``TRI_PANEL``, or
    ``GRID_4`` inside a ``canvas_width × canvas_height`` (1080 × 1920) frame.
    """
    cw = max(2, int(canvas_width))
    ch = max(2, int(canvas_height))
    ordered_ids = list(panel_order) if panel_order else list(speaker_boxes.keys())
    if not ordered_ids:
        ordered_ids = [active_speaker_id]

    def _box_for(sp_id: str) -> SpeakerFaceBox:
        if sp_id in speaker_boxes:
            return speaker_boxes[sp_id]
        first_key = next(iter(speaker_boxes))
        return speaker_boxes[first_key]

    if layout_type == LAYOUT_SOLO:
        canvas_pos = {"x": 0, "y": 0, "width": cw, "height": ch}
        crop = compute_crop_rect_for_pane(
            _box_for(active_speaker_id),
            canvas_pos,
            source_width=source_width,
            source_height=source_height,
        )
        return [
            LayoutPaneAssignment(
                speaker_id=active_speaker_id,
                crop_rect=crop,
                canvas_position=canvas_pos,
            )
        ]

    if layout_type == LAYOUT_SPLIT_2:
        half_h = _floor_even(ch / 2.0)
        other_ids = [sp for sp in ordered_ids if sp != active_speaker_id]
        second_id = other_ids[0] if other_ids else active_speaker_id
        # Keep consistent top/bottom seat order based on panel_order
        pair = [sp for sp in ordered_ids if sp in (active_speaker_id, second_id)]
        if len(pair) < 2:
            pair = [active_speaker_id, second_id]
        top_pos = {"x": 0, "y": 0, "width": cw, "height": half_h}
        bot_pos = {"x": 0, "y": half_h, "width": cw, "height": ch - half_h}
        return [
            LayoutPaneAssignment(
                speaker_id=pair[0],
                crop_rect=compute_crop_rect_for_pane(
                    _box_for(pair[0]),
                    top_pos,
                    source_width=source_width,
                    source_height=source_height,
                ),
                canvas_position=top_pos,
            ),
            LayoutPaneAssignment(
                speaker_id=pair[1],
                crop_rect=compute_crop_rect_for_pane(
                    _box_for(pair[1]),
                    bot_pos,
                    source_width=source_width,
                    source_height=source_height,
                ),
                canvas_position=bot_pos,
            ),
        ]

    if layout_type == LAYOUT_TRI_PANEL:
        # Active Speaker in Top 60% (1080 × 1152), Two Panelists in Bottom 40% (540 × 768 each)
        top_h = _round_even(ch * 0.60)  # 1152 for 1920
        bot_h = ch - top_h  # 768 for 1920
        half_w = _floor_even(cw / 2.0)  # 540 for 1080
        other_ids = [sp for sp in ordered_ids if sp != active_speaker_id]
        while len(other_ids) < 2:
            other_ids.append(ordered_ids[len(other_ids) % len(ordered_ids)])
        p1_id, p2_id = other_ids[0], other_ids[1]

        top_pos = {"x": 0, "y": 0, "width": cw, "height": top_h}
        bl_pos = {"x": 0, "y": top_h, "width": half_w, "height": bot_h}
        br_pos = {"x": half_w, "y": top_h, "width": cw - half_w, "height": bot_h}

        return [
            LayoutPaneAssignment(
                speaker_id=active_speaker_id,
                crop_rect=compute_crop_rect_for_pane(
                    _box_for(active_speaker_id),
                    top_pos,
                    source_width=source_width,
                    source_height=source_height,
                ),
                canvas_position=top_pos,
            ),
            LayoutPaneAssignment(
                speaker_id=p1_id,
                crop_rect=compute_crop_rect_for_pane(
                    _box_for(p1_id),
                    bl_pos,
                    source_width=source_width,
                    source_height=source_height,
                ),
                canvas_position=bl_pos,
            ),
            LayoutPaneAssignment(
                speaker_id=p2_id,
                crop_rect=compute_crop_rect_for_pane(
                    _box_for(p2_id),
                    br_pos,
                    source_width=source_width,
                    source_height=source_height,
                ),
                canvas_position=br_pos,
            ),
        ]

    # LAYOUT_GRID_4: 2×2 Grid (four 540 × 960 tiles)
    half_w = _floor_even(cw / 2.0)
    half_h = _floor_even(ch / 2.0)
    grid_ids = list(ordered_ids[:4])
    if active_speaker_id not in grid_ids and grid_ids:
        grid_ids[0] = active_speaker_id
    while len(grid_ids) < 4:
        grid_ids.append(ordered_ids[len(grid_ids) % len(ordered_ids)])

    positions = [
        {"x": 0, "y": 0, "width": half_w, "height": half_h},
        {"x": half_w, "y": 0, "width": cw - half_w, "height": half_h},
        {"x": 0, "y": half_h, "width": half_w, "height": ch - half_h},
        {"x": half_w, "y": half_h, "width": cw - half_w, "height": ch - half_h},
    ]
    return [
        LayoutPaneAssignment(
            speaker_id=grid_ids[i],
            crop_rect=compute_crop_rect_for_pane(
                _box_for(grid_ids[i]),
                positions[i],
                source_width=source_width,
                source_height=source_height,
            ),
            canvas_position=positions[i],
        )
        for i in range(4)
    ]


# ---------------------------------------------------------------------------
# Director State Machine & Minimum Shot Duration Hysteresis
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _RawShot:
    start_sec: float
    end_sec: float
    layout_type: str
    active_speaker_id: str

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)


def _select_grid_layout(
    total_speakers: int,
    active_in_window: int,
    preferred_grid: str | None = None,
) -> str:
    if preferred_grid in (LAYOUT_TRI_PANEL, LAYOUT_GRID_4, LAYOUT_SPLIT_2):
        return preferred_grid
    if total_speakers <= 2:
        return LAYOUT_SPLIT_2
    if total_speakers >= 4 and active_in_window >= 4:
        return LAYOUT_GRID_4
    return LAYOUT_TRI_PANEL


def enforce_minimum_shot_duration(
    raw_shots: Sequence[_RawShot],
    *,
    min_shot_duration_sec: float = MIN_SHOT_DURATION_SEC,
    total_speakers: int = 3,
    preferred_grid: str | None = None,
) -> list[_RawShot]:
    """Enforce Minimum Shot Duration (MSD) hysteresis (``delta_t >= 2.0s`` / 60 frames)
    so no camera cut in the output EDL is shorter than ``min_shot_duration_sec``.
    """
    if not raw_shots:
        return []

    shots = [
        _RawShot(
            start_sec=s.start_sec,
            end_sec=s.end_sec,
            layout_type=s.layout_type,
            active_speaker_id=s.active_speaker_id,
        )
        for s in raw_shots
        if s.end_sec > s.start_sec + 1e-6
    ]
    if not shots:
        return []

    # 1. Merge consecutive identical (layout_type, active_speaker_id) shots
    merged: list[_RawShot] = [shots[0]]
    for shot in shots[1:]:
        prev = merged[-1]
        if (
            prev.layout_type == shot.layout_type
            and prev.active_speaker_id == shot.active_speaker_id
        ):
            prev.end_sec = shot.end_sec
        else:
            merged.append(shot)

    # 2. Coalesce consecutive short SOLO turns (< min_shot_duration_sec) from different
    # speakers into a multi-speaker grid shot (TRI_PANEL / GRID_4 / SPLIT_2)
    coalesced: list[_RawShot] = []
    i = 0
    while i < len(merged):
        curr = merged[i]
        if curr.duration_sec < min_shot_duration_sec:
            run_end = i
            speakers_in_run = {curr.active_speaker_id}
            total_dur = curr.duration_sec
            while run_end + 1 < len(merged) and (
                merged[run_end + 1].duration_sec < min_shot_duration_sec
                or total_dur < min_shot_duration_sec
            ):
                # Stop coalescing if the next shot is already a long SOLO monologue (>= 3.5s)
                # and we already have a previous shot we can merge into
                if (
                    merged[run_end + 1].duration_sec >= 3.5
                    and merged[run_end + 1].layout_type == LAYOUT_SOLO
                    and coalesced
                ):
                    break
                run_end += 1
                speakers_in_run.add(merged[run_end].active_speaker_id)
                total_dur += merged[run_end].duration_sec
                if total_dur >= min_shot_duration_sec and (
                    run_end + 1 >= len(merged)
                    or merged[run_end + 1].duration_sec >= min_shot_duration_sec
                ):
                    break

            if run_end > i and len(speakers_in_run) >= 2:
                grid_type = _select_grid_layout(
                    total_speakers, len(speakers_in_run), preferred_grid
                )
                coalesced.append(
                    _RawShot(
                        start_sec=curr.start_sec,
                        end_sec=merged[run_end].end_sec,
                        layout_type=grid_type,
                        active_speaker_id=curr.active_speaker_id,
                    )
                )
                i = run_end + 1
                continue
        coalesced.append(curr)
        i += 1

    # 3. Hysteresis absorption pass: absorb any remaining shot < min_shot_duration_sec
    # into its neighbor so every cut is strictly >= min_shot_duration_sec
    changed = True
    while changed and len(coalesced) > 1:
        changed = False
        for idx, shot in enumerate(coalesced):
            if shot.duration_sec + 1e-6 < min_shot_duration_sec:
                if idx > 0:
                    # Hold the previous camera angle across this brief segment
                    coalesced[idx - 1].end_sec = shot.end_sec
                    coalesced.pop(idx)
                else:
                    # First segment is too short: extend the second segment back to start_sec
                    coalesced[1].start_sec = shot.start_sec
                    coalesced.pop(0)
                changed = True
                break

        # Re-merge any newly adjacent identical shots
        deduped: list[_RawShot] = [coalesced[0]]
        for s in coalesced[1:]:
            if (
                deduped[-1].layout_type == s.layout_type
                and deduped[-1].active_speaker_id == s.active_speaker_id
            ):
                deduped[-1].end_sec = s.end_sec
            else:
                deduped.append(s)
        coalesced = deduped

    return coalesced


def generate_director_edl(
    diarization_turns: Sequence[Any],
    face_boxes: Mapping[str, Any] | Sequence[Any] | None = None,
    *,
    clip_start_sec: float = 0.0,
    clip_duration_sec: float | None = None,
    min_shot_duration_sec: float = MIN_SHOT_DURATION_SEC,
    false_switch_max_sec: float = FALSE_SWITCH_MAX_DURATION_SEC,
    lead_in_sec: float = LEAD_IN_PADDING_SEC,
    lead_out_sec: float = LEAD_OUT_PADDING_SEC,
    monologue_threshold_sec: float = SOLO_MONOLOGUE_THRESHOLD_SEC,
    rapid_turnaround_sec: float = RAPID_TURNAROUND_THRESHOLD_SEC,
    preferred_grid_layout: str | None = None,
    overrides: Sequence[Mapping[str, Any]] | None = None,
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
    canvas_width: int = DEFAULT_CANVAS_WIDTH,
    canvas_height: int = DEFAULT_CANVAS_HEIGHT,
) -> list[LayoutCut]:
    """Run the Automated Multi-Cam Director State Machine to produce a timed
    ``LayoutCut[]`` Edit Decision List covering ``[clip_start_sec, clip_end_sec]``.
    """
    raw_turns = normalise_diarization_turns(diarization_turns)
    kept_turns, _ = filter_non_dialogue_vocalizations(
        raw_turns,
        max_vocalization_sec=false_switch_max_sec,
    )

    speaker_ids_from_turns = [
        t.speaker_id
        for t in (kept_turns or raw_turns)
        if t.speaker_id.upper() not in ("GROUP", "ALL", "LAUGHTER", "REACTION")
    ]
    unique_turn_speakers = list(dict.fromkeys(speaker_ids_from_turns))

    speaker_boxes = normalise_speaker_boxes(
        face_boxes,
        speaker_ids=unique_turn_speakers,
        source_width=source_width,
        source_height=source_height,
    )
    panel_order = list(speaker_boxes.keys())
    total_speakers = len(panel_order)
    default_speaker = unique_turn_speakers[0] if unique_turn_speakers else panel_order[0]

    start_bound = max(0.0, float(clip_start_sec))
    if clip_duration_sec is not None and clip_duration_sec > 0:
        end_bound = start_bound + float(clip_duration_sec)
    elif kept_turns:
        end_bound = max(t.end_sec for t in kept_turns)
    elif raw_turns:
        end_bound = max(t.end_sec for t in raw_turns)
    else:
        end_bound = start_bound + max(min_shot_duration_sec, 5.0)

    if not kept_turns:
        return [
            LayoutCut(
                start_sec=start_bound,
                end_sec=end_bound,
                layout_type=LAYOUT_SOLO,
                active_speaker_id=default_speaker,
                pane_assignments=compute_pane_assignments(
                    LAYOUT_SOLO,
                    default_speaker,
                    speaker_boxes,
                    panel_order=panel_order,
                    source_width=source_width,
                    source_height=source_height,
                    canvas_width=canvas_width,
                    canvas_height=canvas_height,
                ),
            )
        ]

    # Merge consecutive turns of the same non-reaction speaker separated by short pauses (<= 0.6s)
    consolidated: list[DiarizedTurn] = []
    for turn in kept_turns:
        if (
            consolidated
            and not turn.is_reaction
            and not consolidated[-1].is_reaction
            and consolidated[-1].speaker_id == turn.speaker_id
            and (turn.start_sec - consolidated[-1].end_sec) <= 0.6
        ):
            prev = consolidated[-1]
            consolidated[-1] = DiarizedTurn(
                speaker_id=prev.speaker_id,
                start_sec=prev.start_sec,
                end_sec=max(prev.end_sec, turn.end_sec),
                is_reaction=False,
                text=f"{prev.text} {turn.text}".strip(),
            )
        else:
            consolidated.append(turn)

    # Apply 250ms lead-in and 350ms lead-out padding
    padded = apply_lead_padding(
        consolidated,
        lead_in_sec=lead_in_sec,
        lead_out_sec=lead_out_sec,
        clip_start_sec=start_bound,
        clip_end_sec=end_bound,
    )

    # Classify each turn and detect overlapping speech / rapid dialogue turnarounds
    raw_shots: list[_RawShot] = []
    idx = 0
    while idx < len(padded):
        curr = padded[idx]

        # Check for simultaneous overlapping speech or group reaction/laughter
        overlapping_group = [curr]
        next_idx = idx + 1
        while next_idx < len(padded):
            nxt = padded[next_idx]
            overlap_sec = min(curr.end_sec, nxt.end_sec) - max(curr.start_sec, nxt.start_sec)
            is_rapid_pair = (
                nxt.speaker_id != overlapping_group[-1].speaker_id
                and (
                    curr.duration_sec < rapid_turnaround_sec
                    or nxt.duration_sec < rapid_turnaround_sec
                )
                and (nxt.start_sec - overlapping_group[-1].end_sec) <= 0.8
            )
            if nxt.is_reaction or curr.is_reaction or overlap_sec >= 0.45 or is_rapid_pair:
                overlapping_group.append(nxt)
                next_idx += 1
            else:
                break

        if len(overlapping_group) >= 2 or curr.is_reaction:
            group_start = min(t.start_sec for t in overlapping_group)
            group_end = max(t.end_sec for t in overlapping_group)
            distinct_sp = list(
                dict.fromkeys(
                    t.speaker_id
                    for t in overlapping_group
                    if t.speaker_id in speaker_boxes
                )
            )
            primary_sp = distinct_sp[0] if distinct_sp else default_speaker
            active_count = max(len(distinct_sp), 3 if curr.is_reaction else len(distinct_sp))
            grid_layout = _select_grid_layout(
                total_speakers,
                active_count,
                preferred_grid_layout,
            )
            raw_shots.append(
                _RawShot(
                    start_sec=group_start,
                    end_sec=group_end,
                    layout_type=grid_layout,
                    active_speaker_id=primary_sp,
                )
            )
            idx = next_idx
            continue

        # Single speaker turn: STATE_SOLO for monologues (>= monologue_threshold_sec or isolated turn)
        active_sp = curr.speaker_id if curr.speaker_id in speaker_boxes else default_speaker
        layout = (
            LAYOUT_SOLO
            if curr.duration_sec >= min(monologue_threshold_sec, min_shot_duration_sec)
            or total_speakers == 1
            else _select_grid_layout(total_speakers, total_speakers, preferred_grid_layout)
        )
        raw_shots.append(
            _RawShot(
                start_sec=curr.start_sec,
                end_sec=curr.end_sec,
                layout_type=layout,
                active_speaker_id=active_sp,
            )
        )
        idx += 1

    # Make the shot timeline contiguous across [start_bound, end_bound]
    if raw_shots:
        raw_shots[0].start_sec = start_bound
        for i in range(len(raw_shots) - 1):
            curr_shot = raw_shots[i]
            next_shot = raw_shots[i + 1]
            if curr_shot.end_sec != next_shot.start_sec:
                # Boundary sits at the incoming shot's lead-in start (clamped so curr_shot stays valid)
                boundary = max(curr_shot.start_sec, min(end_bound, next_shot.start_sec))
                curr_shot.end_sec = boundary
                next_shot.start_sec = boundary
        raw_shots[-1].end_sec = max(raw_shots[-1].start_sec + 0.1, end_bound)

    # Enforce Minimum Shot Duration (MSD >= 2.0s) hysteresis
    enforced_shots = enforce_minimum_shot_duration(
        raw_shots,
        min_shot_duration_sec=min_shot_duration_sec,
        total_speakers=total_speakers,
        preferred_grid=preferred_grid_layout,
    )

    cuts: list[LayoutCut] = []
    for shot in enforced_shots:
        panes = compute_pane_assignments(
            shot.layout_type,
            shot.active_speaker_id,
            speaker_boxes,
            panel_order=panel_order,
            source_width=source_width,
            source_height=source_height,
            canvas_width=canvas_width,
            canvas_height=canvas_height,
        )
        cuts.append(
            LayoutCut(
                start_sec=shot.start_sec,
                end_sec=shot.end_sec,
                layout_type=shot.layout_type,
                active_speaker_id=shot.active_speaker_id,
                pane_assignments=panes,
            )
        )

    if overrides:
        for ov in overrides:
            cuts = apply_layout_override(
                cuts,
                timestamp_sec=float(ov.get("timestampSec", ov.get("timestamp_sec", 0.0))),
                layout_type=str(ov.get("layoutType", ov.get("layout_type", LAYOUT_TRI_PANEL))),
                active_speaker_id=ov.get("activeSpeakerId", ov.get("active_speaker_id")),
                speaker_boxes=speaker_boxes,
                panel_order=panel_order,
                source_width=source_width,
                source_height=source_height,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
            )

    return cuts


def apply_layout_override(
    cuts: Sequence[LayoutCut],
    *,
    timestamp_sec: float,
    layout_type: str,
    active_speaker_id: str | None = None,
    speaker_boxes: Mapping[str, SpeakerFaceBox] | None = None,
    panel_order: Sequence[str] | None = None,
    source_width: int = DEFAULT_SOURCE_WIDTH,
    source_height: int = DEFAULT_SOURCE_HEIGHT,
    canvas_width: int = DEFAULT_CANVAS_WIDTH,
    canvas_height: int = DEFAULT_CANVAS_HEIGHT,
) -> list[LayoutCut]:
    """Override the layout type (e.g. toggling between ``SOLO`` and ``TRI_PANEL`` /
    ``GRID_4``) for the cut containing ``timestamp_sec``.
    """
    if not cuts:
        return []

    inferred_boxes: dict[str, SpeakerFaceBox] = dict(speaker_boxes) if speaker_boxes else {}
    if not inferred_boxes:
        for cut in cuts:
            for pane in cut.pane_assignments:
                cr = pane.crop_rect
                inferred_boxes.setdefault(
                    pane.speaker_id,
                    SpeakerFaceBox(
                        speaker_id=pane.speaker_id,
                        x=cr["x"] / max(1.0, float(source_width)),
                        y=cr["y"] / max(1.0, float(source_height)),
                        width=cr["width"] / max(1.0, float(source_width)),
                        height=cr["height"] / max(1.0, float(source_height)),
                    ),
                )

    order = list(panel_order) if panel_order else list(inferred_boxes.keys())
    updated: list[LayoutCut] = []
    matched = False
    for cut in cuts:
        in_cut = (cut.start_sec <= timestamp_sec <= cut.end_sec) and not matched
        if in_cut:
            matched = True
            target_sp = active_speaker_id or cut.active_speaker_id
            panes = compute_pane_assignments(
                layout_type,
                target_sp,
                inferred_boxes,
                panel_order=order,
                source_width=source_width,
                source_height=source_height,
                canvas_width=canvas_width,
                canvas_height=canvas_height,
            )
            updated.append(
                LayoutCut(
                    start_sec=cut.start_sec,
                    end_sec=cut.end_sec,
                    layout_type=layout_type,
                    active_speaker_id=target_sp,
                    pane_assignments=panes,
                )
            )
        else:
            updated.append(cut)
    return updated


class DirectorStateMachine:
    """Stateful/configurable Automated Multi-Cam Director Engine for 3+ speaker
    podcasts, panel discussions, and roundtable debates (Pillar 3 §03).
    """

    def __init__(
        self,
        *,
        min_shot_duration_sec: float = MIN_SHOT_DURATION_SEC,
        false_switch_max_sec: float = FALSE_SWITCH_MAX_DURATION_SEC,
        lead_in_sec: float = LEAD_IN_PADDING_SEC,
        lead_out_sec: float = LEAD_OUT_PADDING_SEC,
        monologue_threshold_sec: float = SOLO_MONOLOGUE_THRESHOLD_SEC,
        rapid_turnaround_sec: float = RAPID_TURNAROUND_THRESHOLD_SEC,
        preferred_grid_layout: str | None = None,
        source_width: int = DEFAULT_SOURCE_WIDTH,
        source_height: int = DEFAULT_SOURCE_HEIGHT,
        canvas_width: int = DEFAULT_CANVAS_WIDTH,
        canvas_height: int = DEFAULT_CANVAS_HEIGHT,
    ) -> None:
        self.min_shot_duration_sec = float(min_shot_duration_sec)
        self.false_switch_max_sec = float(false_switch_max_sec)
        self.lead_in_sec = float(lead_in_sec)
        self.lead_out_sec = float(lead_out_sec)
        self.monologue_threshold_sec = float(monologue_threshold_sec)
        self.rapid_turnaround_sec = float(rapid_turnaround_sec)
        self.preferred_grid_layout = preferred_grid_layout
        self.source_width = int(source_width)
        self.source_height = int(source_height)
        self.canvas_width = int(canvas_width)
        self.canvas_height = int(canvas_height)

    def plan_edl(
        self,
        diarization_turns: Sequence[Any],
        face_boxes: Mapping[str, Any] | Sequence[Any] | None = None,
        *,
        clip_start_sec: float = 0.0,
        clip_duration_sec: float | None = None,
        overrides: Sequence[Mapping[str, Any]] | None = None,
    ) -> list[LayoutCut]:
        return generate_director_edl(
            diarization_turns,
            face_boxes,
            clip_start_sec=clip_start_sec,
            clip_duration_sec=clip_duration_sec,
            min_shot_duration_sec=self.min_shot_duration_sec,
            false_switch_max_sec=self.false_switch_max_sec,
            lead_in_sec=self.lead_in_sec,
            lead_out_sec=self.lead_out_sec,
            monologue_threshold_sec=self.monologue_threshold_sec,
            rapid_turnaround_sec=self.rapid_turnaround_sec,
            preferred_grid_layout=self.preferred_grid_layout,
            overrides=overrides,
            source_width=self.source_width,
            source_height=self.source_height,
            canvas_width=self.canvas_width,
            canvas_height=self.canvas_height,
        )

    generate_edl = plan_edl
    run = plan_edl


plan_multispeaker_edl = generate_director_edl
build_layout_edl = generate_director_edl


async def process_director(context: JobContext) -> ProcessorOutcome:
    """Queue processor entrypoint for ``ai.director`` / multi-speaker layout EDL
    generation.
    """
    payload = context.envelope.payload
    turns = payload.get("turns", payload.get("diarizationTurns", []))
    face_boxes = payload.get("faceBoxes", payload.get("speakerBoxes", {}))
    clip_start_sec = float(payload.get("clipStartSec", 0.0))
    clip_duration_sec_raw = payload.get("clipDurationSec")
    clip_duration_sec = (
        float(clip_duration_sec_raw) if clip_duration_sec_raw is not None else None
    )
    min_shot_duration_sec = float(
        payload.get("minShotDurationSec", MIN_SHOT_DURATION_SEC)
    )
    overrides = payload.get("overrides")

    await context.progress(20, message="planning multi-speaker camera cuts")
    edl = generate_director_edl(
        turns if isinstance(turns, Sequence) else [],
        face_boxes if isinstance(face_boxes, (Mapping, Sequence)) else None,
        clip_start_sec=clip_start_sec,
        clip_duration_sec=clip_duration_sec,
        min_shot_duration_sec=min_shot_duration_sec,
        overrides=overrides if isinstance(overrides, Sequence) else None,
    )

    _log.info(
        "director edl complete",
        extra={
            **context.envelope.log_fields(),
            "cuts": len(edl),
        },
    )
    total_sec = edl[-1].end_sec - edl[0].start_sec if edl else (clip_duration_sec or 0.0)
    return ProcessorOutcome(
        result={
            "cuts": [dict(cut) for cut in edl],
            "minShotDurationSec": min_shot_duration_sec,
        },
        usage=JobUsage(
            media_seconds=max(0.0, total_sec),
            provider="worker-ai/director",
            cost_minor=0,
            actual_tenths=0,
        ),
    )
