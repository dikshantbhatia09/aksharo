"""B-Roll Semantic Query Generator & Pacing Engine (Pillar 6 §01).

Implements context-aware visual B-roll moments extraction:
- Evaluates transcript sentences using fast LLM prompts to identify concrete visual concepts
  (products, financial dashboards, real estate, rocket launches, machines, nature, travel).
- Enforces strict viral retention pacing:
  * Maximum 1 B-roll clip every 10 seconds (min gap >= 10.0s).
  * Clip duration clamped between 2.5s and 4.0s.
  * Avoids hook first 2.5s to preserve initial viewer-creator eye contact.
  * Targets 2 to 4 high-impact visual illustration opportunities per 60s video.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Final, Sequence

from worker_ai.callbacks import JobUsage
from worker_ai.llm.calls import Deadline, complete_json
from worker_ai.llm.providers.base import LlmProvider, LlmRequest
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, ProcessorOutcome

__all__ = [
    "BROLL_MAX_DURATION_SEC",
    "BROLL_MIN_DURATION_SEC",
    "BROLL_MIN_GAP_SEC",
    "BrollCueEvent",
    "enforce_broll_pacing",
    "generate_broll_cues",
    "process_broll_pass",
]

_log = get_logger(__name__)

BROLL_MIN_DURATION_SEC: Final[float] = 2.5
BROLL_MAX_DURATION_SEC: Final[float] = 4.0
BROLL_MIN_GAP_SEC: Final[float] = 10.0
HOOK_AVOID_SEC: Final[float] = 2.5

SYSTEM_PROMPT: Final[str] = (
    "You are an expert short-form video retention editor (Submagic / Opus Clip style). "
    "Your goal is to identify 2 to 4 high-impact moments in the transcript where a talking-head "
    "video needs visual stock B-roll footage cutaway (duration 2.5s to 4.0s) to visually illustrate "
    "abstract ideas, numbers, real estate, tech, ads, money, nature, or objects. "
    "Enforce pacing: at least 10 seconds between B-roll moments. Never place one in the first 2.5 seconds. "
    "Output strict JSON with format:\n"
    '{"broll_cues":[{"start_sec": float, "end_sec": float, "context_phrase": string, '
    '"search_query": string, "score": float}]}'
)

# Common visual keyword categories for fallback heuristic query generation
VISUAL_HEURISTIC_MAP: Final[list[tuple[re.Pattern[str], str]]] = [
    (re.compile(r"\b(ads|ad spend|facebook ads|google ads|marketing campaign)\b", re.I), "digital ad spend dashboard analytics 4k"),
    (re.compile(r"\b(real estate|house|mansion|luxury property|housing market)\b", re.I), "luxury modern real estate drone vertical 4k"),
    (re.compile(r"\b(rocket|space|mars|nasa|launch)\b", re.I), "rocket launch smoke space cinematic 4k"),
    (re.compile(r"\b(stock market|investing|crypto|bitcoin|trading|chart|profit)\b", re.I), "stock market trading chart growth green candles"),
    (re.compile(r"\b(ai|artificial intelligence|neural network|algorithm|code)\b", re.I), "artificial intelligence neural network glowing node mesh"),
    (re.compile(r"\b(travel|flight|airplane|airport|destination|vacation)\b", re.I), "airplane flying above clouds golden hour cinematic"),
    (re.compile(r"\b(mountain|forest|ocean|nature|beach|sunrise)\b", re.I), "mountain mist sunrise drone cinematic 4k"),
    (re.compile(r"\b(money|million|billion|dollars|cash|wealth)\b", re.I), "counting cash money wealth cinematic"),
]


@dataclass(frozen=True, slots=True)
class BrollCueEvent:
    start_sec: float
    end_sec: float
    context_phrase: str
    search_query: str
    score: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "start_sec": round(self.start_sec, 2),
            "end_sec": round(self.end_sec, 2),
            "duration_sec": round(self.end_sec - self.start_sec, 2),
            "context_phrase": self.context_phrase,
            "search_query": self.search_query,
            "score": round(self.score, 2),
        }


def enforce_broll_pacing(
    cues: Sequence[BrollCueEvent],
    total_duration_sec: float,
    min_gap_sec: float = BROLL_MIN_GAP_SEC,
    hook_avoid_sec: float = HOOK_AVOID_SEC,
) -> list[BrollCueEvent]:
    """Enforces pacing rules:
    - No cues during hook (first `hook_avoid_sec` seconds).
    - Clamps duration between 2.5s and 4.0s.
    - Ensures at least `min_gap_sec` (10s) between successive clips.
    - Never extends past total video duration.
    - Highest scored cues prioritized when crowded.
    """
    valid: list[BrollCueEvent] = []
    for cue in cues:
        start = max(hook_avoid_sec, cue.start_sec)
        # Ensure within video bounds
        if start >= total_duration_sec - 1.0:
            continue
        duration = max(BROLL_MIN_DURATION_SEC, min(BROLL_MAX_DURATION_SEC, cue.end_sec - cue.start_sec))
        end = min(total_duration_sec, start + duration)
        if end - start < BROLL_MIN_DURATION_SEC:
            continue

        clean_query = re.sub(r"[^\w\s-]", "", cue.search_query).strip() or "cinematic broll stock"
        valid.append(
            BrollCueEvent(
                start_sec=start,
                end_sec=end,
                context_phrase=cue.context_phrase.strip(),
                search_query=clean_query,
                score=max(0.0, min(10.0, cue.score)),
            )
        )

    # Sort descending by score to keep highest quality cues
    valid.sort(key=lambda c: (-c.score, c.start_sec))

    kept: list[BrollCueEvent] = []
    # Calculate max allowed cues for video length: ~1 cue per 15-20s, capped at 6
    max_cues = max(1, min(6, int(total_duration_sec / 15.0)))

    for candidate in valid:
        if len(kept) >= max_cues:
            break
        # Pacing check: must be at least min_gap_sec from any existing cue
        crowded = any(
            abs(candidate.start_sec - other.start_sec) < min_gap_sec
            or (candidate.start_sec < other.end_sec and other.start_sec < candidate.end_sec)
            for other in kept
        )
        if not crowded:
            kept.append(candidate)

    # Return sorted by time
    kept.sort(key=lambda c: c.start_sec)
    return kept


def generate_heuristic_broll_cues(
    sentences: Sequence[dict[str, Any]],
    total_duration_sec: float,
) -> list[BrollCueEvent]:
    """Fallback generator that scans sentences for concrete visual categories."""
    raw_cues: list[BrollCueEvent] = []

    for s in sentences:
        text = str(s.get("text", "")).strip()
        start = float(s.get("startSec", s.get("start_sec", (s.get("startMs", 0) / 1000.0))))
        end = float(s.get("endSec", s.get("end_sec", (s.get("endMs", 0) / 1000.0))))
        if not text:
            continue

        for pattern, search_query in VISUAL_HEURISTIC_MAP:
            m = pattern.search(text)
            if m:
                raw_cues.append(
                    BrollCueEvent(
                        start_sec=start,
                        end_sec=max(end, start + 3.0),
                        context_phrase=m.group(0),
                        search_query=search_query,
                        score=8.5,
                    )
                )
                break

    return enforce_broll_pacing(raw_cues, total_duration_sec)


async def generate_broll_cues(
    sentences: Sequence[dict[str, Any]],
    total_duration_sec: float,
    *,
    chain: Sequence[LlmProvider] | None = None,
    region: str = "us",
) -> list[BrollCueEvent]:
    """Generates B-roll cues using fast LLM prompt, with heuristic fallback."""
    if not sentences or total_duration_sec <= HOOK_AVOID_SEC + BROLL_MIN_DURATION_SEC:
        return []

    # If no LLM chain provided, use heuristic
    if not chain:
        return generate_heuristic_broll_cues(sentences, total_duration_sec)

    # Format transcript summary for prompt
    transcript_lines: list[str] = []
    for s in sentences[:80]:
        t_start = round(float(s.get("startSec", (s.get("startMs", 0) / 1000.0))), 2)
        t_end = round(float(s.get("endSec", (s.get("endMs", 0) / 1000.0))), 2)
        transcript_lines.append(f"[{t_start}s - {t_end}s] {s.get('text', '')}")

    transcript_text = "\n".join(transcript_lines)
    user_prompt = (
        f"Video Duration: {total_duration_sec}s\n"
        f"Transcript:\n{transcript_text}\n\n"
        "Generate 2 to 4 high-retention visual B-roll moments with search queries."
    )

    def request_for(provider: LlmProvider) -> LlmRequest:
        return LlmRequest(
            system=SYSTEM_PROMPT,
            user=user_prompt,
            max_tokens=600,
            temperature=0.2,
            region=region,
        )

    reply = await complete_json(
        chain,
        request_for,
        what="broll pass cues",
        deadline=Deadline(30.0),
        accept=lambda val: isinstance(val.get("broll_cues"), list),
    )

    if reply is None or not isinstance(reply.value.get("broll_cues"), list):
        return generate_heuristic_broll_cues(sentences, total_duration_sec)

    parsed_cues: list[BrollCueEvent] = []
    for item in reply.value["broll_cues"]:
        if not isinstance(item, dict):
            continue
        try:
            parsed_cues.append(
                BrollCueEvent(
                    start_sec=float(item.get("start_sec", 0.0)),
                    end_sec=float(item.get("end_sec", 0.0)),
                    context_phrase=str(item.get("context_phrase", "")),
                    search_query=str(item.get("search_query", "cinematic broll")),
                    score=float(item.get("score", 7.0)),
                )
            )
        except (ValueError, TypeError):
            continue

    if not parsed_cues:
        return generate_heuristic_broll_cues(sentences, total_duration_sec)

    return enforce_broll_pacing(parsed_cues, total_duration_sec)


async def process_broll_pass(context: JobContext) -> ProcessorOutcome:
    """Processor entrypoint for ``passType: "broll"`` jobs."""
    params = context.envelope.params
    sentences = params.get("sentences", [])
    if not isinstance(sentences, list):
        sentences = []

    duration_sec = float(
        params.get(
            "durationSec",
            params.get("duration_sec", params.get("durationMs", 60_000) / 1000.0),
        )
    )
    region = str(params.get("region", "us"))

    chain = context.collaborators.llm_chain if hasattr(context.collaborators, "llm_chain") else None
    cues = await generate_broll_cues(sentences, duration_sec, chain=chain, region=region)

    result = {
        "passType": "broll",
        "cueCount": len(cues),
        "durationSec": duration_sec,
        "cues": [cue.as_dict() for cue in cues],
    }

    return ProcessorOutcome(result=result)

