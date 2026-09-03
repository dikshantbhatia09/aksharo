"""``ai.pass`` (`passType: "autocut"`) — B18's edit pass.

Like `ai.align`/`ai.transliterate`, this worker is stateless: the producer
(`apps/api/src/passes/passes.service.ts`) embeds everything the pure algorithm
in `worker_ai.passes.autocut` needs directly in the job payload — the words,
the VAD speech regions, the pacing preset, and the protection facts the EDG
already knows about (protected ranges, guarded word ids from `emphasis`/
`textOverrides` segments) — rather than this worker reading the project's
transcript or EDG itself. It never writes a row: the completion's `result`
carries the proposed items, and `PassCompletionHandler`
(`apps/api/src/passes/passes-completion.handler.ts`) turns them into a
`MergePass` op the same way `TranscribeCompletionHandler` turns `ai.transcribe`
into a persisted transcript (`transcribe.handler.ts`).

``ai.pass`` is shared across pass types (`CONTRACTS §2` `PassType`); this
processor only knows `"autocut"` and fails clearly, non-retryably, on anything
else, the same way `processors/not_implemented.py` used to own the whole queue
before this landed — B19 registers a second `passType` branch here rather than
a second queue.

Payload shape::

    {
      "passId": "...", "passType": "autocut", "preset": "standard",
      "language": "en", "durationMs": 120000,
      "words": [{"wid": "0:0", "s": 0, "e": 300, "t": "so", "scripts": {...}}],
      "speechRegions": [{"startMs": 0, "endMs": 3000}],
      "options": {"minSilenceMs": 500, "paddingMs": 80, "maxRemovalRatio": 0.3},
      "protectedRanges": [[1000, 2000]],
      "guardedWordIds": ["0:5"],
      "guardedRanges": [[5000, 6000]]
    }
"""

from __future__ import annotations

from typing import Any

from worker_ai.callbacks import JobUsage
from worker_ai.passes.autocut import (
    PADDING_MS,
    AutocutInput,
    CutCandidate,
    SpeechRegion,
    Word,
    load_lexicon,
    run_autocut,
)
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.processors.media import load_audio
from worker_ai.processors.media import speech_regions as vad_speech_regions
from worker_ai.processors.reframe_zoom_pass import process_reframe, process_zoom
from worker_ai.processors.text_fx_pass import process_text_fx

__all__ = ["process_pass"]

_SUPPORTED_PASS_TYPES = frozenset({"autocut", "zoom", "reframe", "textfx"})


async def process_pass(context: JobContext) -> ProcessorOutcome:
    """Dispatch `ai.pass` on `payload.passType`: `"autocut"` (B18),
    `"zoom"`/`"reframe"` (B19, `worker_ai.processors.reframe_zoom_pass`),
    `"textfx"` (D06, `worker_ai.processors.text_fx_pass`).
    """
    pass_type = context.payload_str("passType", default="autocut")
    if pass_type not in _SUPPORTED_PASS_TYPES:
        raise JobFailureError(
            "worker/not_implemented",
            f"ai.pass passType={pass_type!r} is not implemented",
            retryable=False,
        )
    if pass_type == "zoom":  # noqa: S105 - a pass kind, not a password
        return await process_zoom(context)
    if pass_type == "reframe":  # noqa: S105 - a pass kind, not a password
        return await process_reframe(context)
    if pass_type == "textfx":  # noqa: S105 - a pass kind, not a password
        return await process_text_fx(context)
    return await _process_autocut(context)


async def _process_autocut(context: JobContext) -> ProcessorOutcome:
    payload = context.envelope.payload
    pass_id = context.payload_str("passId", required=True)
    language = context.payload_str("language", default="en")
    duration_ms = _int(payload.get("durationMs"), default=0)

    words = _read_words(payload)
    if not words:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.pass (autocut) needs words[] in the job payload",
            retryable=False,
        )
    speech_regions = await _resolve_speech_regions(context, payload, words, duration_ms)

    await context.progress(10, message="loading lexicon")
    try:
        lexicon = load_lexicon(language)
    except (OSError, ValueError) as error:
        raise JobFailureError(
            "worker/invalid_payload",
            f"no filler lexicon for {language!r}: {error}",
            retryable=False,
        ) from error

    raw_options = payload.get("options")
    options: dict[str, Any] = raw_options if isinstance(raw_options, dict) else {}
    autocut_input = AutocutInput(
        words=words,
        speech_regions=speech_regions,
        duration_ms=duration_ms,
        preset=context.payload_str("preset", default="standard"),
        lexicon=lexicon,
        min_silence_ms=_optional_int(options.get("minSilenceMs")),
        padding_ms=_int(options.get("paddingMs"), default=80),
        max_removal_ratio=_optional_float(options.get("maxRemovalRatio")),
        protected_ranges=_read_ranges(payload.get("protectedRanges")),
        guarded_word_ids=frozenset(_read_string_list(payload.get("guardedWordIds"))),
        guarded_ranges=_read_ranges(payload.get("guardedRanges")),
    )

    await context.progress(40, message=f"running autocut ({len(words)} words)")
    result = run_autocut(autocut_input)
    await context.progress(90, message=f"{len(result.items)} cuts proposed")

    return ProcessorOutcome(
        result={
            "passId": pass_id,
            "passType": "autocut",
            "preset": result.preset.name,
            "params": {
                "minSilenceMs": result.preset.min_silence_ms,
                "maxRemovalRatio": result.preset.max_removal_ratio,
                "paddingMs": autocut_input.padding_ms,
            },
            "counts": result.counts,
            "totalRemovedMs": result.total_removed_ms,
            "totalKeptMs": result.total_kept_ms,
            "items": [_item_wire(item) for item in result.items],
        },
        usage=JobUsage(media_seconds=duration_ms / 1000 if duration_ms else None),
    )


