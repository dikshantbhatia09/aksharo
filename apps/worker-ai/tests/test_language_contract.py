"""Every language the product offers reaches every provider it can route to intact.

2026-09-27: "English (India)" (``en-IN``) was offered by the picker, routed to
the ``indian-english`` lane, fell through to ``local-whisper`` — and faster-whisper
refused the tag on every chunk ("'en-IN' is not a valid language code"). Nothing
tested a picker tag against the providers in its lane. This does, for every tag
the web picker offers (read from ``apps/web/components/projects/languages.ts``,
so a new language cannot skip it) plus ``"auto"`` and the code-mix tag LID can
decide on: the tag routes to a lane, and every provider that lane (and its
borrowed default-lane fallbacks) can call accepts what its own language mapping
turns the tag into.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest

from worker_ai.languages import WHISPER_LANGUAGES, is_code_mix_tag, whisper_language
from worker_ai.lid import LanguageSignal, decide_language, pinned_language
from worker_ai.providers import assemblyai, elevenlabs, sarvam
from worker_ai.providers import registry as registry_module
from worker_ai.providers.base import ProviderError, TranscriptionRequest
from worker_ai.providers.local_whisper import LocalWhisperProvider
from worker_ai.providers.registry import ProviderRegistry, build_registry
from worker_ai.routing import load_routing_table, resolve_chain
from worker_ai.settings import load_settings

from .conftest import VALID_ENV

PICKER = Path(__file__).resolve().parents[2] / "web" / "components" / "projects" / "languages.ts"


def picker_tags() -> tuple[str, ...]:
    """The ``key`` of every entry in ``ALL_LANGUAGES``, parsed rather than imported."""
    source = PICKER.read_text(encoding="utf-8")
    start = source.index("export const ALL_LANGUAGES")
    end = source.index("] as const", start)
    return tuple(re.findall(r'\bkey:\s*"([^"]+)"', source[start:end]))


#: What the pipeline can put in front of a provider besides a picker tag: "auto"
#: (the clips default) and the code-mix lane LID decides on for Hinglish audio.
EXTRA_TAGS = ("auto", "hi-en")


def every_tag() -> tuple[str, ...]:
    return tuple(dict.fromkeys((*picker_tags(), *EXTRA_TAGS)))


# What each vendor documents as a valid `language_code`. Each set is limited to
# the languages this product offers, so a mapping that starts emitting anything
# else fails here and makes someone check the vendor's reference first.

try:  # faster-whisper's own list, when the local-asr extra is installed
    from faster_whisper.tokenizer import _LANGUAGE_CODES as _FASTER_WHISPER_CODES

    WHISPER_ACCEPTS = frozenset(_FASTER_WHISPER_CODES)
except ImportError:  # pragma: no cover - CI without the extra
    WHISPER_ACCEPTS = WHISPER_LANGUAGES

#: Sarvam Saaras: BCP-47 with a region, and ``unknown`` to detect.
SARVAM_ACCEPTS = frozenset(
    {
        "unknown",
        "hi-IN",
        "bn-IN",
        "kn-IN",
        "ml-IN",
        "mr-IN",
        "od-IN",
        "pa-IN",
        "ta-IN",
        "te-IN",
        "en-IN",
        "gu-IN",
        "as-IN",
        "ur-IN",
        "ne-IN",
    }
)
#: ElevenLabs Scribe: ISO-639-3; an empty code means "detect" (the field is omitted).
#: Assamese and Odia are not in the picker, but an "auto" job reaches them.
ELEVENLABS_ACCEPTS = frozenset(
    {
        "",
        "eng",
        "hin",
        "ben",
        "mar",
        "nep",
        "guj",
        "kan",
        "mal",
        "pan",
        "pus",
        "tam",
        "tel",
        "urd",
        "asm",
        "ori",
    }
)
#: AssemblyAI Universal: ISO-639-1; empty means ``language_detection: true``.
ASSEMBLYAI_ACCEPTS = frozenset(
    {"", "en", "hi", "bn", "mr", "ne", "gu", "kn", "ml", "pa", "ps", "ta", "te", "ur"}
)


def _whisper_accepts(language: str | None) -> bool:
    code = whisper_language(language)
    return code is None or code in WHISPER_ACCEPTS


#: Provider -> "does its own mapping of this tag produce something it accepts?"
ACCEPTS: dict[str, Any] = {
    "local-whisper": _whisper_accepts,
    "serverless-whisper": _whisper_accepts,
    "sarvam": lambda language: sarvam._vendor_language(language) in SARVAM_ACCEPTS,
    "elevenlabs": lambda language: elevenlabs._vendor_language(language) in ELEVENLABS_ACCEPTS,
    "assemblyai": lambda language: assemblyai._vendor_language(language) in ASSEMBLYAI_ACCEPTS,
}


def _every_provider_enabled(monkeypatch: pytest.MonkeyPatch) -> ProviderRegistry:
    monkeypatch.setattr(registry_module, "_faster_whisper_missing", lambda: None)
    return build_registry(
        load_settings(
            {
                **VALID_ENV,
                "WORKER_AI_ALLOW_MOCK": "0",
                "SARVAM_API_KEY": "k",
                "ELEVENLABS_API_KEY": "k",
                "ASSEMBLYAI_API_KEY": "k",
                "GPU_PROVIDER_URL": "https://gpu.invalid",
            }
        )
    )


def _languages_sent(tag: str) -> tuple[str | None, ...]:
    """What ``ai.transcribe`` hands a provider for a job carrying ``tag``.

    An "auto" job's probe goes out with no language. A pinned job's probe
    carries the pin, and every later chunk the LID decision, which for a pinned
    tag is the pin too. The raw tag is included as well, so a path that
    forwards it unprocessed is covered.
    """
    pinned = pinned_language(tag)
    if pinned is None:
        return (None,)
    decided = decide_language(
        acoustic=LanguageSignal(source="provider", language=""),
        textual=LanguageSignal(source="indiclid", language=""),
        hint=tag,
    ).language
    return (pinned, decided, tag)


def test_the_picker_list_is_read() -> None:
    tags = picker_tags()
    assert len(tags) >= 10
    assert {"en", "en-IN", "hi", "hi-Latn"} <= set(tags)


def test_every_provider_the_table_names_has_a_mapping_here() -> None:
    """A new provider in ``routing.yaml`` must join this contract."""
    named = {
        candidate.provider for lane in load_routing_table().lanes for candidate in lane.candidates
    }
    assert named <= set(ACCEPTS), sorted(named - set(ACCEPTS))


@pytest.mark.parametrize("tag", every_tag())
def test_every_tag_routes_and_every_provider_on_its_route_accepts_it(
    monkeypatch: pytest.MonkeyPatch, tag: str
) -> None:
    registry = _every_provider_enabled(monkeypatch)
    table = load_routing_table()
    pinned = pinned_language(tag)
    chain = resolve_chain(table, registry, language=pinned, code_mix=is_code_mix_tag(pinned))

    assert chain, tag + " routes to nothing"
    refused = [
        (decision.candidate.provider, language)
        for decision in chain
        for language in _languages_sent(tag)
        if not ACCEPTS[decision.candidate.provider](language)
    ]
    assert refused == [], tag + " is refused by " + repr(refused)


@pytest.mark.parametrize(
    ("tag", "lane"),
    [
        ("auto", "global"),
        ("en", "global"),
        ("en-IN", "indian-english"),
        ("hi", "hindi"),
        ("hi-Latn", "hindi"),
        ("hi-en", "hinglish"),
        ("bn", "indic-scribe"),
        ("ur", "indic-sarvam"),
        ("ps", "global"),
    ],
)
def test_the_lane_each_tag_starts_on(tag: str, lane: str) -> None:
    pinned = pinned_language(tag)
    assert load_routing_table().lane_for(pinned, code_mix=is_code_mix_tag(pinned)).id == lane


# ---------------------------------------------------------------------------
# "auto": LID can decide on any code Whisper detects, not just a picker tag
# ---------------------------------------------------------------------------

#: Providers that can never refuse a detection: the Whisper adapters take any
#: code Whisper knows, and Scribe's mapper sends a code it does not know as
#: auto-detect. Sarvam and AssemblyAI forward what they are given (see the
#: xfail below), so for them only "something on the route accepts it" holds.
_TAKE_ANY_DETECTION = ("local-whisper", "serverless-whisper", "elevenlabs")


def _auto_decision(code: str) -> Any:
    """What LID decides for an "auto" job whose audio Whisper labels ``code``."""
    return decide_language(
        acoustic=LanguageSignal(source="provider", language=code, confidence=0.9),
        textual=LanguageSignal(source="indiclid", language=""),
        hint="auto",
    )


@pytest.mark.parametrize("code", sorted(WHISPER_ACCEPTS))
def test_every_language_whisper_can_detect_has_a_route_that_accepts_it(
    monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    """An "auto" job can never be refused by every candidate on its route."""
    registry = _every_provider_enabled(monkeypatch)
    decision = _auto_decision(code)
    chain = resolve_chain(
        load_routing_table(), registry, language=decision.language, code_mix=decision.code_mix
    )

    assert chain, code + " routes to nothing"
    accepting = [
        d.candidate.provider for d in chain if ACCEPTS[d.candidate.provider](decision.language)
    ]
    assert accepting, code + " is refused by its whole route"
    refused = [
        d.candidate.provider
        for d in chain
        if d.candidate.provider in _TAKE_ANY_DETECTION
        and not ACCEPTS[d.candidate.provider](decision.language)
    ]
    assert refused == [], code + " is refused by " + repr(refused)


def test_sarvam_is_sent_odia_the_way_it_spells_it() -> None:
    assert sarvam._vendor_language(_auto_decision("or").language) == "od-IN"


def test_sarvam_is_asked_to_detect_a_language_it_does_not_document() -> None:
    # An auto-detected language can be anything Whisper knows.
    assert sarvam._vendor_language("fr") == "unknown"
    assert sarvam._vendor_language("hi-Latn") == "hi-IN"


class _StrictWhisper:
    """Refuses a language exactly the way faster-whisper's tokenizer does."""

    def __init__(self) -> None:
        self.languages: list[str | None] = []

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, Any]:
        language = kwargs.get("language")
        if language is not None and language not in WHISPER_ACCEPTS:
            raise ValueError(f"'{language}' is not a valid language code")
        self.languages.append(language)
        return [], type("Info", (), {"language": language or "en", "duration": 0.0})()


@pytest.mark.parametrize("tag", every_tag())
async def test_the_local_adapter_hands_whisper_a_code_it_accepts(tag: str) -> None:
    """The en-IN incident, end to end through the real adapter."""
    model = _StrictWhisper()
    provider = LocalWhisperProvider(model_factory=lambda: model)
    for language in _languages_sent(tag):
        try:
            await provider.transcribe(TranscriptionRequest(audio_uri="a.wav", language=language))
        except ProviderError as error:
            pytest.fail(repr(language) + " was refused: " + str(error))
    assert "auto" not in model.languages
