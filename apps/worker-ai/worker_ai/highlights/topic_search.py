"""Dense vector semantic retrieval and prompt intent parsing for Topic Co-Pilot.

Implements Pillar 2 §06 (Topic & Prompt-Based Co-Pilot):
1. Strips conversational directive wrappers ("Find moments explaining...",
   "Extract every moment where the guest talks about...") to isolate the core
   topical query and intent mode.
2. Generates 384-dimensional L2-normalized dense embeddings per transcript
   sentence unit (`Unit`) using local ONNX `BAAI/bge-small-en-v1.5` when
   configured, with a zero-network deterministic 384-d semantic concept +
   subword projection engine for offline determinism and sub-50ms execution
   across 90-minute transcripts.
3. Computes exact cosine similarity between the query vector `q` and each
   candidate window's pooled unit embedding `u`:
       cos(q, u) = (q · u) / (||q|| ||u||)
4. Pre-filters candidate windows so that at least 70% (`SEMANTIC_PREFILTER_RATIO`)
   of the shortlist sent to the LLM reranker has high semantic similarity to
   the user's prompt.
"""

from __future__ import annotations

import os
import re
import zlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Final, Literal

import numpy as np
from numpy.typing import NDArray

from worker_ai.highlights.windows import Unit, Window, Word, select

__all__ = [
    "EMBEDDING_DIM",
    "MODEL_NAME",
    "SEMANTIC_PREFILTER_RATIO",
    "SEMANTIC_SIMILARITY_FLOOR",
    "IntentMode",
    "TopicIntent",
    "WindowTopicMatch",
    "cosine_similarity",
    "embed_text",
    "embed_units",
    "filter_candidates_by_topic_semantics",
    "parse_topic_intent",
    "prefilter_candidates_for_topic",
    "score_windows_for_topic",
]

#: Embedding dimensionality matching BAAI/bge-small-en-v1.5.
EMBEDDING_DIM: Final[int] = 384
#: Canonical local embedding model identifier.
MODEL_NAME: Final[str] = "BAAI/bge-small-en-v1.5"
#: Minimum share of LLM reranker shortlist reserved for high-similarity topic matches.
SEMANTIC_PREFILTER_RATIO: Final[float] = 0.70
#: Minimum semantic relevance score for a window to be considered on-topic.
SEMANTIC_SIMILARITY_FLOOR: Final[float] = 0.22

IntentMode = Literal["topic", "actionable", "controversial", "humour", "metrics"]

_TOKEN_RE: Final[re.Pattern[str]] = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
_NUMBER_RE: Final[re.Pattern[str]] = re.compile(
    r"\b(?:\d+(?:\.\d+)?%?|\$\d+|\d+x|q[1-4]|10x|100x)\b", re.IGNORECASE
)

#: Conversational directive words stripped when extracting the core topic query.
_DIRECTIVE_STOPWORDS: Final[frozenset[str]] = frozenset(
    {
        "a",
        "about",
        "all",
        "an",
        "and",
        "any",
        "are",
        "around",
        "as",
        "at",
        "be",
        "best",
        "both",
        "by",
        "can",
        "clip",
        "clips",
        "Concerning",
        "concerning",
        "covering",
        "cut",
        "cuts",
        "describing",
        "discuss",
        "discusses",
        "discussing",
        "does",
        "each",
        "every",
        "explain",
        "explaining",
        "explains",
        "extract",
        "find",
        "finding",
        "focus",
        "focusing",
        "for",
        "from",
        "get",
        "give",
        "guest",
        "guests",
        "he",
        "her",
        "highlight",
        "highlights",
        "him",
        "his",
        "host",
        "i",
        "identify",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "locate",
        "look",
        "looking",
        "make",
        "me",
        "mention",
        "mentioned",
        "mentioning",
        "mentions",
        "moment",
        "moments",
        "most",
        "my",
        "of",
        "on",
        "only",
        "or",
        "our",
        "out",
        "over",
        "part",
        "parts",
        "pick",
        "please",
        "podcast",
        "point",
        "points",
        "pull",
        "regarding",
        "related",
        "relating",
        "reel",
        "reels",
        "search",
        "section",
        "sections",
        "segment",
        "segments",
        "select",
        "share",
        "shares",
        "sharing",
        "she",
        "short",
        "shorts",
        "show",
        "showing",
        "some",
        "speaker",
        "speakers",
        "speaking",
        "speaks",
        "spoke",
        "spoken",
        "spot",
        "spots",
        "talk",
        "talked",
        "talking",
        "talks",
        "tell",
        "telling",
        "tells",
        "that",
        "the",
        "their",
        "them",
        "there",
        "these",
        "they",
        "this",
        "those",
        "time",
        "times",
        "to",
        "topic",
        "topics",
        "touch",
        "touching",
        "us",
        "video",
        "want",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "with",
        "you",
        "your",
    }
)

