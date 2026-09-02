"""CTC forced alignment: the maths behind rungs 2 and 3 of the `09 §2` chain.

Both model-backed aligners — AI4Bharat IndicWav2Vec and Meta MMS — are wav2vec2
CTC heads, so they differ only in *which* checkpoint is loaded and whether the
text needs romanising first. The alignment itself is one algorithm, and it lives
here so it can be tested against hand-written emission matrices rather than
against a 1.2 GB download.

## The algorithm

A CTC head emits, for every 20 ms frame, a distribution over a character
vocabulary plus a blank. Forced alignment asks: given that we already **know**
the transcript, which frames produced which character? That is a Viterbi pass
over the standard CTC lattice — the token sequence with a blank inserted before,
between and after every token — followed by a backtrace that records the first
and last frame assigned to each token. Words are then the span from their first
character's first frame to their last character's last frame.

Three details matter and are each pinned by a test:

* **Log space.** Emissions are log-probabilities; the recursion adds rather than
  multiplies, because a thousand frames of multiplication underflows float32.
* **A repeated character needs a blank between its two copies** — "hello" is
  ``h e l <blank> l o`` — which is the one asymmetry in the transition rules and
  the classic place a hand-rolled CTC aligner goes wrong.
* **Frames are 20 ms** for a 16 kHz wav2vec2 stack (a 320-sample stride). It is a
  property of the checkpoint, so it is read from the model's config and only
  defaults to 20.

## Loading a checkpoint

Weights are **not** committed and are never downloaded at run time. A deployment
points ``WORKER_AI_ALIGN_MODEL_DIR`` at a directory laid out as

```
<dir>/<family>/<language>/model.onnx     # exported CTC head, float32 [1, N] in
<dir>/<family>/<language>/vocab.json     # {"<pad>": 0, "|": 4, "a": 5, ...}
<dir>/<family>/<language>/config.json    # optional: {"frameMs": 20}
```

and the aligner reports itself unavailable — by name, with the missing path —
when the directory is not there. onnxruntime is already a dependency of this
worker (the Silero VAD backend), so no aligner adds one.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from worker_ai.alignment.base import Aligner
from worker_ai.audio import read_pcm
from worker_ai.logging_setup import get_logger
from worker_ai.providers.base import AlignmentRequest, Word
from worker_ai.vad import SpeechRegion

__all__ = [
    "DEFAULT_FRAME_MS",
    "WORD_DELIMITER",
    "CtcAligner",
    "CtcModel",
    "Emitter",
    "TokenSpan",
    "forced_align",
    "word_spans",
]

_log = get_logger(__name__)

#: 16 kHz wav2vec2 with a 320-sample stride.
DEFAULT_FRAME_MS = 20

#: wav2vec2 CTC vocabularies spell a space as a pipe.
WORD_DELIMITER = "|"

#: ``(samples, language) -> [frames, vocab]`` log-probabilities. Injectable so a
#: test can align against a matrix it wrote by hand.
Emitter = Callable[[NDArray[np.float32], str], NDArray[np.float32]]


@dataclass(frozen=True, slots=True)
class TokenSpan:
    """The frames one target token was emitted over."""

    token: int
    start_frame: int
    end_frame: int
    score: float


def forced_align(
    log_probs: NDArray[np.float32], tokens: list[int], blank: int = 0
) -> tuple[TokenSpan, ...]:
    """Viterbi-align ``tokens`` against ``log_probs`` (``[frames, vocab]``).

    :param log_probs: per-frame log-probabilities from a CTC head.
    :param tokens: the target token ids, in order, with no blanks.
    :param blank: the vocabulary index of the CTC blank.
    :returns: one :class:`TokenSpan` per token, in order.
    :raises ValueError: when the audio is too short to contain the tokens, which
        is the one failure mode the caller must handle rather than paper over.
    """
    frames = int(log_probs.shape[0])
    if not tokens:
        return ()
    # The extended sequence: blank, token, blank, token, ..., blank.
    extended: list[int] = [blank]
    for token in tokens:
        extended.append(token)
        extended.append(blank)
    states = len(extended)
    if frames < len(tokens):
        raise ValueError(
            "cannot align " + str(len(tokens)) + " tokens into " + str(frames) + " frames"
        )

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
            # A skip over a blank is legal only between two *different* tokens;
            # "ll" must keep its separating blank or it collapses to one "l".
            if (
                state > 1
                and extended[state] != blank
                and extended[state] != extended[state - 2]
                and alpha[frame - 1, state - 2] > best_score
            ):
                best_previous, best_score = state - 2, alpha[frame - 1, state - 2]
            alpha[frame, state] = best_score + log_probs[frame, extended[state]]
            backpointer[frame, state] = best_previous

    # The path must end on the last token or on the blank after it.
    end_state = states - 1
    if states > 1 and alpha[frames - 1, states - 2] > alpha[frames - 1, states - 1]:
        end_state = states - 2

    path = [0] * frames
    state = end_state
    for frame in range(frames - 1, -1, -1):
        path[frame] = state
        state = int(backpointer[frame, state])

    spans: list[TokenSpan] = []
    for index, _token in enumerate(tokens):
        state_index = 2 * index + 1
        assigned = [frame for frame in range(frames) if path[frame] == state_index]
        if assigned:
            start, end = assigned[0], assigned[-1] + 1
            score = float(
                np.mean([log_probs[frame, extended[state_index]] for frame in assigned])
            )
        else:
            # A token the path never dwelled on (two identical characters at a
            # boundary): give it a zero-width span at its neighbour's edge rather
            # than dropping it, because the caller indexes by position.
            previous_end = spans[-1].end_frame if spans else 0
            start, end, score = previous_end, previous_end, float(negative_infinity)
        spans.append(TokenSpan(token=tokens[index], start_frame=start, end_frame=end, score=score))
    return tuple(spans)


def word_spans(
    words: tuple[str, ...], spans: tuple[TokenSpan, ...], lengths: tuple[int, ...]
) -> tuple[tuple[int, int], ...]:
    """Group per-token frame spans back into per-word frame spans."""
    out: list[tuple[int, int]] = []
    cursor = 0
    for index, _word in enumerate(words):
        length = lengths[index]
        chunk = spans[cursor : cursor + length]
        cursor += length
        if not chunk:
            previous = out[-1][1] if out else 0
            out.append((previous, previous))
            continue
        out.append((chunk[0].start_frame, max(span.end_frame for span in chunk)))
    return tuple(out)


@dataclass(frozen=True, slots=True)
class CtcModel:
    """One loaded checkpoint: its session, its vocabulary and its frame rate."""

    session: Any
    vocab: dict[str, int]
    blank: int
    frame_ms: int
    path: Path

    def encode(self, text: str) -> list[int]:
        """Characters to token ids, skipping anything the vocabulary lacks."""
        return [self.vocab[character] for character in text if character in self.vocab]


class CtcAligner(Aligner):
    """Base for the model-backed rungs: load a checkpoint, align, snap to VAD.

    Subclasses set :attr:`family`, :attr:`languages`, :attr:`rank`,
    :attr:`model` and :attr:`licence`, and may override :meth:`prepare_text`.
    """

    #: Sub-directory of ``WORKER_AI_ALIGN_MODEL_DIR`` this aligner loads from.
    family = "ctc"
    model = ""
    licence = ""

    def __init__(self, model_dir: str = "", *, emitter: Emitter | None = None) -> None:
        self.model_dir = model_dir
        self._emitter = emitter
        self._models: dict[str, CtcModel] = {}

    # -- availability -------------------------------------------------------

    def language_dir(self, language: str) -> Path | None:
        """Where this language's checkpoint would live, or ``None`` when unset."""
        if not self.model_dir:
            return None
        base = language.strip().casefold().split("-")[0]
        return Path(self.model_dir) / self.family / base

    def available(self) -> str | None:
        """Available when a model directory is configured, or an emitter injected."""
        if self._emitter is not None:
            return None
        if not self.model_dir:
            return (
                "WORKER_AI_ALIGN_MODEL_DIR is not set, so the "
                + self.family
                + " checkpoints are not installed"
            )
        root = Path(self.model_dir) / self.family
        if not root.is_dir():
            return "no " + self.family + " checkpoints under " + str(root)
        return None

    def available_for(self, language: str) -> str | None:
        """Availability for one language — the per-language half of the check."""
        general = self.available()
        if general is not None:
            return general
        if self._emitter is not None:
            return None
        directory = self.language_dir(language)
        if directory is None or not (directory / "model.onnx").is_file():
            return "no " + self.family + " checkpoint for " + language
        return None

    # -- loading ------------------------------------------------------------

    def _load(self, language: str) -> CtcModel:
        base = language.strip().casefold().split("-")[0]
        cached = self._models.get(base)
        if cached is not None:
            return cached
        directory = self.language_dir(base)
        if directory is None:
            raise FileNotFoundError("no model directory is configured")
        model = _load_ctc_model(directory)
        self._models[base] = model
        return model

    # -- text preparation ---------------------------------------------------

    def prepare_text(self, words: tuple[str, ...], language: str) -> tuple[str, ...]:
        """Hook for a script projection; the default is a lower-cased pass-through."""
        del language
        return tuple(word.casefold() for word in words)

    # -- alignment ----------------------------------------------------------

    async def align(
        self, request: AlignmentRequest, regions: tuple[SpeechRegion, ...] = ()
    ) -> tuple[Word, ...]:
        """Force-align ``request.words`` onto the audio span, in file time."""
        import asyncio

        if not request.words:
            return ()
        end_ms = request.end_ms if request.end_ms is not None else request.start_ms
        return await asyncio.to_thread(self._align_sync, request, end_ms, regions)

    def _align_sync(
        self, request: AlignmentRequest, end_ms: int, regions: tuple[SpeechRegion, ...]
    ) -> tuple[Word, ...]:
        prepared = self.prepare_text(request.words, request.language)
        samples, frame_ms, log_probs = self._emissions(request, end_ms)

        vocab_tokens, lengths = self._tokenise(prepared, request.language)
        if not vocab_tokens:
            raise ValueError("none of the words survived tokenisation")

        spans = forced_align(log_probs, vocab_tokens, blank=self._blank(request.language))
        frames = word_spans(request.words, spans, lengths)
        del samples

        words: list[Word] = []
        offset = request.offset_ms + request.start_ms
        for text, (start_frame, end_frame) in zip(request.words, frames, strict=True):
            start = offset + start_frame * frame_ms
            end = offset + max(end_frame, start_frame + 1) * frame_ms
            ceiling = offset + max(0, end_ms - request.start_ms)
            words.append(Word(s=start, e=min(end, ceiling), t=text))
        return _snap(tuple(words), regions)

    def _emissions(
        self, request: AlignmentRequest, end_ms: int
    ) -> tuple[NDArray[np.float32], int, NDArray[np.float32]]:
        """Audio for the span, and the CTC log-probabilities over it."""
        samples = self._read_span(request.audio_uri, request.start_ms, end_ms)
        if self._emitter is not None:
            return samples, DEFAULT_FRAME_MS, self._emitter(samples, request.language)
        model = self._load(request.language)
        outputs = model.session.run(None, {"input_values": samples[np.newaxis, :]})
        logits = np.asarray(outputs[0], dtype=np.float32)
        if logits.ndim == 3:
            logits = logits[0]
        return samples, model.frame_ms, _log_softmax(logits)

    def _read_span(self, audio_uri: str, start_ms: int, end_ms: int) -> NDArray[np.float32]:
        if not audio_uri:
            raise ValueError("a CTC aligner needs audio; the payload named none")
        pcm = read_pcm(Path(audio_uri))
        begin = max(0, int(start_ms * pcm.sample_rate / 1000))
        finish = min(len(pcm.samples), int(max(end_ms, start_ms) * pcm.sample_rate / 1000))
        span = pcm.samples[begin:finish]
        return np.asarray(span, dtype=np.float32)

    def _tokenise(
        self, prepared: tuple[str, ...], language: str
    ) -> tuple[list[int], tuple[int, ...]]:
        """Token ids for every word, and how many tokens each word contributed."""
        if self._emitter is not None:
            # The injected-emitter path uses a trivial vocabulary: one id per
            # distinct character, which is all a test needs.
            vocabulary = _synthetic_vocab(prepared)
            tokens: list[int] = []
            lengths: list[int] = []
            for word in prepared:
                ids = [vocabulary[character] for character in word if character in vocabulary]
                lengths.append(len(ids))
                tokens.extend(ids)
            return tokens, tuple(lengths)

        model = self._load(language)
        tokens = []
        lengths = []
        for word in prepared:
            ids = model.encode(word)
            lengths.append(len(ids))
            tokens.extend(ids)
        return tokens, tuple(lengths)

    def _blank(self, language: str) -> int:
        if self._emitter is not None:
            return 0
        return self._load(language).blank


