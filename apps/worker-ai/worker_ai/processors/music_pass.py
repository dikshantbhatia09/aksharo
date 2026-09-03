"""``ai.pass`` (`passType: "music"`) — D05's producer/worker wiring over
`worker_ai.passes.music` (section detection, mood/BPM analysis, retrieval,
placement).

Same shape as `processors/sfx_pass.py`: stateless, pure-algorithm work
happens in `worker_ai.passes.music`, this module only unwraps the job
payload and reshapes the result for the completion callback
(`apps/api/src/passes/passes-completion.handler.ts`, which turns it into a
`MergePass` op with `kind: "music"` items — CONTRACTS §2's `MusicPayload`
amendment 2026-09-03).

The worker never queries Postgres or pgvector: the producer
(`apps/api/src/passes/passes.service.ts`'s `startMusic`) already ran
`assetAllowed` over the whole `music` catalogue and ships the allowed rows —
id, mood, bpm, loop-point metadata, embedding, licence snapshot, pack id —
directly in the job payload as `catalogue[]`, the same split `sfx_pass.py`
uses.

### Payload shape (producer: `apps/api/src/passes/passes.service.ts`)

    {
      "passId": "...", "passType": "music",
      "durationMs": 120000,
      "language": "en", "region": "in",
      "speechRanges": [[0, 4000], [4600, 9000]],
      "cutTimesMs": [1000, 15000, 15400],
      "sentences": [{"startMs": 1800, "endMs": 2200, "text": "..."}],
      "protectedRanges": [[5000, 6000]],
      "catalogue": [
        {"id": "...", "packId": "fixture-pack", "mood": ["upbeat"], "bpm": 128,
         "embedding": [...512 floats...], "licenceSnapshot": {...},
         "introMs": 800, "outroMs": 1200, "durationMs": 42000}
      ]
    }

`sentences` (D05 follow-up, brief §2) is scored in-process by
`worker_ai.passes.music.sentiment.score_sentiment`, through B11's LLM client
seam (`music-mood@1`) with the deterministic lexicon scorer as its offline
fallback — CONTRACTS' "all AI runs in apps/worker-ai" is why that scoring
happens here rather than in `apps/api`, unlike the old lexicon-only stand-in
this replaces. `detect_sections` still only ever reads a plain `(tMs, score)`
list regardless of where it came from, plus the `source` this module stamps
onto the run's `Section`s.

### Bed duck

Every accepted music item gets the same duck curve `sfx_pass.py` uses for a
non-transition cue (`-12 dB / 150 ms`, `MusicPayload.bedDuck` — CONTRACTS §2
amendment): a music bed always plays under speech somewhere in its section,
unlike an `sfx` transition cue placed inside a silence gap.
"""

from __future__ import annotations

from typing import Any

from worker_ai.audio_embed import StubEmbedder
from worker_ai.callbacks import JobUsage
from worker_ai.passes.music import (
    MusicCatalogueAsset,
    MusicItem,
    SentenceInput,
    bpm_target_from_cut_cadence,
    build_music_items,
    detect_sections,
    score_sentiment,
)
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome

__all__ = ["process_music"]

_DEFAULT_BED_DUCK = {"depthDb": -12, "attackMs": 150, "releaseMs": 150}


def _int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def _read_ranges(raw: Any) -> list[tuple[int, int]]:
    if not isinstance(raw, list):
        return []
    ranges: list[tuple[int, int]] = []
    for item in raw:
        if isinstance(item, list) and len(item) == 2:
            ranges.append((_int(item[0], default=0), _int(item[1], default=0)))
    return ranges


def _read_cut_times(payload: dict[str, Any]) -> list[int]:
    raw = payload.get("cutTimesMs")
    if not isinstance(raw, list):
        return []
    return [_int(value, default=0) for value in raw if isinstance(value, (int, float))]


def _read_sentences(payload: dict[str, Any]) -> list[SentenceInput]:
    raw = payload.get("sentences")
    if not isinstance(raw, list):
        return []
    sentences: list[SentenceInput] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if not isinstance(text, str):
            continue
        sentences.append(
            SentenceInput(
                start_ms=_int(item.get("startMs"), default=0),
                end_ms=_int(item.get("endMs"), default=0),
                text=text,
            )
        )
    return sentences


