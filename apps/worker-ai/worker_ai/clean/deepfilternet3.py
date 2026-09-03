"""Real DeepFilterNet3 ONNX weights: the loader `dsp.py`'s module docstring
names as the seam's eventual filler (M15, H-22).

``dsp.py``'s ``spectral_gate_denoise`` remains the actual denoise chain run in
production passes — swapping it for this loader is future work, since a
bit-accurate DeepFilterNet3 forward pass needs the same ERB filterbank and
deep-filtering synthesis the upstream Rust ``libdf`` crate implements, which
is out of this work package's scope. What this module proves is narrower and
matches the M15 brief exactly: the three published ONNX graphs (encoder, ERB
decoder, deep-filtering decoder) **load** through onnxruntime and **execute**
a real forward pass end to end, wired together the way DeepFilterNet3's own
graph export does (``enc`` -> {``erb_dec``, ``df_dec``}), against the
operator-provisioned local weights named by ``DEEPFILTERNET_MODEL_DIR``
(never committed — see ``docs/models/LOCAL-MODELS.md``).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = ["DeepFilterNet3Onnx", "DeepFilterNet3UnavailableError", "SmokeResult"]

_ONNX_FILES = ("enc.onnx", "erb_dec.onnx", "df_dec.onnx")

#: `config.ini`'s `[df]` section, pinned at export time — not user-configurable
#: (a different sample rate/FFT size needs a different model export).
ERB_BANDS = 32
SPEC_FEAT_BINS = 96


class DeepFilterNet3UnavailableError(RuntimeError):
    """Raised when `DeepFilterNet3Onnx` is used but `DEEPFILTERNET_MODEL_DIR`
    is unset, missing a graph, or `onnxruntime` cannot load one."""


@dataclass(frozen=True, slots=True)
class SmokeResult:
    """Shapes out of one synthetic forward pass — proof the three graphs
    actually run together, not just that each loads in isolation."""

    erb_mask_shape: tuple[int, ...]
    df_coefs_shape: tuple[int, ...]
    lsnr_shape: tuple[int, ...]


class DeepFilterNet3Onnx:
    """Loads `enc.onnx`, `erb_dec.onnx` and `df_dec.onnx` from `model_dir`
    lazily — constructing this class never touches `onnxruntime` or the
    filesystem before `model_dir` is validated non-empty, matching the
    `ClapEmbedder`/`YuNetDetector` pattern this work package established.
    """

    def __init__(self, model_dir: str) -> None:
        if not model_dir:
            raise DeepFilterNet3UnavailableError("DEEPFILTERNET_MODEL_DIR is not set")
        try:
            import onnxruntime as ort
        except ImportError as error:  # pragma: no cover - onnxruntime is a core dep
            raise DeepFilterNet3UnavailableError("onnxruntime is not installed") from error

        base = Path(model_dir)
        sessions: dict[str, Any] = {}
        for filename in _ONNX_FILES:
            path = base / filename
            if not path.is_file():
                raise DeepFilterNet3UnavailableError(f"missing {filename} under {model_dir}")
            try:
                sessions[filename] = ort.InferenceSession(
                    str(path), providers=["CPUExecutionProvider"]
                )
            except Exception as error:
                raise DeepFilterNet3UnavailableError(
                    f"failed to load {filename}: {error}"
                ) from error

        self._enc = sessions["enc.onnx"]
        self._erb_dec = sessions["erb_dec.onnx"]
        self._df_dec = sessions["df_dec.onnx"]

    def smoke_run(self, *, n_frames: int = 10) -> SmokeResult:
        """One synthetic forward pass through all three graphs, chained the
        way the real DeepFilterNet3 pipeline chains them: `enc`'s hidden
        state and skip connections feed both decoders. Random input, not
        real audio features — this proves the graphs execute together with
        matching tensor shapes, not that the output denoises anything.
        """
        import numpy as np

        rng = np.random.default_rng(0)
        feat_erb = rng.standard_normal((1, 1, n_frames, ERB_BANDS), dtype=np.float32)
        feat_spec = rng.standard_normal((1, 2, n_frames, SPEC_FEAT_BINS), dtype=np.float32)

        enc_out = self._enc.run(
            None, {"feat_erb": feat_erb, "feat_spec": feat_spec}
        )
        enc_names = [o.name for o in self._enc.get_outputs()]
        enc = dict(zip(enc_names, enc_out, strict=True))

        (erb_mask,) = self._erb_dec.run(
            None,
            {
                "emb": enc["emb"],
                "e3": enc["e3"],
                "e2": enc["e2"],
                "e1": enc["e1"],
                "e0": enc["e0"],
            },
        )
        df_out = self._df_dec.run(None, {"emb": enc["emb"], "c0": enc["c0"]})
        df_coefs = df_out[0]

        return SmokeResult(
            erb_mask_shape=tuple(erb_mask.shape),
            df_coefs_shape=tuple(df_coefs.shape),
            lsnr_shape=tuple(enc["lsnr"].shape),
        )