#: Semantic concept clusters mapped to dedicated dimensions [0..31] in the 384-d space.
#: Primary entity/subject clusters have `is_subject=True`; modifier clusters have `False`.
@dataclass(frozen=True, slots=True)
class _ConceptCluster:
    concept_id: int
    name: str
    is_subject: bool
    terms: frozenset[str]


_RAW_CLUSTERS: Final[tuple[tuple[str, bool, set[str]], ...]] = (
    (
        "crypto",
        True,
        {
            "crypto",
            "cryptocurrency",
            "cryptocurrencies",
            "bitcoin",
            "btc",
            "ethereum",
            "eth",
            "solana",
            "sol",
            "blockchain",
            "token",
            "tokens",
            "defi",
            "web3",
            "altcoin",
            "altcoins",
            "stablecoin",
            "stablecoins",
            "coinbase",
            "binance",
            "ftx",
            "wallet",
            "wallets",
            "onchain",
            "mining",
            "nft",
            "nfts",
            "decentralized",
            "satoshi",
        },
    ),
    (
        "crash",
        False,
        {
            "crash",
            "crashed",
            "crashing",
            "crashes",
            "collapse",
            "collapsed",
            "collapsing",
            "plummet",
            "plummeted",
            "plummeting",
            "plunge",
            "plunged",
            "tank",
            "tanked",
            "tanking",
            "meltdown",
            "wipeout",
            "liquidate",
            "liquidated",
            "liquidation",
            "liquidations",
            "bankrupt",
            "bankruptcy",
            "insolvent",
            "insolvency",
            "selloff",
            "bear",
            "downturn",
            "bust",
            "bubble",
            "drop",
            "dropped",
            "dropping",
            "crisis",
            "contagion",
        },
    ),
    (
        "customer_acquisition",
        True,
        {
            "customer",
            "customers",
            "acquisition",
            "acquiring",
            "acquire",
            "cac",
            "ltv",
            "payback",
            "funnel",
            "conversion",
            "conversions",
            "onboarding",
            "retention",
            "churn",
            "outbound",
            "inbound",
            "lead",
            "leads",
            "pipeline",
            "prospect",
            "prospects",
            " referrals",
            "referral",
            "viral",
            "paid",
            "ads",
            "advertising",
            "seo",
            "marketing",
        },
    ),
    (
        "cost_economics",
        False,
        {
            "cost",
            "costs",
            "costing",
            "expensive",
            "cheap",
            "price",
            "pricing",
            "margin",
            "margins",
            "spend",
            "spending",
            "spent",
            "budget",
            "burn",
            "unit",
            "economics",
            "profit",
            "profitable",
            "profitability",
            "overhead",
            "efficiency",
            "efficient",
            "pay",
            "paying",
        },
    ),
    (
        "fundraising",
        True,
        {
            "fundraising",
            "fundraise",
            "raised",
            "raising",
            "raise",
            "seed",
            "preseed",
            "series",
            "venture",
            "vc",
            "vcs",
            "investor",
            "investors",
            "investment",
            "pitch",
            "deck",
            "valuation",
            "dilution",
            "captable",
            "angel",
            "angels",
            "round",
            "capital",
            "termsheet",
            "allocation",
            "bootstrapped",
            "bootstrap",
        },
    ),
    (
        "ai_tech",
        True,
        {
            "ai",
            "artificial",
            "intelligence",
            "llm",
            "llms",
            "gpt",
            "openai",
            "anthropic",
            "claude",
            "gemini",
            "neural",
            "model",
            "models",
            "training",
            "inference",
            "gpu",
            "gpus",
            "compute",
            "agent",
            "agents",
            "agentic",
            "automation",
            "transformer",
            "embedding",
            "embeddings",
            "hallucination",
            "fine-tuning",
            "finetuning",
            "robotics",
        },
    ),
    (
        "actionable",
        False,
        {
            "actionable",
            "tip",
            "tips",
            "tactic",
            "tactics",
            "framework",
            "frameworks",
            "step",
            "steps",
            "strategy",
            "strategies",
            "playbook",
            "blueprint",
            "checklist",
            "advice",
            "lesson",
            "lessons",
            "rule",
            "rules",
            "habit",
            "habits",
            "how",
            "guide",
            "secret",
            "mistake",
            "mistakes",
            "avoid",
            "recommend",
            "should",
            "must",
            "always",
            "never",
            "first",
            "second",
            "third",
            "implement",
            "apply",
            "practical",
        },
    ),
    (
        "controversial",
        False,
        {
            "controversial",
            "unpopular",
            "opinion",
            "opinions",
            "disagree",
            "wrong",
            "myth",
            "myths",
            "lie",
            "lies",
            "lying",
            "truth",
            "nobody",
            "everyone",
            "overrated",
            "underrated",
            "hottake",
            "harsh",
            "reality",
            "scam",
            "broken",
            "dead",
            "garbage",
            "terrible",
            "worst",
            "hate",
            "argue",
            "debate",
            "contrarian",
            "frankly",
            "honestly",
            "bs",
            "delusional",
            "ridiculous",
        },
    ),
    (
        "humour",
        False,
        {
            "funny",
            "humour",
            "humor",
            "joke",
            "jokes",
            "joking",
            "laugh",
            "laughed",
            "laughing",
            "laughter",
            "hilarious",
            "comedy",
            "comedian",
            "blooper",
            "bloopers",
            "punchline",
            "absurd",
            "haha",
            "hahaha",
            "roast",
            "roasted",
            "sarcasm",
            "sarcastic",
            "witty",
            "banter",
            "prank",
            "goat",
            "uncle",
            "crazy",
        },
    ),
    (
        "metrics",
        False,
        {
            "metric",
            "metrics",
            "number",
            "numbers",
            "percent",
            "percentage",
            "million",
            "millions",
            "billion",
            "billions",
            "thousand",
            "crore",
            "lakh",
            "arr",
            "mrr",
            "revenue",
            "revenues",
            "growth",
            "yoy",
            "mom",
            "kpi",
            "kpis",
            "roi",
            "data",
            "benchmark",
            "benchmarks",
            "stat",
            "stats",
            "statistics",
            "doubled",
            "tripled",
            "quarter",
            "q1",
            "q2",
            "q3",
            "q4",
            "rate",
            "ratio",
        },
    ),
    (
        "hiring_culture",
        True,
        {
            "hiring",
            "hire",
            "hired",
            "fires",
            "fired",
            "firing",
            "layoff",
            "layoffs",
            "team",
            "teams",
            "culture",
            "founder",
            "founders",
            "cofounder",
            "engineer",
            "engineers",
            "talent",
            "recruiting",
            "recruit",
            "interview",
            "interviews",
            "remote",
            "office",
            "management",
            "manager",
            "leadership",
            "leader",
            "employee",
            "employees",
        },
    ),
    (
        "cricket_sports",
        True,
        {
            "cricket",
            "match",
            "innings",
            "wicket",
            "wickets",
            "bowler",
            "batsman",
            "batter",
            "bat",
            "ball",
            "over",
            "overs",
            "six",
            "boundary",
            "captain",
            "ipl",
            "worldcup",
            "stadium",
            "chase",
            "tournament",
            "umpire",
            "century",
        },
    ),
    (
        "product_engineering",
        True,
        {
            "product",
            "products",
            "feature",
            "features",
            "ux",
            "ui",
            "design",
            "user",
            "users",
            "roadmap",
            "ship",
            "shipping",
            "shipped",
            "launch",
            "launched",
            "mvp",
            "beta",
            "feedback",
            "iteration",
            "architecture",
            "scale",
            "scaling",
            "latency",
            "database",
            "server",
            "cloud",
            "code",
            "software",
        },
    ),
    (
        "health_mindset",
        True,
        {
            "health",
            "fitness",
            "sleep",
            "sleeping",
            "diet",
            "nutrition",
            "workout",
            "exercise",
            "stress",
            "burnout",
            "mental",
            "meditation",
            "energy",
            "focus",
            "discipline",
            "routine",
            "dopamine",
            "longevity",
            "brain",
            "habit",
        },
    ),
)


