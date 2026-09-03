# `audio-assets` — Tier 0 owned audio-pack catalogue (D04a)

The licence predicate, ingestion support, and CLAP retrieval reads over
`audio_assets` (the SFX/music catalogue table D44 already added to the base
schema). No commissioned pack exists yet (A00-07), so this module and its
ingest CLI are proven against `fixtures/audio-pack/` — a dozen generated WAV
cues across the taxonomy with a manifest carrying full licence fields, in the
same shape the real pack will use.

Design references: `03-architecture/09-ai-pipeline.md` §6 "SFX & music";
`12-redesign-decisions.md` D43 (catalogue split by delivery surface), D44
(asset data model); `docs/CONTRACTS.md` §2 `PassItem`, §6 (storage keys — see
the open question in `pack-keys.ts`).

## Shape

```
pnpm --filter @montaj/api ingest:audio-pack fixtures/audio-pack/manifest.json
  → validate manifest (manifest.schema.ts)
  → measure loudness (loudness.ts, ffmpeg ebur128)
  → embed (embedder.ts: StubEmbedder by default; CLAP via worker-ai subprocess
    when CLAP_MODEL_PATH is set — H-22, no model weights on this machine)
  → upload to the derived bucket (pack-keys.ts: packs/{packId}/{assetId}.wav —
    a key docs/CONTRACTS.md §6 does not yet enumerate, flagged there)
  → idempotent upsert (audio-assets.repository.ts, keyed on
    (provider, providerAssetId))

Every retrieval path:
  assetAllowed(asset, {surface, plan, territory}) — surface/plan/territory/
  clearance/term gates, BEFORE any CLAP ranking (D43/D44) — proven by property
  tests in asset-allowed.property.test.ts.

AudioAssetsRepository.findRankedByEmbedding — pgvector `<=>` cosine ranking,
ORDER BY distance ASC, id ASC (deterministic ties), over
allows_embedding_index assets. The SFX pass itself
(apps/worker-ai/worker_ai/passes/sfx.py) re-implements the identical ranking
in Python so a worker unit test never needs Postgres; the two are kept in
lockstep by using the same distance formula (1 - cosine similarity) and the
same tie-break.
```

## What is NOT here

The `ai.pass` producer/completion wiring for `passType: "sfx"` (needs
`packages/edg`'s `PassTypeSchema`/`PassItem` schemas extended — outside this
module's file boundary), the Passes-tab SFX card, and the timeline `sfx` lane.
See the D04a entry in the root `CHANGELOG.md` for the full list of what was
built and what was deferred, and why.
