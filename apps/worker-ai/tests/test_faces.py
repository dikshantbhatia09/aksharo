"""`ai.faces`: YuNet decoding, suppression, and the `faces.json` shape."""

from __future__ import annotations

import math
import os

import numpy as np
import pytest

from worker_ai.passes.faces import (
    FACE_TRACK_VERSION,
    FaceBox,
    FaceSample,
    YuNetOnnxDetector,
    decode_yunet,
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


@pytest.mark.skipif(
    not os.environ.get("YUNET_MODEL_PATH"),
    reason="YUNET_MODEL_PATH not set — no model weights on this machine (H-22)",
)
def test_the_real_model_loads_and_finds_nothing_in_a_blank_frame() -> None:
    detector = YuNetOnnxDetector(os.environ["YUNET_MODEL_PATH"])
    assert detector.detect(np.full((640, 360, 3), 40, dtype=np.uint8)) == []