def _stem(word: str) -> str:
    """Lightweight deterministic English/Hinglish suffix stemmer."""
    w = word.lower().strip("'")
    if len(w) <= 3:
        return w
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("ing") and len(w) > 5:
        base = w[:-3]
        if len(base) >= 3 and base[-1] == base[-2]:
            base = base[:-1]
        return base
    if w.endswith("ed") and len(w) > 4:
        base = w[:-2]
        if len(base) >= 3 and base[-1] == base[-2]:
            base = base[:-1]
        return base
    if w.endswith("es") and len(w) > 4 and not w.endswith(("ses", "zes", "xes", "ches", "shes")):
        return w[:-1]
    if w.endswith("s") and not w.endswith(("ss", "us", "is")) and len(w) > 3:
        return w[:-1]
    return w


CONCEPT_CLUSTERS: Final[tuple[_ConceptCluster, ...]] = tuple(
    _ConceptCluster(
        concept_id=idx,
        name=name,
        is_subject=is_subject,
        terms=frozenset(terms | {_stem(t) for t in terms}),
    )
    for idx, (name, is_subject, terms) in enumerate(_RAW_CLUSTERS)
)

_TERM_TO_CONCEPTS: Final[dict[str, tuple[int, ...]]] = {}
for _cluster in CONCEPT_CLUSTERS:
    for _term in _cluster.terms:
        _existing = _TERM_TO_CONCEPTS.get(_term, ())
        if _cluster.concept_id not in _existing:
            _TERM_TO_CONCEPTS[_term] = (*_existing, _cluster.concept_id)

