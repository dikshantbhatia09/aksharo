"""``worker_ai.passes.music`` — D05's music pass: section detection, mood
classification, BPM targeting (`analysis.py`), CLAP/mood/BPM retrieval
ranking (`retrieval.py`) and guard-respecting placement (`placement.py`).

See `worker_ai.processors.music_pass` for the `ai.pass` job wiring, and
`worker_ai.passes.sfx` for the sibling D04a/D04c pass this package mirrors.
"""

from worker_ai.passes.music.analysis import (
    MOOD_TAXONOMY,
    Section,
    bpm_target_from_cut_cadence,
    classify_mood,
    detect_sections,
)
from worker_ai.passes.music.beats import DEFAULT_BEAT_SNAP_TOLERANCE_MS, snap_start_to_beat
from worker_ai.passes.music.placement import (
    DEFAULT_FADE_IN_MS,
    DEFAULT_FADE_OUT_MS,
    DEFAULT_GAIN_DB,
    MusicItem,
    build_music_items,
)
from worker_ai.passes.music.retrieval import MusicCatalogueAsset, TextEmbedder, rank_music_assets
from worker_ai.passes.music.sentiment import (
    SentenceInput,
    SentimentSource,
    lexicon_cues,
    lexicon_score,
    score_sentiment,
)

__all__ = [
    "DEFAULT_BEAT_SNAP_TOLERANCE_MS",
    "DEFAULT_FADE_IN_MS",
    "DEFAULT_FADE_OUT_MS",
    "DEFAULT_GAIN_DB",
    "MOOD_TAXONOMY",
    "MusicCatalogueAsset",
    "MusicItem",
    "Section",
    "SentenceInput",
    "SentimentSource",
    "TextEmbedder",
    "bpm_target_from_cut_cadence",
    "build_music_items",
    "classify_mood",
    "detect_sections",
    "lexicon_cues",
    "lexicon_score",
    "rank_music_assets",
    "score_sentiment",
    "snap_start_to_beat",
]