def _read_catalogue(payload: dict[str, Any]) -> tuple[list[MusicCatalogueAsset], dict[str, str]]:
    raw = payload.get("catalogue")
    if not isinstance(raw, list):
        return [], {}
    assets: list[MusicCatalogueAsset] = []
    pack_by_asset: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        asset_id = str(item.get("id", ""))
        if not asset_id:
            continue
        embedding_raw = item.get("embedding")
        embedding = (
            tuple(float(value) for value in embedding_raw)
            if isinstance(embedding_raw, list)
            else ()
        )
        mood_raw = item.get("mood")
        mood = tuple(str(value) for value in mood_raw) if isinstance(mood_raw, list) else ()
        bpm = item.get("bpm")
        licence_snapshot = item.get("licenceSnapshot")
        assets.append(
            MusicCatalogueAsset(
                id=asset_id,
                mood=mood,
                bpm=_optional_int(bpm),
                embedding=embedding,
                licence_snapshot=licence_snapshot if isinstance(licence_snapshot, dict) else {},
                intro_ms=_optional_int(item.get("introMs")),
                outro_ms=_optional_int(item.get("outroMs")),
                duration_ms=_optional_int(item.get("durationMs")),
            )
        )
        pack_id = item.get("packId")
        if isinstance(pack_id, str) and pack_id:
            pack_by_asset[asset_id] = pack_id
    return assets, pack_by_asset


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def _item_wire(item: MusicItem, pack_id: str) -> dict[str, Any]:
    """One `MusicItem` as JSON, shaped for `MusicPayloadSchema` (CONTRACTS §2
    amendment 2026-09-03)."""
    wire: dict[str, Any] = {
        "startMs": item.start_ms,
        "endMs": item.end_ms,
        "assetId": item.asset_id,
        "packId": pack_id,
        "gainDb": item.gain_db,
        "loopPolicy": item.loop_policy,
        "bedDuck": dict(_DEFAULT_BED_DUCK),
        "licenceSnapshot": item.licence_snapshot,
        "mood": list(item.mood),
        "confidence": item.confidence,
        "reason": item.reason,
    }
    if item.bpm is not None:
        wire["bpm"] = item.bpm
    return wire


async def process_music(context: JobContext) -> ProcessorOutcome:
    payload = context.envelope.payload
    pass_id = context.payload_str("passId", required=True)
    duration_ms = _int(payload.get("durationMs"), default=0)

    speech_ranges = _read_ranges(payload.get("speechRanges"))
    cut_ranges = _read_ranges(payload.get("cutRanges"))
    protected_ranges = _read_ranges(payload.get("protectedRanges"))
    cut_times_ms = _read_cut_times(payload) or [start for start, _ in cut_ranges]
    sentences = _read_sentences(payload)
    language = context.payload_str("language", default="en") or "en"
    region = context.payload_str("region", default="in") or "in"
    catalogue, pack_by_asset = _read_catalogue(payload)

    await context.progress(10, message="scoring sentiment")
    sentiment, sentiment_source = await score_sentiment(
        sentences,
        llm_providers=context.services.llm_providers,
        region=region,
        language=language,
        duration_ms=duration_ms,
    )

    await context.progress(30, message="detecting music sections")
    sections = detect_sections(
        duration_ms=duration_ms,
        speech_ranges=speech_ranges,
        cut_times_ms=cut_times_ms,
        sentiment_by_ms=sentiment,
        sentiment_source=sentiment_source,
    )
    bpm_target = bpm_target_from_cut_cadence(cut_times_ms)

    if not catalogue:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.pass (music) needs a non-empty catalogue[] in the job payload",
            retryable=False,
        )

    await context.progress(
        50, message=f"ranking {len(sections)} sections against the catalogue"
    )
    embedder = StubEmbedder()
    items = build_music_items(
        sections,
        catalogue,
        embedder,
        bpm_target=bpm_target,
        protected_ranges=protected_ranges,
    )
    await context.progress(90, message=f"{len(items)} music beds proposed")

    return ProcessorOutcome(
        result={
            "passId": pass_id,
            "passType": "music",
            "bpmTarget": bpm_target,
            # Additive, not part of `MusicPayload` (CONTRACTS §2): worker-side
            # observability for which sentiment source this run actually used.
            "sentimentSource": sentiment_source,
            "items": [
                _item_wire(item, pack_by_asset.get(item.asset_id, "unknown")) for item in items
            ],
        },
        usage=JobUsage(media_seconds=duration_ms / 1000 if duration_ms else None),
    )