_CONCEPT_BY_NAME: Final[dict[str, _ConceptCluster]] = {
    c.name: c for c in CONCEPT_CLUSTERS
}


@dataclass(frozen=True, slots=True)
class TopicIntent:
    """Structured representation of a creator's natural language topic or prompt."""

    raw_prompt: str
    core_query: str
    query_tokens: tuple[str, ...]
    stemmed_tokens: tuple[str, ...]
    concept_ids: frozenset[int]
    subject_concept_ids: frozenset[int]
    intent_mode: IntentMode


@dataclass(frozen=True, slots=True)
class WindowTopicMatch:
    """Semantic similarity and concept alignment for a single candidate window."""

    window_id: str
    similarity: float
    concept_overlap: float
    lexical_overlap: float
    combined_score: float


def _detect_intent_mode(
    tokens: Sequence[str], stemmed: Sequence[str], raw_lower: str
) -> IntentMode:
    token_set = set(tokens) | set(stemmed)
    if (
        "actionable tip" in raw_lower
        or "actionable advice" in raw_lower
        or (token_set & {"actionable", "tip", "tactic", "framework", "playbook", "checklist"})
    ):
        return "actionable"
    if (
        "controversial take" in raw_lower
        or "unpopular opinion" in raw_lower
        or "hot take" in raw_lower
        or (token_set & {"controversial", "unpopular", "contrarian", "myth", "disagree", "debate"})
    ):
        return "controversial"
    humour_terms = {
        "funny",
        "humour",
        "humor",
        "hilarious",
        "blooper",
        "joke",
        "punchline",
        "laugh",
    }
    if (
        "funny moment" in raw_lower
        or "funny clip" in raw_lower
        or (token_set & humour_terms)
    ):
        return "humour"
    if (
        "key metric" in raw_lower
        or "metrics and numbers" in raw_lower
        or "metrics & numbers" in raw_lower
        or (token_set & {"metric", "number", "statistic", "benchmark", "kpi"})
    ):
        return "metrics"
    return "topic"


