"""Two-signal language identification (decision **D14**, `09 §1.1`).

RR-02 F4 is the reason this module is not one line of ``whisper.detect_language``:
IndicLID's romanised accuracy is about 0.80 and its F1 is 0.75, which is too weak
to put a job on the expensive code-mix lane by itself. So the rule is
**agreement**, not confidence:

* a **code-mix lane** needs *both* signals to point at Hindi/Hinglish **and** a
  ``codeMixScore ≥ 0.3`` — or an explicit user hint saying Hinglish, which always
  wins because the user knows what they recorded;
* otherwise the language is what both signals agree on;
* when they disagree, the acoustic signal (Whisper) decides and the result is
  flagged ``lowConfidence`` so the editor can surface it and A11 can highlight it.

## The two signals

**Signal 1 — acoustic.** Whisper LID over the D14 windows: 60 s from the start of
speech plus two 15 s windows a third and two thirds of the way in. Implemented by
whatever :class:`LanguageIdentifier` the deployment has —
:class:`WhisperLanguageIdentifier` (faster-whisper ``detect_language``, the
``local-asr`` extra), :class:`GpuLanguageIdentifier` (the D15 model server), or
:class:`ProviderLanguageIdentifier`, which reuses the language the routed ASR
provider already reported for the first chunk and costs nothing extra.

**Signal 2 — textual.** A local classifier over the first chunk's text.
:class:`IndicLidClassifier` loads AI4Bharat IndicLID (MIT) from
``WORKER_AI_INDICLID_DIR`` when it is present, and otherwise falls back to
:func:`script_profile` — a deterministic script-share and romanised-Hindi-lexicon
scorer that needs no model, no network and no download. The fallback is what runs
in CI and on a developer machine, which is exactly where a model download would
be intolerable.

The **codeMixScore** is the romanised-Hindi share of the text: the fraction of
Latin-script tokens that are Hindi function words rather than English ones. That
is the same quantity IndicLID's romanised head estimates, computed from a small
closed-class lexicon so the number is explainable in a support ticket.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from worker_ai.languages import base_tag, is_code_mix_tag, normalise_language, same_language
from worker_ai.logging_setup import get_logger
from worker_ai.vad import SpeechRegion

__all__ = [
    "CODE_MIX_THRESHOLD",
    "LID_LONG_WINDOW_MS",
    "LID_SHORT_WINDOW_MS",
    "GpuLanguageIdentifier",
    "IndicLidClassifier",
    "LanguageIdentifier",
    "LanguageSignal",
    "LidDecision",
    "ProviderLanguageIdentifier",
    "TextClassifier",
    "WhisperLanguageIdentifier",
    "decide_language",
    "lid_windows",
    "romanised_hindi_share",
    "script_profile",
]

_log = get_logger(__name__)

#: D14: one 60 s window and two 15 s windows.
LID_LONG_WINDOW_MS = 60_000
LID_SHORT_WINDOW_MS = 15_000

#: `09 §1.2`: the code-mix lane needs a romanised-Hindi share of at least this.
CODE_MIX_THRESHOLD = 0.3

_TOKEN = re.compile(r"[^\W\d_]+", re.UNICODE)
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_LATIN = re.compile(r"[A-Za-z]")

#: Closed-class romanised Hindi: function words a Hinglish sentence cannot avoid
#: and an English sentence never uses. Deliberately small and deliberately not
#: content words — "video", "editing" and "captions" are English words a Hindi
#: speaker uses, and counting them would make every Hinglish clip look English.
_ROMANISED_HINDI: frozenset[str] = frozenset(
    {
        "aap", "aaj", "aur", "abhi", "acha", "achha", "agar", "apna", "apne", "ab",
        "baad", "baat", "bahut", "banate", "bare", "baare", "bhi", "bilkul", "bol",
        "bolte", "chahiye", "cheez", "dekho", "dena", "dete", "diya", "dono", "ek",
        "gaya", "gaye", "hai", "hain", "haan", "hamesha", "hum", "humne", "hua",
        "hue", "isko", "iska", "iske", "isliye", "jab", "jaisa", "jaise", "jata",
        "jyada", "kaam", "kab", "kaha", "kahan", "kaise", "kar", "karke", "karna",
        "karne", "karo", "karenge", "kya", "kyun", "kyunki", "ke", "ki", "ko",
        "koi", "kuch", "lekin", "liye", "log", "magar", "main", "mein", "mera",
        "mere", "matlab", "milta", "nahi", "nahin", "nikal", "par", "pe", "phir",
        "pura", "raha", "rahe", "sab", "sabse", "saath", "sakta", "samajh", "se",
        "sirf", "toh", "tha", "the", "thi", "tum", "unka", "unke", "wahan", "wo",
        "woh", "yaani", "yeh", "ye", "yahan", "zyada",
    }
)

#: Words spelled the same in both languages; counting them either way is noise.
_AMBIGUOUS: frozenset[str] = frozenset({"the", "main", "par", "he", "so", "to", "me", "is"})


@dataclass(frozen=True, slots=True)
class LanguageSignal:
    """One vote in the two-signal rule."""

    #: Where the vote came from: ``whisper``, ``gpu``, ``provider``, ``indiclid``.
    source: str
    #: BCP-47 tag, or ``""`` when the signal had no opinion.
    language: str
    confidence: float = 0.0
    #: Romanised-Hindi share, when this signal can estimate one.
    code_mix_score: float | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def present(self) -> bool:
        return bool(self.language)

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "source": self.source,
            "language": self.language,
            "confidence": round(self.confidence, 4),
        }
        if self.code_mix_score is not None:
            wire["codeMixScore"] = round(self.code_mix_score, 4)
        if self.detail:
            wire["detail"] = dict(self.detail)
        return wire


@dataclass(frozen=True, slots=True)
class LidDecision:
    """What the two signals decided, and why — logged on every job (`09 §1`)."""

    language: str
    code_mix: bool
    code_mix_score: float
    low_confidence: bool
    reason: str
    signals: tuple[LanguageSignal, ...] = ()
    #: True when the user told us, in which case no signal could override it.
    from_hint: bool = False

    def to_wire(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "codeMix": self.code_mix,
            "codeMixScore": round(self.code_mix_score, 4),
            "lowConfidence": self.low_confidence,
            "reason": self.reason,
            "fromHint": self.from_hint,
            "signals": [signal.to_wire() for signal in self.signals],
        }


# ---------------------------------------------------------------------------
# Signal 1: the acoustic identifiers
# ---------------------------------------------------------------------------


class LanguageIdentifier(ABC):
    """Detects a language from audio over the D14 windows."""

    name: str = "abstract"

    def available(self) -> str | None:
        """``None`` when usable here, otherwise the reason it is not."""
        return None

    @abstractmethod
    async def identify(
        self, audio_uri: str, windows: tuple[tuple[int, int], ...]
    ) -> LanguageSignal:
        """One signal for the whole file, pooled across ``windows``."""
        raise NotImplementedError


class ProviderLanguageIdentifier(LanguageIdentifier):
    """The language the routed ASR provider already reported.

    The cheapest possible acoustic signal: the first chunk has been transcribed
    anyway, and every adapter returns ``language`` and ``language_confidence``.
    It is the signal used when no Whisper model and no GPU endpoint is present,
    which covers CI, developer machines and the vendor-only deployment shape.
    """

    name = "provider"

    def __init__(self, language: str, confidence: float | None, *, provider: str = "") -> None:
        self._language = normalise_language(language)
        self._confidence = float(confidence) if confidence is not None else 0.0
        self._provider = provider

    async def identify(
        self, audio_uri: str, windows: tuple[tuple[int, int], ...]
    ) -> LanguageSignal:
        del audio_uri, windows
        return LanguageSignal(
            source=self.name,
            language=self._language,
            confidence=self._confidence,
            detail={"provider": self._provider} if self._provider else {},
        )


class WhisperLanguageIdentifier(LanguageIdentifier):
    """faster-whisper ``detect_language`` over each window, pooled by probability.

    The model is loaded lazily and shared, because loading it costs seconds and a
    worker that only ever consumes ``ai.align`` must never pay for one.
    """

    name = "whisper"

    def __init__(
        self,
        *,
        model_name: str = "small",
        model_factory: Any = None,
    ) -> None:
        self._model_name = model_name
        self._model_factory = model_factory
        self._model: Any = None

    def available(self) -> str | None:
        if self._model_factory is not None:
            return None
        from importlib.util import find_spec

        if find_spec("faster_whisper") is None:
            return 'faster-whisper is not installed (pip install -e ".[local-asr]")'
        return None

    def _load(self) -> Any:
        if self._model is None:
            if self._model_factory is not None:
                self._model = self._model_factory()
            else:  # pragma: no cover - needs the optional extra and a download
                from faster_whisper import WhisperModel

                self._model = WhisperModel(self._model_name, device="cpu", compute_type="int8")
        return self._model

    async def identify(
        self, audio_uri: str, windows: tuple[tuple[int, int], ...]
    ) -> LanguageSignal:
        import asyncio

        model = await asyncio.to_thread(self._load)
        votes: dict[str, float] = {}
        for start_ms, end_ms in windows or ((0, LID_LONG_WINDOW_MS),):
            language, probability = await asyncio.to_thread(
                _detect_one, model, audio_uri, start_ms, end_ms
            )
            tag = normalise_language(language)
            if tag:
                votes[tag] = votes.get(tag, 0.0) + float(probability)
        if not votes:
            return LanguageSignal(source=self.name, language="", confidence=0.0)
        total = sum(votes.values())
        best = max(votes, key=lambda key: votes[key])
        return LanguageSignal(
            source=self.name,
            language=best,
            confidence=round(votes[best] / total, 4) if total else 0.0,
            detail={"windows": len(windows)},
        )


def _detect_one(model: Any, audio_uri: str, start_ms: int, end_ms: int) -> tuple[str, float]:
    """One ``detect_language`` call; shape-tolerant because the API has changed."""
    result = model.detect_language(audio_uri, clip_timestamps=[start_ms / 1000, end_ms / 1000])
    if isinstance(result, tuple) and len(result) >= 2:
        return str(result[0]), float(result[1])
    if isinstance(result, dict):
        return str(result.get("language") or ""), float(result.get("probability") or 0.0)
    return str(result or ""), 1.0


class GpuLanguageIdentifier(LanguageIdentifier):
    """The D15 model server's ``/detect-language`` route.

    ```
    POST {GPU_PROVIDER_URL}/detect-language
    { "audio": "...", "windows": [[0, 60000], [120000, 135000]] }
    200 { "language": "hi", "probability": 0.96 }
    ```
    """

    name = "gpu"

    def __init__(self, base_url: str, *, token: str = "", http: Any = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._http = http

    def available(self) -> str | None:
        if not self._base_url and self._http is None:
            return "GPU_PROVIDER_URL is not set"
        return None

    def _client(self) -> Any:
        if self._http is None:
            from worker_ai.providers.http import VendorHttp

            self._http = VendorHttp(
                provider="serverless-whisper",
                base_url=self._base_url,
                headers={"authorization": "Bearer " + self._token} if self._token else {},
            )
        return self._http

    async def identify(
        self, audio_uri: str, windows: tuple[tuple[int, int], ...]
    ) -> LanguageSignal:
        payload = await self._client().json(
            "POST",
            "/detect-language",
            json_body={"audio": audio_uri, "windows": [list(window) for window in windows]},
        )
        probability = payload.get("probability")
        return LanguageSignal(
            source=self.name,
            language=normalise_language(str(payload.get("language") or "")),
            confidence=round(float(probability), 4)
            if isinstance(probability, int | float)
            else 0.0,
        )


# ---------------------------------------------------------------------------
# Signal 2: the local text classifier
# ---------------------------------------------------------------------------


class TextClassifier(ABC):
    """Classifies the language of a chunk of text, locally."""

    name: str = "abstract"

    def available(self) -> str | None:
        return None

    @abstractmethod
    def classify(self, text: str) -> LanguageSignal:
        """One signal from ``text``."""
        raise NotImplementedError


def script_profile(text: str) -> dict[str, float]:
    """Character shares by script: ``devanagari``, ``latin`` and ``other``.

    The cheapest reliable signal there is. Devanagari cannot be English and Latin
    cannot be written Hindi, so the split alone separates the native-script lanes
    from the romanised ones before any lexicon is consulted.
    """
    devanagari = len(_DEVANAGARI.findall(text))
    latin = len(_LATIN.findall(text))
    letters = sum(1 for character in text if character.isalpha())
    if letters == 0:
        return {"devanagari": 0.0, "latin": 0.0, "other": 0.0}
    return {
        "devanagari": devanagari / letters,
        "latin": latin / letters,
        "other": max(0.0, (letters - devanagari - latin) / letters),
    }


def romanised_hindi_share(text: str) -> float:
    """The ``codeMixScore``: the romanised-Hindi share of the Latin tokens.

    Ambiguous spellings are excluded from both the numerator and the denominator,
    so "the main par" scores 0 rather than 1. Devanagari text scores 0 because it
    is not code-mixed, it is Hindi.
    """
    tokens = [token.casefold() for token in _TOKEN.findall(text)]
    latin = [token for token in tokens if _LATIN.match(token) and token not in _AMBIGUOUS]
    if not latin:
        return 0.0
    hindi = sum(1 for token in latin if token in _ROMANISED_HINDI)
    return hindi / len(latin)


class IndicLidClassifier(TextClassifier):
    """AI4Bharat IndicLID when its model directory exists, heuristics otherwise.

    IndicLID (MIT, 22 languages, native and romanised heads) is loaded from
    ``WORKER_AI_INDICLID_DIR`` through fastText, lazily, on first use. Where that
    directory is absent — CI, every developer machine, the CPU image until A00-05
    ships the models — the classifier answers from :func:`script_profile` and
    :func:`romanised_hindi_share` instead. It always answers: a signal that can
    be missing would silently reduce the two-signal rule to one signal, which is
    the failure mode RR-02 F4 warns about.
    """

    name = "indiclid"

    def __init__(self, model_dir: str = "", *, model: Any = None) -> None:
        self.model_dir = model_dir
        self._model = model
        self._tried = model is not None

    @property
    def backend(self) -> str:
        """``indiclid`` when the model loaded, ``heuristic`` otherwise."""
        return "indiclid" if self._load() is not None else "heuristic"

    def _load(self) -> Any:
        if not self._tried:
            self._tried = True
            self._model = _load_indiclid(self.model_dir)
        return self._model

    def classify(self, text: str) -> LanguageSignal:
        cleaned = text.strip()
        if not cleaned:
            return LanguageSignal(source=self.name, language="", confidence=0.0)

        model = self._load()
        scripts = script_profile(cleaned)
        share = romanised_hindi_share(cleaned)

        if model is not None:
            language, confidence = _predict(model, cleaned)
            return LanguageSignal(
                source=self.name,
                language=normalise_language(language),
                confidence=confidence,
                code_mix_score=share,
                detail={"backend": "indiclid", **_rounded(scripts)},
            )

        language, confidence = _heuristic_language(scripts, share)
        return LanguageSignal(
            source=self.name,
            language=language,
            confidence=confidence,
            code_mix_score=share,
            detail={"backend": "heuristic", **_rounded(scripts)},
        )


def _rounded(scripts: dict[str, float]) -> dict[str, float]:
    return {key: round(value, 4) for key, value in scripts.items()}


def _heuristic_language(scripts: dict[str, float], share: float) -> tuple[str, float]:
    """Language and confidence from the script split and the romanised share."""
    if scripts["devanagari"] >= 0.4:
        return "hi", round(min(1.0, scripts["devanagari"] + 0.2), 4)
    if scripts["latin"] >= 0.6:
        if share >= CODE_MIX_THRESHOLD:
            # Romanised Hindi mixed with English is the Hinglish lane itself.
            return "hi-en", round(min(1.0, 0.5 + share / 2), 4)
        return "en", round(min(1.0, 0.4 + (1 - share) / 2), 4)
    # Neither script dominates: no opinion rather than a coin flip.
    return "", 0.0


def _load_indiclid(model_dir: str) -> Any:
    """Load the fastText heads from ``model_dir``; ``None`` when unavailable."""
    if not model_dir:
        return None
    directory = Path(model_dir)
    if not directory.is_dir():
        _log.warning("IndicLID model dir is missing", extra={"dir": str(directory)})
        return None
    try:  # pragma: no cover - needs the model files and the optional dependency
        import fasttext  # type: ignore[import-not-found]
    except ImportError:
        _log.warning("fasttext is not installed; IndicLID falls back to the heuristic")
        return None
    candidate = directory / "model_baseline_roman.bin"  # pragma: no cover
    if not candidate.is_file():  # pragma: no cover
        _log.warning("IndicLID checkpoint is missing", extra={"path": str(candidate)})
        return None
    return fasttext.load_model(str(candidate))  # pragma: no cover


def _predict(model: Any, text: str) -> tuple[str, float]:  # pragma: no cover - needs the model
    """One fastText prediction, mapped out of the ``__label__xxx_Script`` form."""
    labels, probabilities = model.predict(text.replace("\n", " "), k=1)
    if not labels:
        return "", 0.0
    label = str(labels[0]).removeprefix("__label__").split("_")[0]
    return label, round(float(probabilities[0]), 4)


# ---------------------------------------------------------------------------
# The rule
# ---------------------------------------------------------------------------


def lid_windows(
    duration_ms: int, regions: tuple[SpeechRegion, ...] = ()
) -> tuple[tuple[int, int], ...]:
    """The D14 scan: 60 s from the first speech, plus two 15 s windows.

    The long window starts at the first speech region rather than at zero, so a
    file that opens with eight seconds of room tone does not spend most of its
    LID budget on silence.
    """
    if duration_ms <= 0:
        return ()
    start = regions[0].start_ms if regions else 0
    long_window = (start, min(duration_ms, start + LID_LONG_WINDOW_MS))
    windows = [long_window]
    for fraction in (1 / 3, 2 / 3):
        begin = int(duration_ms * fraction)
        end = min(duration_ms, begin + LID_SHORT_WINDOW_MS)
        if end - begin >= LID_SHORT_WINDOW_MS // 3 and begin >= long_window[1]:
            windows.append((begin, end))
    return tuple(windows)


def decide_language(
    *,
    acoustic: LanguageSignal,
    textual: LanguageSignal,
    hint: str | None = None,
) -> LidDecision:
    """Combine the two signals into a lane decision (D14, `09 §1.1`).

    The order of the branches *is* the rule, so it reads top to bottom:

    1. an explicit user hint wins outright — including a Hinglish hint, which is
       the documented way to force the code-mix lane;
    2. both signals agreeing on Hindi or Hinglish with ``codeMixScore ≥ 0.3`` is
       the code-mix lane;
    3. both signals agreeing on anything else is that language;
    4. a disagreement takes the acoustic signal and raises ``lowConfidence``;
    5. one signal alone is used, also flagged;
    6. nothing at all falls through to the caller's default.
    """
    signals = tuple(signal for signal in (acoustic, textual) if signal is not None)
    score = textual.code_mix_score if textual.code_mix_score is not None else 0.0

    if hint:
        normalised = normalise_language(hint)
        if is_code_mix_tag(hint):
            return LidDecision(
                language="hi-en",
                code_mix=True,
                code_mix_score=score,
                low_confidence=False,
                reason="the user hinted Hinglish, which always wins (`09 §1.1`)",
                signals=signals,
                from_hint=True,
            )
        if normalised:
            return LidDecision(
                language=normalised,
                code_mix=False,
                code_mix_score=score,
                low_confidence=False,
                reason="the user pinned the language",
                signals=signals,
                from_hint=True,
            )

    acoustic_code_mix = is_code_mix_tag(acoustic.language)
    textual_code_mix = is_code_mix_tag(textual.language)
    both_hindi_ish = _hindi_ish(acoustic.language) and _hindi_ish(textual.language)

    if both_hindi_ish and score >= CODE_MIX_THRESHOLD:
        return LidDecision(
            language="hi-en",
            code_mix=True,
            code_mix_score=score,
            low_confidence=False,
            reason=(
                "both signals agree on Hindi/Hinglish and the romanised share is "
                + str(round(score, 2))
                + " (>= "
                + str(CODE_MIX_THRESHOLD)
                + ")"
            ),
            signals=signals,
        )

    if (acoustic_code_mix or textual_code_mix) and not both_hindi_ish:
        # One signal said Hinglish and the other did not: D14 requires agreement,
        # so the lane falls back to plain Hindi rather than the dearer lane.
        language = base_tag(acoustic.language) or "hi"
        return LidDecision(
            language=language,
            code_mix=False,
            code_mix_score=score,
            low_confidence=True,
            reason="only one signal claimed code-mix; D14 needs both",
            signals=signals,
        )

    if acoustic.present and textual.present and same_language(acoustic.language, textual.language):
        return LidDecision(
            language=base_tag(acoustic.language),
            code_mix=False,
            code_mix_score=score,
            low_confidence=False,
            reason="both signals agree",
            signals=signals,
        )

    if acoustic.present and textual.present:
        return LidDecision(
            language=base_tag(acoustic.language),
            code_mix=False,
            code_mix_score=score,
            low_confidence=True,
            reason=(
                "the signals disagree ("
                + acoustic.source
                + "="
                + acoustic.language
                + ", "
                + textual.source
                + "="
                + textual.language
                + "); the acoustic signal decides"
            ),
            signals=signals,
        )

    only = acoustic if acoustic.present else textual
    if only.present:
        return LidDecision(
            language=base_tag(only.language),
            code_mix=False,
            code_mix_score=score,
            low_confidence=True,
            reason="only the " + only.source + " signal had an opinion",
            signals=signals,
        )

    return LidDecision(
        language="",
        code_mix=False,
        code_mix_score=score,
        low_confidence=True,
        reason="neither signal had an opinion",
        signals=signals,
    )


def _hindi_ish(tag: str) -> bool:
    """True for Hindi and for the code-mix tag — the two the lane rule pairs."""
    normalised = base_tag(tag)
    return normalised in {"hi", "hi-en"}
