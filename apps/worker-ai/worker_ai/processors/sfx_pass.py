"""``ai.pass`` (`passType: "sfx"`) — D04c's producer/worker wiring over D04a's
`worker_ai.passes.sfx` (cue detection + CLAP retrieval).

Same shape as `processors/text_fx_pass.py` and `processors/autocut_pass.py`:
stateless, pure-algorithm work happens in `worker_ai.passes.sfx`, this module
only unwraps the job payload and reshapes the result for the completion
callback (`apps/api/src/passes/passes-completion.handler.ts`, which turns it
into a `MergePass` op with `kind: "sfx"` items — CONTRACTS §2's `SfxPayload`).

The worker never queries Postgres or pgvector: the producer
(`apps/api/src/passes/passes.service.ts`'s `startSfx`) already ran
`assetAllowed` over the whole `sfx` catalogue and ships the allowed rows —
id, cue type, tags, embedding, licence snapshot, pack id — directly in the
job payload as `catalogue[]`.

### Payload shape (producer: `apps/api/src/passes/passes.service.ts`)

    {
      "passId": "...", "passType": "sfx",
      "durationMs": 120000,
      "sentences": [{"startMs": 0, "endMs": 4000, "text": "...?"}],
      "emphasisWords": [{"tMs": 5000, "text": "wow"}],
      "speechRanges": [[0, 4000], [4600, 9000]],
      "rmsSamples": [],
      "cutRanges": [[1000, 1500]],
      "protectedRanges": [[5000, 6000]],
      "catalogue": [
        {"id": "...", "packId": "fixture-pack", "cueType": "impact",
         "tags": ["hit"], "embedding": [...512 floats...],
         "licenceSnapshot": {...}}
      ]
    }

`rmsSamples` rides empty in this pass (B19b's proxy-frame/RMS sampling is
wired for `zoom`/`reframe` only, `worker_ai.processors.reframe_zoom_pass`);
`detect_energy_cues` simply sees no signal, so only the word/text-derived
cue kinds (`emphasis`, `question`, `silence_gap`) fire — an explicit, reported
narrowing of `sfx.py`'s documented four-signal pipeline, not a silent one.

### Duck default

Every cue but a `silence_gap` transition beat gets D04a's `-12 dB / 150 ms`
duck (`apps/web/lib/export/engine.ts`'s `SFX_DUCK_DB`/`SFX_DUCK_RAMP_MS`,
mirrored in `apps/render/src/ffmpeg/sfx-duck-expr.ts`) — a transition cue is
placed in a silence gap by construction (D04a's `detect_silence_gap_cues`),
so there is no speech there to duck against.
"""

from __future__ import annotations

from typing import Any

from worker_ai.audio_embed import StubEmbedder
from worker_ai.callbacks import JobUsage
from worker_ai.passes.sfx import CatalogueAsset, Cue, SfxItem, build_sfx_items, detect_cues
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome

__all__ = ["process_sfx"]

_DEFAULT_DUCK = {"depthDb": -12, "attackMs": 150, "releaseMs": 150}


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


def _read_sentences(payload: dict[str, Any]) -> list[tuple[int, int, str]]:
    raw = payload.get("sentences")
    if not isinstance(raw, list):
        return []
    sentences: list[tuple[int, int, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        sentences.append(
            (
                _int(item.get("startMs"), default=0),
                _int(item.get("endMs"), default=0),
                str(item.get("text", "")),
            )
        )
    return sentences


def _read_emphasis_words(payload: dict[str, Any]) -> list[tuple[int, str]]:
    raw = payload.get("emphasisWords")
    if not isinstance(raw, list):
        return []
    words: list[tuple[int, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        words.append((_int(item.get("tMs"), default=0), str(item.get("text", ""))))
    return words


def _read_catalogue(payload: dict[str, Any]) -> tuple[list[CatalogueAsset], dict[str, str]]:
    raw = payload.get("catalogue")
    if not isinstance(raw, list):
        return [], {}
    assets: list[CatalogueAsset] = []
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
        tags_raw = item.get("tags")
        tags = tuple(str(value) for value in tags_raw) if isinstance(tags_raw, list) else ()
        licence_snapshot = item.get("licenceSnapshot")
        assets.append(
            CatalogueAsset(
                id=asset_id,
                cue_type=item.get("cueType") if isinstance(item.get("cueType"), str) else None,
                tags=tags,
                embedding=embedding,
                licence_snapshot=licence_snapshot if isinstance(licence_snapshot, dict) else {},
            )
        )
        pack_id = item.get("packId")
        if isinstance(pack_id, str) and pack_id:
            pack_by_asset[asset_id] = pack_id
    return assets, pack_by_asset


def _item_wire(item: SfxItem, pack_id: str, cue_kind: str) -> dict[str, Any]:
    """One `SfxItem` as JSON, shaped for `SfxPayloadSchema` (CONTRACTS §2)."""
    return {
        "startMs": item.start_ms,
        "endMs": item.end_ms,
        "assetId": item.asset_id,
        "packId": pack_id,
        "gainDb": item.gain_db,
        "fadeInMs": 0,
        "fadeOutMs": 0,
        "duck": None if cue_kind == "silence_gap" else dict(_DEFAULT_DUCK),
        "licenceSnapshot": item.licence_snapshot,
        "cueReason": item.reason,
        "confidence": item.confidence,
        "reason": item.reason,
    }


async def process_sfx(context: JobContext) -> ProcessorOutcome:
    payload = context.envelope.payload
    pass_id = context.payload_str("passId", required=True)
    duration_ms = _int(payload.get("durationMs"), default=0)

    sentences = _read_sentences(payload)
    emphasis_words = _read_emphasis_words(payload)
    speech_ranges = _read_ranges(payload.get("speechRanges"))
    cut_ranges = _read_ranges(payload.get("cutRanges"))
    protected_ranges = _read_ranges(payload.get("protectedRanges"))
    catalogue, pack_by_asset = _read_catalogue(payload)

    await context.progress(10, message="detecting sfx cues")
    cues: list[Cue] = detect_cues(
        rms_by_ms=[],
        emphasis_words=emphasis_words,
        sentences=sentences,
        speech_ranges=speech_ranges,
    )

    if not catalogue:
        raise JobFailureError(
            "worker/invalid_payload",
            "ai.pass (sfx) needs a non-empty catalogue[] in the job payload",
            retryable=False,
        )

    await context.progress(50, message=f"ranking {len(cues)} cues against the catalogue")
    embedder = StubEmbedder()
    items = build_sfx_items(
        cues,
        catalogue,
        embedder,
        protected_ranges=protected_ranges,
        accepted_cut_ranges=cut_ranges,
    )
    await context.progress(90, message=f"{len(items)} sfx cues proposed")

    # A cue's kind decided whether it should duck (module docstring): rebuild
    # the same cue list, ordered and rate-limited identically by
    # `build_sfx_items`, to look each item's kind back up by its start time.
    kind_by_start_ms = {cue.t_ms: cue.kind for cue in cues}

    return ProcessorOutcome(
        result={
            "passId": pass_id,
            "passType": "sfx",
            "items": [
                _item_wire(
                    item,
                    pack_by_asset.get(item.asset_id, "unknown"),
                    kind_by_start_ms.get(item.start_ms, "energy"),
                )
                for item in items
            ],
        },
        usage=JobUsage(media_seconds=duration_ms / 1000 if duration_ms else None),
    )
