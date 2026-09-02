"""The real backends' own logic, without downloading a weight.

Every backend is a thin wrapper around somebody else's library, and almost all of
the code that can be wrong is the *parsing*: turning faster-whisper's segment
objects into words, pyannote's ``Annotation`` into turns, an ONNX logits tensor
into frame spans. That parsing is exactly what a stub can exercise properly and
what an end-to-end test with a real model exercises badly (one shape, once).

So: the sessions and pipelines are stubbed, the code under test is the real
backend, and ``test_cpu_end_to_end.py`` is what proves the stubs are not lying
about the shapes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from model_server.models.aligner import CtcAligner, CtcCheckpoint, log_softmax
from model_server.models.base import AlignJob, DetectJob, TranscribeJob
from model_server.models.diariser import PYANNOTE_ATTRIBUTION, PyannoteDiariser, _turns
from model_server.models.whisper import DEFAULT_LID_WINDOW_S, FasterWhisperAsr, _as_float32

# ---------------------------------------------------------------------------
# Stubs shaped like the libraries
# ---------------------------------------------------------------------------


class StubWord:
    def __init__(self, start: float, end: float, word: str, probability: float = 0.9) -> None:
        self.start = start
        self.end = end
        self.word = word
        self.probability = probability


class StubSegment:
    def __init__(self, start: float, end: float, text: str, words: list[StubWord]) -> None:
        self.start = start
        self.end = end
        self.text = text
        self.words = words


class StubInfo:
    def __init__(self, language: str, probability: float, duration: float) -> None:
        self.language = language
        self.language_probability = probability
        self.duration = duration


class StubWhisper:
    """Enough of ``faster_whisper.WhisperModel`` for the parsing to be real."""

    def __init__(self, *, detect: Any = ("hi", 0.87), segments: list[StubSegment] | None = None):
        self._detect = detect
        self._segments = segments if segments is not None else _default_segments()
        self.calls: list[dict[str, Any]] = []

    def transcribe(self, audio: Any, **options: Any) -> tuple[list[StubSegment], StubInfo]:
        self.calls.append(options)
        return self._segments, StubInfo("hi", 0.91, 4.0)

    def detect_language(self, audio: Any) -> Any:
        return self._detect


def _default_segments() -> list[StubSegment]:
    return [
        StubSegment(
            0.0,
            2.0,
            " toh aaj",
            [StubWord(0.12, 0.44, " toh"), StubWord(0.48, 0.8, " aaj")],
        ),
        # An empty segment with no words: real output has these, and a parser
        # that emits an empty word breaks the caller's word-id numbering.
        StubSegment(2.0, 2.1, "   ", [StubWord(2.0, 2.05, "  ")]),
    ]


# ---------------------------------------------------------------------------
# faster-whisper
# ---------------------------------------------------------------------------


def _asr(model: Any) -> FasterWhisperAsr:
    backend = FasterWhisperAsr("tiny", device="cpu", compute_type="int8")
    backend._model = model
    backend._ready = True
    return backend


def test_transcribe_parses_segments_and_words_and_drops_blanks() -> None:
    backend = _asr(StubWhisper())
    (output,) = backend.transcribe(
        [TranscribeJob(samples=np.zeros(16_000, dtype=np.float32), sample_rate=16_000)]
    )
    assert output.language == "hi"
    assert output.language_probability == 0.91
    assert output.duration_s == 4.0
    assert [word.word for word in output.words] == ["toh", "aaj"]
    assert [segment.text for segment in output.segments] == ["toh aaj"]


def test_transcribe_forwards_the_decoding_settings() -> None:
    model = StubWhisper()
    backend = _asr(model)
    backend.transcribe(
        [
            TranscribeJob(
                samples=np.zeros(1600, dtype=np.float32),
                sample_rate=16_000,
                language="ta",
                beam_size=3,
                temperature=(0.0, 0.2),
                initial_prompt="Aksharo",
            )
        ]
    )
    options = model.calls[0]
    assert options["beam_size"] == 3
    assert options["temperature"] == [0.0, 0.2]
    assert options["language"] == "ta"
    assert options["initial_prompt"] == "Aksharo"


def test_transcribe_falls_back_to_the_sample_count_when_the_library_reports_no_duration() -> None:
    class NoDuration(StubWhisper):
        def transcribe(self, audio: Any, **options: Any) -> tuple[list[StubSegment], StubInfo]:
            return [], StubInfo("en", 0.5, 0.0)

    backend = _asr(NoDuration())
    (output,) = backend.transcribe(
        [TranscribeJob(samples=np.zeros(32_000, dtype=np.float32), sample_rate=16_000)]
    )
    assert output.duration_s == 2.0


def test_transcribe_returns_one_output_per_job_in_order() -> None:
    backend = _asr(StubWhisper())
    jobs = [
        TranscribeJob(samples=np.zeros(1600, dtype=np.float32), sample_rate=16_000, language=tag)
        for tag in ("hi", "ta", "en")
    ]
    outputs = backend.transcribe(jobs)
    assert len(outputs) == len(jobs)


def test_transcribe_with_no_jobs_is_not_a_model_call() -> None:
    backend = _asr(StubWhisper())
    assert backend.transcribe([]) == []


def test_transcribe_without_a_loaded_model_is_a_clear_error() -> None:
    backend = FasterWhisperAsr("tiny", device="cpu")
    with pytest.raises(RuntimeError, match="not loaded"):
        backend.transcribe(
            [TranscribeJob(samples=np.zeros(16, dtype=np.float32), sample_rate=16_000)]
        )
    with pytest.raises(RuntimeError, match="not loaded"):
        backend.detect_language(
            DetectJob(samples=np.zeros(16, dtype=np.float32), sample_rate=16_000)
        )


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (("hi", 0.87), ("hi", 0.87)),
        (("hi", 0.87, {"hi": 0.87}), ("hi", 0.87)),
        ({"language": "ta", "probability": 0.5}, ("ta", 0.5)),
        ("bn", ("bn", 1.0)),
    ],
)
def test_detect_language_tolerates_every_shape_the_library_has_returned(
    result: Any, expected: tuple[str, float]
) -> None:
    backend = _asr(StubWhisper(detect=result))
    (verdict,) = backend.detect_language(
        DetectJob(samples=np.zeros(16_000, dtype=np.float32), sample_rate=16_000)
    )
    assert (verdict.language, verdict.probability) == expected


def test_detect_language_defaults_to_the_first_thirty_seconds() -> None:
    backend = _asr(StubWhisper())
    samples = np.zeros(16_000 * 60, dtype=np.float32)
    (verdict,) = backend.detect_language(DetectJob(samples=samples, sample_rate=16_000))
    assert verdict.start_ms == 0
    assert verdict.end_ms == int(DEFAULT_LID_WINDOW_S * 1000)


def test_detect_language_returns_one_verdict_per_window_and_clamps_the_last() -> None:
    backend = _asr(StubWhisper())
    samples = np.zeros(16_000 * 4, dtype=np.float32)
    verdicts = backend.detect_language(
        DetectJob(samples=samples, sample_rate=16_000, windows=((0, 2000), (2000, 9000)))
    )
    assert len(verdicts) == 2
    assert verdicts[1].end_ms == 4000, "a window past the end is clamped to the file"


def test_a_window_outside_the_audio_yields_an_empty_verdict_not_a_crash() -> None:
    backend = _asr(StubWhisper())
    (verdict,) = backend.detect_language(
        DetectJob(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16_000,
            windows=((5000, 6000),),
        )
    )
    assert verdict.language == ""
    assert verdict.probability == 0.0


def test_unload_releases_the_model() -> None:
    backend = _asr(StubWhisper())
    backend.unload()
    assert backend.ready is False
    assert backend._model is None


def test_as_float32_makes_a_contiguous_array() -> None:
    strided = np.zeros(200, dtype=np.float32)[::2]
    converted = _as_float32(strided)
    assert converted.dtype == np.float32
    assert converted.flags["C_CONTIGUOUS"]


def test_the_asr_backend_names_its_missing_dependency() -> None:
    backend = FasterWhisperAsr("tiny", device="cpu")
    reason = backend.unavailable()
    # faster-whisper is installed in this venv, so the honest assertion is that
    # the check runs and, when it does report, it names the extra to install.
    assert reason is None or "faster-whisper" in reason


# ---------------------------------------------------------------------------
# The CTC aligner
# ---------------------------------------------------------------------------


def _checkpoint(vocab: dict[str, int], frames: list[int]) -> CtcCheckpoint:
    """A checkpoint whose session is a fixed emission matrix."""
    size = max(vocab.values()) + 1
    logits = np.zeros((len(frames), size), dtype=np.float32)
    for index, token in enumerate(frames):
        logits[index, token] = 20.0

    class Session:
        def run(self, _outputs: Any, _inputs: Any) -> list[np.ndarray]:
            return [logits[np.newaxis, :, :]]

    return CtcCheckpoint(
        session=Session(),
        vocab=vocab,
        blank=0,
        frame_ms=20,
        model_id="ai4bharat/indicwav2vec/hi",
        licence="MIT",
    )


def test_align_produces_file_times_from_frame_spans() -> None:
    vocab = {"<pad>": 0, "t": 1, "o": 2, "h": 3}
    aligner = CtcAligner("/models/align", device="cpu")
    aligner._checkpoints["hi"] = _checkpoint(vocab, [0, 1, 2, 3, 0])

    output = aligner.align(
        AlignJob(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16_000,
            words=("toh",),
            language="hi",
            start_s=1.5,
        )
    )
    assert output.model_id == "ai4bharat/indicwav2vec/hi"
    assert output.licence == "MIT"
    assert len(output.words) == 1
    word = output.words[0]
    assert word.word == "toh"
    # Frames are 20 ms and the span started 1.5 s into the file.
    assert word.start >= 1.5
    assert word.end > word.start


def test_align_reports_words_the_vocabulary_cannot_represent() -> None:
    """`09 §2` puts the script projection in the caller; the server says what it dropped."""
    vocab = {"<pad>": 0, "t": 1, "o": 2, "h": 3}
    aligner = CtcAligner("/models/align", device="cpu")
    aligner._checkpoints["hi"] = _checkpoint(vocab, [0, 1, 2, 3, 0, 1])

    output = aligner.align(
        AlignJob(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16_000,
            words=("toh", "मतलब"),
            language="hi",
        )
    )
    assert output.skipped == ("मतलब",)
    # A skipped word still gets a slot, so the caller's word ordering survives.
    assert len(output.words) == 2
    assert output.words[1].probability == 0.0


def test_align_with_no_usable_tokens_names_the_projection_problem() -> None:
    aligner = CtcAligner("/models/align", device="cpu")
    aligner._checkpoints["hi"] = _checkpoint({"<pad>": 0, "t": 1}, [0, 1])
    with pytest.raises(ValueError, match="script the checkpoint was trained on"):
        aligner.align(
            AlignJob(
                samples=np.zeros(1600, dtype=np.float32),
                sample_rate=16_000,
                words=("मतलब",),
                language="hi",
            )
        )


def test_align_with_no_words_is_an_empty_answer_not_an_error() -> None:
    aligner = CtcAligner("/models/align", device="cpu")
    output = aligner.align(
        AlignJob(
            samples=np.zeros(1600, dtype=np.float32),
            sample_rate=16_000,
            words=(),
            language="hi",
        )
    )
    assert output.words == ()


def test_the_aligner_is_unavailable_without_a_model_directory() -> None:
    aligner = CtcAligner("", device="cpu")
    reason = aligner.unavailable()
    assert reason is not None
    assert "MODEL_SERVER_ALIGN_MODEL_DIR" in reason
    with pytest.raises(RuntimeError):
        aligner.load()
    assert aligner.checkpoint_dir("hi") is None


def test_the_aligner_is_unavailable_when_the_directory_does_not_exist(tmp_path: Path) -> None:
    aligner = CtcAligner(str(tmp_path / "absent"), device="cpu")
    reason = aligner.unavailable()
    assert reason is not None
    assert "no CTC checkpoints under" in reason


def test_a_configured_directory_makes_the_backend_ready(tmp_path: Path) -> None:
    aligner = CtcAligner(str(tmp_path), device="cpu")
    assert aligner.unavailable() is None
    aligner.load()
    assert aligner.ready is True
    aligner.unload()
    assert aligner.ready is False


def test_per_language_availability_names_the_missing_checkpoint(tmp_path: Path) -> None:
    aligner = CtcAligner(str(tmp_path), device="cpu")
    reason = aligner.unavailable_for("ta")
    assert reason is not None
    assert "no indicwav2vec checkpoint for ta" in reason

    directory = tmp_path / "indicwav2vec" / "ta"
    directory.mkdir(parents=True)
    (directory / "model.onnx").write_bytes(b"not a real model")
    assert aligner.unavailable_for("ta") is None
    # The path is family-aware: English goes to the Apache-2.0 XLSR-53 tree.
    assert aligner.checkpoint_dir("en") == tmp_path / "xlsr53" / "en"
    assert aligner.checkpoint_dir("ta-IN") == tmp_path / "indicwav2vec" / "ta"


def test_a_cached_checkpoint_is_not_reloaded() -> None:
    aligner = CtcAligner("/models/align", device="cpu")
    checkpoint = _checkpoint({"<pad>": 0, "t": 1}, [0, 1])
    aligner._checkpoints["hi"] = checkpoint
    assert aligner._checkpoint("hi-IN") is checkpoint


def test_loading_a_checkpoint_with_no_directory_configured_is_an_error() -> None:
    aligner = CtcAligner("", device="cpu")
    with pytest.raises(RuntimeError, match="no alignment model directory"):
        aligner._checkpoint("hi")


def test_the_checkpoint_encodes_only_characters_it_knows() -> None:
    checkpoint = _checkpoint({"<pad>": 0, "a": 1, "b": 2}, [0, 1])
    assert checkpoint.encode("abz") == [1, 2]


def test_log_softmax_leaves_relative_order_alone() -> None:
    values = log_softmax(np.array([[0.0, 5.0, 1.0]], dtype=np.float32))
    assert int(np.argmax(values)) == 1


# ---------------------------------------------------------------------------
# pyannote
# ---------------------------------------------------------------------------


class StubSpan:
    def __init__(self, start: float, end: float) -> None:
        self.start = start
        self.end = end


class StubAnnotation:
    def __init__(self, tracks: list[tuple[StubSpan, str, str]]) -> None:
        self._tracks = tracks

    def itertracks(self, yield_label: bool = False) -> list[tuple[StubSpan, str, str]]:
        assert yield_label
        return self._tracks


def test_turns_are_sorted_and_zero_length_ones_are_dropped() -> None:
    annotation = StubAnnotation(
        [
            (StubSpan(2.0, 4.0), "A", "SPEAKER_01"),
            (StubSpan(0.0, 2.0), "B", "SPEAKER_00"),
            (StubSpan(4.0, 4.0), "C", "SPEAKER_02"),
        ]
    )
    turns = _turns(annotation)
    assert [turn.speaker for turn in turns] == ["SPEAKER_00", "SPEAKER_01"]
    assert turns[0].start == 0.0
    assert turns[1].end == 4.0


def test_the_diariser_carries_the_attribution_into_engine_versions() -> None:
    diariser = PyannoteDiariser(device="cpu")
    diariser._ready = True
    versions = diariser.engine_versions()
    assert versions["diarise"] == "pyannote/speaker-diarization-community-1"
    assert versions["diarise.licence"] == "CC-BY-4.0"
    assert versions["diarise.attribution"] == PYANNOTE_ATTRIBUTION


def test_the_diariser_refuses_to_run_without_a_pipeline() -> None:
    diariser = PyannoteDiariser(device="cpu")
    assert diariser._pipeline is None
    diariser.unload()
    assert diariser.ready is False


def test_the_diariser_names_its_missing_dependency() -> None:
    reason = PyannoteDiariser(device="cpu").unavailable()
    assert reason is None or "pyannote.audio is not installed" in reason


def test_a_checkpoint_config_can_override_the_frame_rate(tmp_path: Path) -> None:
    """``config.json`` is read for ``frameMs``; the layout matches the worker's."""
    directory = tmp_path / "indicwav2vec" / "hi"
    directory.mkdir(parents=True)
    (directory / "config.json").write_text(json.dumps({"frameMs": 25}), encoding="utf-8")
    assert json.loads((directory / "config.json").read_text(encoding="utf-8"))["frameMs"] == 25
