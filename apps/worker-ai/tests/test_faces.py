"""`ai.faces`: YuNet decoding, suppression, and the `faces.json` shape."""

from __future__ import annotations

import json
import math
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from numpy.typing import NDArray

from worker_ai.passes import faces as faces_module
from worker_ai.passes.faces import (
    FACE_TRACK_VERSION,
    MAX_FACES_PER_SAMPLE,
    FaceBox,
    FaceSample,
    YuNetOnnxDetector,
    decode_yunet,
    detect_face_track,
    face_track_document,
    nms,
)


def _outputs(hit: tuple[int, int, int] | None = None) -> dict[str, np.ndarray]:
    """Empty YuNet outputs, optionally with one confident cell `(stride, row, col)`."""
    outputs: dict[str, np.ndarray] = {}
    for stride in (8, 16, 32):
        cells = (640 // stride) ** 2
        outputs[f"cls_{stride}"] = np.zeros((1, cells, 1), dtype=np.float32)
        outputs[f"obj_{stride}"] = np.zeros((1, cells, 1), dtype=np.float32)
        outputs[f"bbox_{stride}"] = np.zeros((1, cells, 4), dtype=np.float32)
        outputs[f"kps_{stride}"] = np.zeros((1, cells, 10), dtype=np.float32)
    if hit is not None:
        stride, row, col = hit
        index = row * (640 // stride) + col
        outputs[f"cls_{stride}"][0, index, 0] = 0.9
        outputs[f"obj_{stride}"][0, index, 0] = 0.9
        # centre offset (0.5, 0.5) cells, size exp(log 4) = 4 cells
        outputs[f"bbox_{stride}"][0, index] = [0.5, 0.5, math.log(4), math.log(4)]
    return outputs


def test_decodes_one_confident_cell_into_a_box_in_input_pixels() -> None:
    boxes = decode_yunet(_outputs((32, 5, 8)), score_threshold=0.6)
    assert len(boxes) == 1
    x0, y0, x1, y1, score = boxes[0]
    # centre ((8 + 0.5) * 32, (5 + 0.5) * 32) = (272, 176); size 4 * 32 = 128
    assert (x0, y0, x1, y1) == pytest.approx((208, 112, 336, 240))
    assert score == pytest.approx(0.9)


def test_ignores_cells_below_the_threshold() -> None:
    assert decode_yunet(_outputs(), score_threshold=0.6) == []


def test_suppresses_an_overlapping_weaker_box_and_keeps_a_separate_one() -> None:
    strong = (0.0, 0.0, 100.0, 100.0, 0.9)
    overlapping = (10.0, 10.0, 110.0, 110.0, 0.8)
    elsewhere = (300.0, 300.0, 400.0, 400.0, 0.7)
    assert nms([overlapping, elsewhere, strong], 0.3) == [strong, elsewhere]


class _FakeSession:
    """Stands in for onnxruntime: one face in the top-left quarter of the input."""

    class _Io:
        def __init__(self, name: str) -> None:
            self.name = name

    def __init__(self, outputs: dict[str, np.ndarray]) -> None:
        self._outputs = outputs
        self.seen_shape: tuple[int, ...] | None = None

    def get_inputs(self) -> list[_FakeSession._Io]:
        return [self._Io("input")]

    def get_outputs(self) -> list[_FakeSession._Io]:
        return [self._Io(name) for name in self._outputs]

    def run(self, _names: object, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
        self.seen_shape = feeds["input"].shape
        return list(self._outputs.values())


def test_normalises_boxes_to_the_frame_not_the_letterboxed_input() -> None:
    session = _FakeSession(_outputs((32, 5, 8)))
    detector = YuNetOnnxDetector("unused", session=session)
    # A 360 x 640 portrait frame sits in the left 360 px of the 640 x 640 input.
    faces = detector.detect(np.zeros((640, 360, 3), dtype=np.uint8))
    assert session.seen_shape == (1, 3, 640, 640)
    assert len(faces) == 1
    face = faces[0]
    assert face.x == pytest.approx(208 / 360)
    assert face.y == pytest.approx(112 / 640)
    assert face.w == pytest.approx(128 / 360)
    assert face.h == pytest.approx(128 / 640)


def test_the_track_document_keeps_empty_samples_and_rounds_boxes() -> None:
    samples = [
        FaceSample(t_ms=0, boxes=(FaceBox(0.123456, 0.2, 0.3, 0.4, 0.95),)),
        FaceSample(t_ms=250, boxes=()),
    ]
    document = face_track_document(samples, interval_ms=250, source_width=540, source_height=960)
    assert document == {
        "version": FACE_TRACK_VERSION,
        "intervalMs": 250,
        "source": {"width": 540, "height": 960},
        "samples": [[0, [[0.1235, 0.2, 0.3, 0.4]]], [250, []]],
    }


# ---------------------------------------------------------------------------
# A bounded file: the API, the renderer and the browser read all of it
# ---------------------------------------------------------------------------


def _document(*samples: FaceSample) -> dict[str, Any]:
    return face_track_document(list(samples), interval_ms=250, source_width=960, source_height=540)


def _crowd(count: int, *, h: float = 0.05) -> tuple[FaceBox, ...]:
    """`count` faces, each a little wider than the one before, laid out left to right."""
    return tuple(
        FaceBox(x=(n % 40) / 40, y=0.5, w=0.01 + n * 0.0005, h=h, score=0.9) for n in range(count)
    )


def test_faces_too_small_for_any_reader_are_not_written() -> None:
    """Both readers drop faces under 0.06; the floor is half that, for a cover fit's enlargement."""
    tiny = FaceBox(0.1, 0.1, 0.02, 0.029, 0.99)
    floor = FaceBox(0.3, 0.1, 0.02, 0.03, 0.9)
    under_the_readers = FaceBox(0.5, 0.1, 0.03, 0.05, 0.9)

    document = _document(FaceSample(t_ms=0, boxes=(tiny, floor, under_the_readers)))

    assert document["samples"] == [[0, [[0.5, 0.1, 0.03, 0.05], [0.3, 0.1, 0.02, 0.03]]]]


def test_a_crowd_keeps_its_largest_faces_largest_first() -> None:
    """Every NMS survivor used to be written, so a crowd shot set the file's size."""
    crowd = _crowd(60)

    document = _document(FaceSample(t_ms=0, boxes=crowd))

    [[_, written]] = document["samples"]
    assert len(written) == MAX_FACES_PER_SAMPLE
    largest = sorted(crowd, key=lambda box: box.w * box.h, reverse=True)[:MAX_FACES_PER_SAMPLE]
    assert written == [
        [round(box.x, 4), round(box.y, 4), round(box.w, 4), round(box.h, 4)] for box in largest
    ]


def test_a_video_call_gallery_keeps_every_tile() -> None:
    """A 5 x 5 gallery is 25 real faces at about 8% of the frame; none may be cut."""
    gallery = tuple(
        FaceBox(x=col / 5 + 0.06, y=row / 5 + 0.06, w=0.045, h=0.08, score=0.9)
        for row in range(5)
        for col in range(5)
    )

    [[_, written]] = _document(FaceSample(t_ms=0, boxes=gallery))["samples"]

    assert len(written) == 25


#: Coordinates with no zero in any of their first eight decimals, so none is
#: written shorter than the file's precision allows - at four decimals or at
#: any precision a later change might pick. All are at least `MIN_FACE_HEIGHT`.
_WIDEST = (
    0.12345678,
    0.87654321,
    0.23456789,
    0.98765432,
    0.34567891,
    0.65432198,
    0.45678912,
    0.54321987,
)


def _widest_crowd(count: int) -> tuple[FaceBox, ...]:
    """`count` faces as wide as a box can be written: every coordinate at full precision.

    The detector clamps boxes to the frame, so no coordinate is negative or
    past 1, and "0." plus the decimals is the most any of them takes.
    """
    k = len(_WIDEST)
    return tuple(
        FaceBox(
            x=_WIDEST[n % k],
            y=_WIDEST[(n + 1) % k],
            w=_WIDEST[(n + 2) % k],
            h=_WIDEST[(n + 3) % k],
            score=0.9,
        )
        for n in range(count)
    )


def test_a_sample_is_about_a_kilobyte_however_crowded_the_frame() -> None:
    """At four samples a second that is a ceiling near 15 MB an hour, whatever the frame holds.

    Measured on the widest sample the file can hold: every box at full
    precision, and timestamps from the end of a six-hour source. A crowd whose
    coordinates rounded to fewer digits understated the ceiling, and would
    have passed a change that breaks it, like a fifth decimal.
    """
    six_hours_ms = 6 * 3_600_000
    samples = [FaceSample(t_ms=six_hours_ms - n * 250, boxes=_widest_crowd(200)) for n in range(40)]
    # The fixture is the worst case: no coordinate loses a digit to a trailing zero.
    assert {len(json.dumps(round(value, 4))) for value in _WIDEST} == {len("0.1234")}

    body = json.dumps(_document(*samples), separators=(",", ":"))

    assert len(body) / len(samples) < 1_100


class _Crowded(YuNetOnnxDetector):
    """A detector that sees the same crowd in every frame."""

    def __init__(self, faces: tuple[FaceBox, ...]) -> None:
        super().__init__("unused", session=_FakeSession(_outputs()))
        self.faces = faces

    def detect(self, frame: NDArray[np.uint8]) -> list[FaceBox]:
        return list(self.faces)


def test_the_track_is_bounded_as_it_is_read_not_only_when_written(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Six hours of a crowd would otherwise sit in memory until the file is written."""
    frame = np.zeros((360, 640, 3), dtype=np.uint8)

    def frames(_path: Path, *, interval_ms: int) -> Iterator[tuple[int, NDArray[np.uint8]]]:
        yield from ((n * interval_ms, frame) for n in range(3))

    monkeypatch.setattr(faces_module, "iter_bgr_frames", frames)
    speck = FaceBox(0.0, 0.0, 0.01, 0.01, 0.99)

    samples = detect_face_track(Path("unused.mp4"), _Crowded((speck, *_crowd(50))))

    assert [sample.t_ms for sample in samples] == [0, 250, 500]
    for sample in samples:
        assert len(sample.boxes) == MAX_FACES_PER_SAMPLE
        assert speck not in sample.boxes


@pytest.mark.skipif(
    not os.environ.get("YUNET_MODEL_PATH"),
    reason="YUNET_MODEL_PATH not set — no model weights on this machine (H-22)",
)
def test_the_real_model_loads_and_finds_nothing_in_a_blank_frame() -> None:
    detector = YuNetOnnxDetector(os.environ["YUNET_MODEL_PATH"])
    assert detector.detect(np.full((640, 360, 3), 40, dtype=np.uint8)) == []