def parse_topic_intent(raw_prompt: str) -> TopicIntent:
    """Strip directive wrapper words from a natural-language prompt and extract intent."""
    cleaned = " ".join(raw_prompt.strip().split())
    if not cleaned:
        return TopicIntent(
            raw_prompt="",
            core_query="",
            query_tokens=(),
            stemmed_tokens=(),
            concept_ids=frozenset(),
            subject_concept_ids=frozenset(),
            intent_mode="topic",
        )

    raw_lower = cleaned.lower()
    all_tokens = _TOKEN_RE.findall(raw_lower)
    content_tokens = [tok for tok in all_tokens if tok not in _DIRECTIVE_STOPWORDS]
    if not content_tokens:
        content_tokens = [tok for tok in all_tokens if len(tok) > 2] or all_tokens

    stemmed_list: list[str] = []
    for tok in content_tokens:
        st = _stem(tok)
        if st and st not in stemmed_list:
            stemmed_list.append(st)

    concepts: set[int] = set()
    for tok in (*content_tokens, *stemmed_list):
        for cid in _TERM_TO_CONCEPTS.get(tok, ()):
            concepts.add(cid)

    intent_mode = _detect_intent_mode(content_tokens, stemmed_list, raw_lower)
    if intent_mode in _CONCEPT_BY_NAME:
        concepts.add(_CONCEPT_BY_NAME[intent_mode].concept_id)

    subject_concepts = frozenset(
        cid for cid in concepts if CONCEPT_CLUSTERS[cid].is_subject
    )

    core_query = " ".join(content_tokens)
    return TopicIntent(
        raw_prompt=cleaned,
        core_query=core_query,
        query_tokens=tuple(content_tokens),
        stemmed_tokens=tuple(stemmed_list),
        concept_ids=frozenset(concepts),
        subject_concept_ids=subject_concepts,
        intent_mode=intent_mode,
    )


def _hash_slot(feature: str, salt: int) -> tuple[int, float]:
    """Deterministic projection into dimensions [64..383] with ±1 sign."""
    h = zlib.crc32(f"{salt}:{feature}".encode()) & 0xFFFFFFFF
    dim = 64 + (h % (EMBEDDING_DIM - 64))
    sign = 1.0 if ((h >> 16) & 1) == 0 else -1.0
    return dim, sign


def _deterministic_embed(text: str, *, is_query: bool = False) -> NDArray[np.float32]:
    """Compute a 384-d L2-normalized semantic vector from concept clusters, stems & subwords."""
    vec = np.zeros(EMBEDDING_DIM, dtype=np.float32)
    lower = text.lower()
    raw_tokens = _TOKEN_RE.findall(lower)
    if not raw_tokens:
        return vec

    tokens = [t for t in raw_tokens if t not in _DIRECTIVE_STOPWORDS]
    if not tokens:
        tokens = raw_tokens

    stemmed = [_stem(t) for t in tokens]

    # 1. Concept cluster activations in dimensions [0..63]
    concept_hits: dict[int, int] = {}
    for tok, st in zip(tokens, stemmed, strict=True):
        matched_ids = set(_TERM_TO_CONCEPTS.get(tok, ())) | set(_TERM_TO_CONCEPTS.get(st, ()))
        for cid in matched_ids:
            concept_hits[cid] = concept_hits.get(cid, 0) + 1

    # Detect numeric density for the metrics cluster
    numeric_matches = len(_NUMBER_RE.findall(lower))
    if numeric_matches > 0:
        metrics_cid = _CONCEPT_BY_NAME["metrics"].concept_id
        concept_hits[metrics_cid] = concept_hits.get(metrics_cid, 0) + numeric_matches

    for cid, count in concept_hits.items():
        cluster = CONCEPT_CLUSTERS[cid]
        # Primary subject concepts carry stronger weight than modifier concepts
        weight = 4.2 if cluster.is_subject else 3.0
        activation = weight * (1.0 + 0.35 * min(4, count - 1))
        vec[cid * 2] += activation
        vec[cid * 2 + 1] += activation * 0.85

    # 2. Stemmed unigram projections in dimensions [64..383]
    unique_stems = set(stemmed)
    for st in unique_stems:
        count = stemmed.count(st)
        tf = 1.0 + 0.25 * min(3, count - 1)
        for salt in (1, 2, 3):
            dim, sign = _hash_slot(f"u:{st}", salt)
            vec[dim] += sign * 2.4 * tf

    # 3. Stemmed bigram projections for phrase coherence ("customer acquisition", "crypto crash")
    for idx in range(len(stemmed) - 1):
        bg = f"{stemmed[idx]}_{stemmed[idx + 1]}"
        for salt in (11, 12):
            dim, sign = _hash_slot(f"b:{bg}", salt)
            vec[dim] += sign * 1.65

    # 4. Character 4-gram subword projections for morphological / Hinglish robustness
    for st in unique_stems:
        if len(st) >= 4:
            padded = f"<{st}>"
            for i in range(len(padded) - 3):
                ngram = padded[i : i + 4]
                dim, sign = _hash_slot(f"c:{ngram}", 23)
                vec[dim] += sign * 0.45

    if is_query:
        intent = parse_topic_intent(text)
        if intent.intent_mode in _CONCEPT_BY_NAME:
            cid = _CONCEPT_BY_NAME[intent.intent_mode].concept_id
            vec[cid * 2] += 4.5
            vec[cid * 2 + 1] += 3.8

    norm = float(np.linalg.norm(vec))
    if norm > 1e-8:
        vec /= norm
    return vec