def _item_wire(item: CutCandidate) -> dict[str, Any]:
    """One `CutCandidate` as JSON. `wordIds` travels for the API's own bookkeeping
    (protection audit, review UI hints) but never lands in `payload` on the
    `edg_pass_items` row — `CutPayloadSchema` is frozen empty (CONTRACTS §2).
    """
    return {
        "startMs": item.start_ms,
        "endMs": item.end_ms,
        "reason": item.reason,
        "confidence": item.confidence,
        "wordIds": list(item.word_ids),
    }


def _read_words(payload: dict[str, Any]) -> tuple[Word, ...]:
    raw = payload.get("words")
    if not isinstance(raw, list):
        return ()
    words: list[Word] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        wid = item.get("wid")
        if not isinstance(wid, str):
            continue
        scripts = item.get("scripts") if isinstance(item.get("scripts"), dict) else None
        words.append(
            Word(
                wid=wid,
                s=_int(item.get("s"), default=0),
                e=_int(item.get("e"), default=0),
                t=str(item.get("t", "")),
                filler=item.get("filler") if isinstance(item.get("filler"), bool) else None,
                scripts={k: str(v) for k, v in scripts.items()} if scripts else None,
            )
        )
    return tuple(words)


def _read_regions(payload: dict[str, Any]) -> tuple[SpeechRegion, ...]:
    raw = payload.get("speechRegions")
    if not isinstance(raw, list):
        return ()
    regions: list[SpeechRegion] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        regions.append(
            SpeechRegion(
                start_ms=_int(item.get("startMs"), default=0),
                end_ms=_int(item.get("endMs"), default=0),
            )
        )
    return tuple(regions)


async def _resolve_speech_regions(
    context: JobContext,
    payload: dict[str, Any],
    words: tuple[Word, ...],
    duration_ms: int,
) -> tuple[SpeechRegion, ...]:
    """Where the file's speech actually is, best signal first.

    1. Explicit `speechRegions` on the payload — the producer already has them
       (from a prior `ai.vad` run this project's transcription did) and passing
       them is free.
    2. A real VAD pass over `audio16k.wav`, the same `speech_regions()` helper
       `ai.align` uses (`processors/media.py`) — accurate, but costs a fetch and
       a decode, so it only runs when the payload names a `mediaId`.
    3. A fallback built from the words themselves: consecutive words closer than
       `PADDING_MS * 2` apart are merged into one region. Coarser than real VAD
       (it cannot see silence inside a word-free stretch that was never
       transcribed, such as room tone before the first word), but it keeps this
       processor usable — and testable — without an audio fetch.
    """
    explicit = _read_regions(payload)
    if explicit:
        return explicit

    if context.payload_str("mediaId"):
        try:
            audio = load_audio(context)
        except JobFailureError:
            pass  # fall through to the word-derived approximation
        else:
            regions = vad_speech_regions(context, audio)
            return tuple(SpeechRegion(start_ms=r.start_ms, end_ms=r.end_ms) for r in regions)

    return _regions_from_words(words, duration_ms)


def _regions_from_words(words: tuple[Word, ...], duration_ms: int) -> tuple[SpeechRegion, ...]:
    if not words:
        return ()
    ordered = sorted(words, key=lambda word: word.s)
    merge_gap_ms = PADDING_MS * 2
    regions: list[SpeechRegion] = []
    start, end = ordered[0].s, ordered[0].e
    for word in ordered[1:]:
        if word.s - end <= merge_gap_ms:
            end = max(end, word.e)
        else:
            regions.append(SpeechRegion(start_ms=start, end_ms=min(end, duration_ms)))
            start, end = word.s, word.e
    regions.append(SpeechRegion(start_ms=start, end_ms=min(end, duration_ms)))
    return tuple(regions)


def _read_ranges(raw: Any) -> tuple[tuple[int, int], ...]:
    if not isinstance(raw, list):
        return ()
    ranges: list[tuple[int, int]] = []
    for item in raw:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            ranges.append((_int(item[0], default=0), _int(item[1], default=0)))
        elif isinstance(item, dict) and "startMs" in item and "endMs" in item:
            ranges.append((_int(item["startMs"], default=0), _int(item["endMs"], default=0)))
    return tuple(ranges)


def _read_string_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if isinstance(item, str)]


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def _optional_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None
