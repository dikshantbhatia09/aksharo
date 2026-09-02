"""CTC forced alignment on the GPU model server (decision **D77**).

D77 settles the licence question that A10 could not: ``facebook/mms-…-forced-aligner``
is CC-BY-NC-4.0, so **MMS never ships**. What ships instead is two families,
chosen by language:

* **IndicWav2Vec** (AI4Bharat, **MIT**) for the Indic languages — the eleven
  RR-02 F4 names, plus Assamese and Punjabi where a checkpoint exists.
* **XLSR-53 CTC fine-tunes** (**Apache-2.0**) for everything else; X05's
  Dockerfile already bakes ``jonatasgrosman/wav2vec2-large-xlsr-53-english`` and
  the same family covers the other global languages.

Both are wav2vec2 CTC heads, so they differ only in which checkpoint is loaded.
The alignment is one algorithm: a Viterbi pass over the standard CTC lattice —
the token sequence with a blank inserted before, between and after every token —
then a backtrace recording the frames assigned to each token.

## Why ONNX and not transformers

The checkpoints are **exported to ONNX at image-build time** and run here through
onnxruntime, in the same directory layout
``apps/worker-ai/worker_ai/alignment/ctc.py`` reads:

```
<MODEL_SERVER_ALIGN_MODEL_DIR>/<family>/<language>/model.onnx
<MODEL_SERVER_ALIGN_MODEL_DIR>/<family>/<language>/vocab.json
<MODEL_SERVER_ALIGN_MODEL_DIR>/<family>/<language>/config.json   # optional {"frameMs": 20}
```

Two apps, one layout, so a checkpoint that works on the CPU fallback rung works
on the GPU rung unchanged. It also keeps ``transformers`` and ``torch`` out of the
inference path for alignment: they are needed only in the Dockerfile's export
stage, which is discarded.

## What this module deliberately does not do

**Script projection.** Roman-script Hinglish has to become Devanagari before it
can be tokenised against an IndicWav2Vec vocabulary (`09 §2`), and the table that
does it lives in ``apps/worker-ai/worker_ai/alignment/romanisation.py`` with
IndicXlit queued behind it as A22's work. The caller sends the words in the script
it wants aligned; this server tokenises what it is given and reports, in
``skipped``, any word the vocabulary could not represent. Guessing a projection
here would put two disagreeing transliteration tables in one pipeline.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from model_server.logging_setup import get_logger
from model_server.models.base import AlignerBackend, AlignJob, AlignOutput, WordTiming

__all__ = [
    "DEFAULT_FRAME_MS",
    "INDIC_LANGUAGES",
    "CtcAligner",
    "CtcCheckpoint",
    "family_for",
    "forced_align",
    "word_frames",
]

_log = get_logger(__name__)

#: 16 kHz wav2vec2 with a 320-sample stride. Read from the checkpoint when it says.
DEFAULT_FRAME_MS = 20

#: The languages routed to the MIT IndicWav2Vec heads (RR-02 F4, plus as/pa/ur).
INDIC_LANGUAGES = frozenset(
    {"as", "bn", "gu", "hi", "kn", "ml", "mr", "ne", "or", "pa", "sa", "ta", "te", "ur"}
)

#: family -> (model id, licence). MMS is absent on purpose (D77).
FAMILIES: dict[str, tuple[str, str]] = {
    "indicwav2vec": ("ai4bharat/indicwav2vec", "MIT"),
    "xlsr53": ("jonatasgrosman/wav2vec2-large-xlsr-53", "Apache-2.0"),
}


def family_for(language: str) -> str:
    """Which checkpoint family serves a language (D77)."""
    base = language.strip().casefold().split("-")[0]
    return "indicwav2vec" if base in INDIC_LANGUAGES else "xlsr53"


# ---------------------------------------------------------------------------
# The algorithm
# ---------------------------------------------------------------------------


def forced_align(
    log_probs: NDArray[np.float32], tokens: list[int], blank: int = 0
) -> list[tuple[int, int]]:
    """Viterbi-align ``tokens`` against ``log_probs`` (``[frames, vocab]``).

    :returns: ``(start_frame, end_frame)`` per token, in order.
    :raises ValueError: when there are fewer frames than tokens, which is the one
        failure the caller must handle rather than paper over.

    Two details are the classic places a hand-rolled CTC aligner goes wrong, and
    both are pinned by a test:

    * **Log space.** Emissions are log-probabilities and the recursion adds; a
      thousand frames of multiplication underflows float32.
    * **A repeated character needs a blank between its copies** — "hello" is
      ``h e l <blank> l o``. Skipping that blank collapses "ll" to one "l".
    """
    frames = int(log_probs.shape[0])
    if not tokens:
        return []
    if frames < len(tokens):
        raise ValueError(
            "cannot align " + str(len(tokens)) + " tokens into " + str(frames) + " frames"
        )

    extended: list[int] = [blank]
    for token in tokens:
        extended.append(token)
        extended.append(blank)
    states = len(extended)

    negative_infinity = np.float32(-1.0e30)
    alpha = np.full((frames, states), negative_infinity, dtype=np.float32)
    backpointer = np.zeros((frames, states), dtype=np.int32)

    alpha[0, 0] = log_probs[0, extended[0]]
    if states > 1:
        alpha[0, 1] = log_probs[0, extended[1]]

    for frame in range(1, frames):
        for state in range(states):
            best_previous = state
            best_score = alpha[frame - 1, state]
            if state > 0 and alpha[frame - 1, state - 1] > best_score:
                best_previous, best_score = state - 1, alpha[frame - 1, state - 1]
            if (
                state > 1
                and extended[state] != blank
                and extended[state] != extended[state - 2]
                and alpha[frame - 1, state - 2] > best_score
            ):
                best_previous, best_score = state - 2, alpha[frame - 1, state - 2]
            alpha[frame, state] = best_score + log_probs[frame, extended[state]]
            backpointer[frame, state] = best_previous

    end_state = states - 1
    if states > 1 and alpha[frames - 1, states - 2] > alpha[frames - 1, states - 1]:
        end_state = states - 2

    path = [0] * frames
    state = end_state
    for frame in range(frames - 1, -1, -1):
        path[frame] = state
        state = int(backpointer[frame, state])

    spans: list[tuple[int, int]] = []
    for index in range(len(tokens)):
        state_index = 2 * index + 1
        assigned = [frame for frame in range(frames) if path[frame] == state_index]
        if assigned:
            spans.append((assigned[0], assigned[-1] + 1))
        else:
            # A token the path never dwelled on (two identical characters at a
            # boundary): a zero-width span at its neighbour's edge, because the
            # caller indexes words by position and a dropped token shifts them all.
            previous_end = spans[-1][1] if spans else 0
            spans.append((previous_end, previous_end))
    return spans


def word_frames(spans: list[tuple[int, int]], lengths: tuple[int, ...]) -> list[tuple[int, int]]:
    """Group per-token frame spans back into per-word frame spans."""
    out: list[tuple[int, int]] = []
    cursor = 0
    for length in lengths:
        chunk = spans[cursor : cursor + length]
        cursor += length
        if not chunk:
            previous = out[-1][1] if out else 0
            out.append((previous, previous))
            continue
        out.append((chunk[0][0], max(end for _, end in chunk)))
    return out


def log_softmax(logits: NDArray[np.float32]) -> NDArray[np.float32]:
    """Numerically stable log-softmax over the vocabulary axis."""
    shifted = logits - logits.max(axis=-1, keepdims=True)
    return (shifted - np.log(np.exp(shifted).sum(axis=-1, keepdims=True))).astype(np.float32)


# ---------------------------------------------------------------------------
# The backend
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class CtcCheckpoint:
    """One loaded head: its session, its vocabulary and its frame rate."""

    session: Any
    vocab: dict[str, int]
    blank: int
    frame_ms: int
    model_id: str
    licence: str

    def encode(self, text: str) -> list[int]:
        """Characters to token ids, skipping anything the vocabulary lacks."""
        return [self.vocab[character] for character in text if character in self.vocab]


class CtcAligner(AlignerBackend):
    """IndicWav2Vec and XLSR-53 CTC heads, loaded per language from the bake."""

    kind = "align"
    model_id = "ctc-forced-alignment"
    licence = "MIT (IndicWav2Vec) / Apache-2.0 (XLSR-53); MMS excluded per D77"

    def __init__(self, model_dir: str = "", *, device: str = "cuda") -> None:
        self.model_dir = model_dir
        self.device = device
        self._checkpoints: dict[str, CtcCheckpoint] = {}
        self._lock = threading.Lock()

    # -- availability -------------------------------------------------------

    def unavailable(self) -> str | None:
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            return "onnxruntime is not installed; install the 'align' extra"
        if not self.model_dir:
            return "MODEL_SERVER_ALIGN_MODEL_DIR is not set, so no CTC checkpoint is installed"
        if not Path(self.model_dir).is_dir():
            return "no CTC checkpoints under " + self.model_dir
        return None

    def unavailable_for(self, language: str) -> str | None:
        general = self.unavailable()
        if general is not None:
            return general
        directory = self.checkpoint_dir(language)
        if directory is None or not (directory / "model.onnx").is_file():
            return (
                "no "
                + family_for(language)
                + " checkpoint for "
                + (language or "(unnamed language)")
            )
        return None

    def checkpoint_dir(self, language: str) -> Path | None:
        """Where this language's head lives, or ``None`` when unconfigured."""
        if not self.model_dir:
            return None
        base = language.strip().casefold().split("-")[0]
        return Path(self.model_dir) / family_for(language) / base

    # -- lifecycle ----------------------------------------------------------

    def load(self) -> None:
        """Nothing global to load: the heads are per language and loaded on first use.

        This is not a per-request load — a head is loaded once and cached for the
        life of the process, which is what "warm pool friendly" requires. It is
        per *language*, because a server that eagerly loaded twenty-two heads at
        boot would spend the cold-start budget of `COST.md §4` on languages this
        instance may never see.
        """
        reason = self.unavailable()
        if reason is not None:
            raise RuntimeError(reason)
        self._ready = True

    def unload(self) -> None:
        self._ready = False
        self._checkpoints.clear()

    def _checkpoint(self, language: str) -> CtcCheckpoint:
        base = language.strip().casefold().split("-")[0]
        cached = self._checkpoints.get(base)
        if cached is not None:
            return cached
        with self._lock:
            cached = self._checkpoints.get(base)
            if cached is not None:  # pragma: no cover - lost the race, already loaded
                return cached
            directory = self.checkpoint_dir(base)
            if directory is None:
                raise RuntimeError("no alignment model directory is configured")
            checkpoint = self._open(directory, language=base)
            self._checkpoints[base] = checkpoint
            return checkpoint

    def _open(self, directory: Path, *, language: str) -> CtcCheckpoint:  # pragma: no cover
        """Open the ONNX session and read the vocabulary for one language."""
        import onnxruntime

        model_path = directory / "model.onnx"
        vocab_path = directory / "vocab.json"
        if not model_path.is_file() or not vocab_path.is_file():
            raise FileNotFoundError("incomplete CTC checkpoint at " + str(directory))
        raw: Any = json.loads(vocab_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("the vocabulary at " + str(vocab_path) + " is not an object")
        vocab = {str(key): int(value) for key, value in raw.items()}

        frame_ms = DEFAULT_FRAME_MS
        config_path = directory / "config.json"
        if config_path.is_file():
            config: Any = json.loads(config_path.read_text(encoding="utf-8"))
            if isinstance(config, dict) and isinstance(config.get("frameMs"), int):
                frame_ms = int(config["frameMs"])

        providers = (
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
            if self.device != "cpu"
            else ["CPUExecutionProvider"]
        )
        available = set(onnxruntime.get_available_providers())
        session = onnxruntime.InferenceSession(
            str(model_path), providers=[p for p in providers if p in available] or None
        )
        family = family_for(language)
        base_id, licence = FAMILIES[family]
        _log.info(
            "CTC checkpoint loaded",
            extra={"family": family, "language": language, "frameMs": frame_ms},
        )
        return CtcCheckpoint(
            session=session,
            vocab=vocab,
            blank=vocab.get("<pad>", vocab.get("<blank>", 0)),
            frame_ms=frame_ms,
            model_id=base_id + "/" + language,
            licence=licence,
        )

    # -- alignment ----------------------------------------------------------

    def align(self, job: AlignJob) -> AlignOutput:
        """Force ``job.words`` onto the audio span, returning file times."""
        if not job.words:
            return AlignOutput(words=(), model_id=self.model_id, licence=self.licence)
        checkpoint = self._checkpoint(job.language)
        log_probs = self.emissions(checkpoint, job.samples)

        tokens: list[int] = []
        lengths: list[int] = []
        skipped: list[str] = []
        for word in job.words:
            ids = checkpoint.encode(word.casefold())
            if not ids:
                skipped.append(word)
            lengths.append(len(ids))
            tokens.extend(ids)
        if not tokens:
            raise ValueError(
                "none of the words survived tokenisation against the "
                + family_for(job.language)
                + " vocabulary; the caller must send the script the checkpoint was "
                "trained on (`09 §2`)"
            )

        spans = forced_align(log_probs, tokens, blank=checkpoint.blank)
        frames = word_frames(spans, tuple(lengths))
        seconds = checkpoint.frame_ms / 1000.0
        ceiling = job.start_s + (len(job.samples) / job.sample_rate if job.sample_rate else 0.0)

        words: list[WordTiming] = []
        for text, (start_frame, end_frame) in zip(job.words, frames, strict=True):
            start = job.start_s + start_frame * seconds
            end = job.start_s + max(end_frame, start_frame + 1) * seconds
            words.append(
                WordTiming(
                    start=round(min(start, ceiling), 3),
                    end=round(min(end, ceiling), 3),
                    word=text,
                    probability=1.0 if text not in skipped else 0.0,
                )
            )
        return AlignOutput(
            words=tuple(words),
            model_id=checkpoint.model_id,
            licence=checkpoint.licence,
            skipped=tuple(skipped),
        )

    def emissions(
        self, checkpoint: CtcCheckpoint, samples: NDArray[np.float32]
    ) -> NDArray[np.float32]:  # pragma: no cover - needs a real checkpoint
        """Per-frame CTC log-probabilities for one span."""
        audio = np.ascontiguousarray(samples, dtype=np.float32)[np.newaxis, :]
        outputs = checkpoint.session.run(None, {"input_values": audio})
        logits = np.asarray(outputs[0], dtype=np.float32)
        if logits.ndim == 3:
            logits = logits[0]
        return log_softmax(logits)