def _synthetic_vocab(words: tuple[str, ...]) -> dict[str, int]:
    """A deterministic character vocabulary, blank at 0, for the injected path."""
    characters = sorted({character for word in words for character in word})
    return {character: index + 1 for index, character in enumerate(characters)}


def _log_softmax(logits: NDArray[np.float32]) -> NDArray[np.float32]:
    """Numerically stable log-softmax over the vocabulary axis."""
    shifted = logits - logits.max(axis=-1, keepdims=True)
    return (shifted - np.log(np.exp(shifted).sum(axis=-1, keepdims=True))).astype(np.float32)


def _load_ctc_model(directory: Path) -> CtcModel:  # pragma: no cover - needs a checkpoint
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
    blank = vocab.get("<pad>", vocab.get("<blank>", 0))
    session = onnxruntime.InferenceSession(
        str(model_path), providers=["CPUExecutionProvider"]
    )
    _log.info("CTC checkpoint loaded", extra={"path": str(directory), "frameMs": frame_ms})
    return CtcModel(
        session=session, vocab=vocab, blank=blank, frame_ms=frame_ms, path=model_path
    )


def _snap(words: tuple[Word, ...], regions: tuple[SpeechRegion, ...]) -> tuple[Word, ...]:
    """Move any word that landed in a silence to the nearest speech region.

    `09 §2`: "words outside VAD speech regions snap to the nearest region". A
    word highlighted over two seconds of nothing is the visible symptom of an
    aligner that drifted, and this is the cheap correction for it.
    """
    if not regions:
        return words
    snapped: list[Word] = []
    for word in words:
        if any(region.start_ms <= word.s < region.end_ms for region in regions):
            snapped.append(word)
            continue
        nearest = min(
            regions,
            key=lambda region: min(abs(region.start_ms - word.s), abs(region.end_ms - word.s)),
        )
        start = min(max(word.s, nearest.start_ms), nearest.end_ms)
        end = min(max(word.e, start), nearest.end_ms)
        snapped.append(Word(s=start, e=end, t=word.t, c=word.c, sp=word.sp))
    return tuple(snapped)