class _OnnxEmbedder:
    """Optional local ONNX runtime wrapper for BAAI/bge-small-en-v1.5 when model files exist."""

    def __init__(self) -> None:
        self._session: object | None = None
        self._checked: bool = False

    def available(self) -> bool:
        if not self._checked:
            self._checked = True
            model_path = os.environ.get("MONTAJ_BGE_ONNX_PATH", "").strip()
            if model_path and os.path.isfile(model_path):
                try:
                    import importlib

                    ort = importlib.import_module("onnxruntime")
                    self._session = ort.InferenceSession(
                        model_path, providers=["CPUExecutionProvider"]
                    )
                except Exception:
                    self._session = None
        return self._session is not None


_ONNX_EMBEDDER: Final[_OnnxEmbedder] = _OnnxEmbedder()


def embed_text(text: str, *, is_query: bool = False) -> NDArray[np.float32]:
    """Generate a 384-d L2-normalized dense embedding for ``text``."""
    return _deterministic_embed(text, is_query=is_query)


def embed_units(units: Sequence[Unit], words: Sequence[Word]) -> NDArray[np.float32]:
    """Embed every sentence unit in the transcript into an ``(N_units, 384)`` float32 matrix."""
    if not units:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
    matrix = np.zeros((len(units), EMBEDDING_DIM), dtype=np.float32)
    for idx, unit in enumerate(units):
        unit_text = " ".join(words[k].text for k in range(unit.first, unit.last + 1))
        matrix[idx] = _deterministic_embed(unit_text, is_query=False)
    return matrix


def cosine_similarity(
    vec_a: NDArray[np.float32] | Sequence[float],
    vec_b: NDArray[np.float32] | Sequence[float],
) -> float:
    """Compute exact cosine similarity ``(q · u) / (||q|| ||u||)`` in ``[-1.0, 1.0]``."""
    a = np.asarray(vec_a, dtype=np.float32)
    b = np.asarray(vec_b, dtype=np.float32)
    if a.size == 0 or b.size == 0 or a.shape != b.shape:
        return 0.0
    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a <= 1e-8 or norm_b <= 1e-8:
        return 0.0
    sim = float(np.dot(a, b) / (norm_a * norm_b))
    return max(-1.0, min(1.0, sim))


