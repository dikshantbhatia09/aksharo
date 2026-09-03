"""`worker_ai.clean.deepfilternet3` — the real ONNX loader (M15, H-22).

The `slow`-marked test exercises the actual DeepFilterNet3 ONNX export and
skips when `DEEPFILTERNET_MODEL_DIR` is unset, matching the `ClapEmbedder`
and `YuNetDetector` real-model tests this work package added.
"""

from __future__ import annotations

import os

import pytest

from worker_ai.clean.deepfilternet3 import (
    DeepFilterNet3Onnx,
    DeepFilterNet3UnavailableError,
)


def test_raises_without_model_dir() -> None:
    with pytest.raises(DeepFilterNet3UnavailableError):
        DeepFilterNet3Onnx("")


def test_raises_when_a_graph_is_missing(tmp_path: object) -> None:
    with pytest.raises(DeepFilterNet3UnavailableError):
        DeepFilterNet3Onnx(str(tmp_path))


@pytest.mark.slow
def test_deepfilternet3_onnx_graphs_load_and_run() -> None:
    model_dir = os.environ.get("DEEPFILTERNET_MODEL_DIR", "")
    if not model_dir:
        pytest.skip("DEEPFILTERNET_MODEL_DIR not set — no model weights on this machine (H-22)")

    model = DeepFilterNet3Onnx(model_dir)
    result = model.smoke_run(n_frames=10)

    # ERB mask: one gain value per ERB band, one frame per input frame.
    assert result.erb_mask_shape[-1] == 32
    assert result.erb_mask_shape[-2] == 10
    # Deep-filter coefficients: 10 taps per bin, per DF3's df_order.
    assert result.df_coefs_shape[-1] == 10
    # lsnr: one value per frame.
    assert result.lsnr_shape[-2] == 10