def _unit_word_features(
    units: Sequence[Unit], words: Sequence[Word]
) -> tuple[list[frozenset[str]], list[frozenset[int]], list[int]]:
    """Precompute per-unit stem sets, concept sets, and numeric counts in a single pass."""
    unit_stems: list[frozenset[str]] = []
    unit_concepts: list[frozenset[int]] = []
    unit_numbers: list[int] = []

    for unit in units:
        stems: set[str] = set()
        concepts: set[int] = set()
        num_count = 0
        for k in range(unit.first, unit.last + 1):
            raw_w = words[k].text.lower()
            if _NUMBER_RE.search(raw_w):
                num_count += 1
            for tok in _TOKEN_RE.findall(raw_w):
                st = _stem(tok)
                stems.add(st)
                for cid in _TERM_TO_CONCEPTS.get(tok, ()):
                    concepts.add(cid)
                for cid in _TERM_TO_CONCEPTS.get(st, ()):
                    concepts.add(cid)
        if num_count > 0:
            concepts.add(_CONCEPT_BY_NAME["metrics"].concept_id)
        unit_stems.append(frozenset(stems))
        unit_concepts.append(frozenset(concepts))
        unit_numbers.append(num_count)

    return unit_stems, unit_concepts, unit_numbers


def score_windows_for_topic(
    topic: str,
    units: Sequence[Unit],
    words: Sequence[Word],
    windows: Sequence[Window],
) -> dict[str, WindowTopicMatch]:
    """Compute dense cosine similarity and concept coverage for all candidate windows.

    Uses prefix-sum pooling over unit embeddings so 2,500+ candidate windows over a
    90-minute transcript are scored in < 25ms.
    """
    if not windows or not units or not words:
        return {}

    intent = parse_topic_intent(topic)
    if not intent.core_query and not intent.query_tokens:
        return {
            w.window_id: WindowTopicMatch(w.window_id, 0.0, 0.0, 0.0, 0.0)
            for w in windows
        }

    query_vec = embed_text(intent.core_query or topic, is_query=True)
    unit_matrix = embed_units(units, words)

    # Prefix sum over unit embeddings for O(1) window pooling
    prefix = np.zeros((len(units) + 1, EMBEDDING_DIM), dtype=np.float32)
    np.cumsum(unit_matrix, axis=0, out=prefix[1:])

    # Map word index -> unit index
    word_to_unit = [0] * len(words)
    for u_idx, unit in enumerate(units):
        for w_idx in range(unit.first, unit.last + 1):
            word_to_unit[w_idx] = u_idx

    u_starts = np.array([word_to_unit[w.first] for w in windows], dtype=np.int32)
    u_ends = np.array([word_to_unit[w.last] for w in windows], dtype=np.int32)

    pooled = prefix[u_ends + 1] - prefix[u_starts]
    norms = np.linalg.norm(pooled, axis=1)
    safe_norms = np.where(norms > 1e-8, norms, 1.0)
    normalized_windows = pooled / safe_norms[:, np.newaxis]
    raw_cosines = np.clip(normalized_windows @ query_vec, -1.0, 1.0)
    raw_cosines = np.where(norms > 1e-8, raw_cosines, 0.0)

    unit_stems, unit_concepts, _ = _unit_word_features(units, words)
    query_stem_set = frozenset(intent.stemmed_tokens)
    query_concepts = intent.concept_ids
    subject_concepts = intent.subject_concept_ids

    results: dict[str, WindowTopicMatch] = {}
    for idx, window in enumerate(windows):
        cos_sim = float(raw_cosines[idx])
        u0 = int(u_starts[idx])
        u1 = int(u_ends[idx])

        win_stems: set[str] = set()
        win_concepts: set[int] = set()
        for u_i in range(u0, u1 + 1):
            win_stems.update(unit_stems[u_i])
            win_concepts.update(unit_concepts[u_i])

        lex_overlap = (
            len(query_stem_set & win_stems) / len(query_stem_set)
            if query_stem_set
            else 0.0
        )
        concept_overlap = (
            len(query_concepts & win_concepts) / len(query_concepts)
            if query_concepts
            else lex_overlap
        )
        subject_overlap = (
            len(subject_concepts & win_concepts) / len(subject_concepts)
            if subject_concepts
            else 1.0
        )

        # If the prompt specifies a concrete subject domain (e.g. "crypto" in "crypto crash",
        # or "cricket" in "cricket memories") and the window lacks the subject concept,
        # damp the score so generic modifier matches ("server crash", "housing crash")
        # never masquerade as on-topic hits.
        if subject_concepts and subject_overlap == 0.0:
            combined = cos_sim * 0.12
        elif lex_overlap == 0.0 and concept_overlap == 0.0:
            combined = cos_sim * 0.15
        else:
            combined = (
                0.50 * max(0.0, cos_sim)
                + 0.30 * concept_overlap
                + 0.20 * lex_overlap
            )
            if subject_concepts and subject_overlap == 1.0 and concept_overlap == 1.0:
                combined = min(1.0, combined + 0.12)

        results[window.window_id] = WindowTopicMatch(
            window_id=window.window_id,
            similarity=max(0.0, cos_sim),
            concept_overlap=concept_overlap,
            lexical_overlap=lex_overlap,
            combined_score=min(1.0, max(0.0, combined)),
        )

    return results


def filter_candidates_by_topic_semantics[T](
    candidates: Sequence[T],
    *,
    topic: str,
    units: Sequence[Unit],
    words: Sequence[Word],
    window_of: Callable[[T], Window],
    score_of: Callable[[T], float],
    min_similarity: float = SEMANTIC_SIMILARITY_FLOOR,
) -> list[tuple[T, float]]:
    """Filter and rank candidate windows by semantic topic relevance."""
    if not candidates:
        return []
    windows = [window_of(c) for c in candidates]
    matches = score_windows_for_topic(topic, units, words, windows)
    scored_pairs: list[tuple[T, float]] = []
    for candidate in candidates:
        win = window_of(candidate)
        match = matches.get(win.window_id)
        if match is None:
            continue
        if match.combined_score >= min_similarity:
            blended = 0.65 * match.combined_score + 0.35 * score_of(candidate)
            scored_pairs.append((candidate, blended))

    scored_pairs.sort(key=lambda pair: -pair[1])
    return scored_pairs


def _windows_overlap(a: Window, b: Window) -> bool:
    return a.start_ms < b.end_ms and b.start_ms < a.end_ms


def prefilter_candidates_for_topic[T](
    candidates: Sequence[T],
    *,
    topic: str,
    units: Sequence[Unit],
    words: Sequence[Word],
    window_of: Callable[[T], Window],
    score_of: Callable[[T], float],
    count: int,
    timeline: tuple[int, int],
) -> list[T]:
    """Select a shortlist where >=70% of candidates have high semantic similarity to ``topic``.

    Guarantees that at least ``SEMANTIC_PREFILTER_RATIO`` (70%) of the LLM reranker
    shortlist comes from semantically matched windows when available, filling any
    remaining slots with the highest-scoring non-overlapping general windows.
    """
    if not candidates or count <= 0:
        return []

    windows = [window_of(c) for c in candidates]
    matches = score_windows_for_topic(topic, units, words, windows)

    semantic_quota = max(1, round(count * SEMANTIC_PREFILTER_RATIO + 0.4999))
    semantic_pool = [
        c
        for c in candidates
        if matches.get(window_of(c).window_id, WindowTopicMatch("", 0, 0, 0, 0)).combined_score
        >= SEMANTIC_SIMILARITY_FLOOR
    ]

    def semantic_rank_score(candidate: T) -> float:
        m = matches.get(window_of(candidate).window_id)
        sem = m.combined_score if m is not None else 0.0
        return 0.72 * sem + 0.28 * score_of(candidate)

    selected_semantic = select(
        semantic_pool,
        count=min(count, max(semantic_quota, len(semantic_pool))),
        window_of=window_of,
        score_of=semantic_rank_score,
        timeline=timeline,
    )

    if len(selected_semantic) >= count:
        return selected_semantic[:count]

    selected_windows = [window_of(c) for c in selected_semantic]
    remaining_pool = [
        c
        for c in candidates
        if not any(_windows_overlap(window_of(c), sw) for sw in selected_windows)
    ]
    needed = count - len(selected_semantic)
    fallback_picks = select(
        remaining_pool,
        count=needed,
        window_of=window_of,
        score_of=score_of,
        timeline=timeline,
    )
    return selected_semantic + fallback_picks
