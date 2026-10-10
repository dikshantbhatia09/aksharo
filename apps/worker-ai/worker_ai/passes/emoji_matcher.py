"""Contextual Auto-Emoji Generation & Synced Animation Engine (Pillar 4 §04).

Scans transcript words and phrases for emotional sentiments, concrete nouns,
and high-impact verbs, mapping them to 3D vector emojis with anti-clutter
pacing constraints (min gap >= 2.8s, max 1 emoji per 3.0s window).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

from worker_ai.passes.text_fx import Word

__all__ = [
    "EMOJI_TAXONOMY",
    "MatchedEmoji",
    "match_transcript_emojis",
    "match_word_emoji",
    "stem_word",
]

_PUNCT_RE = re.compile(r"[^\w\s-]")

# 3D Vector Emoji Taxonomy: keyword synset mappings
# (Pillar 4 #04 ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md §4.1)
EMOJI_TAXONOMY: dict[str, dict[str, Any]] = {
    "money": {
        "emoji": "💸",
        "asset_svg": "3d-money-wings.svg",
        "category": "finance",
        "sentiment": "hype",
        "keywords": [
            "money", "cash", "revenue", "profit", "wealth", "rich", "millionaire",
            "billionaire", "bag", "dollars", "crypto", "bitcoin", "earnings",
            "funds", "salary", "paycheck", "income", "sales", "arr", "mrr",
            "monetize", "monetization", "expensive", "investment", "investor",
            "capital", "valuation", "richer", "wealthy", "finance", "financial",
        ],
    },
    "dollar": {
        "emoji": "💵",
        "asset_svg": "3d-dollar.svg",
        "category": "finance",
        "sentiment": "positive",
        "keywords": [
            "dollar", "bucks", "bills", "banknote", "currency", "cost", "price",
            "fee", "charge", "payment", "spend", "spending", "paid", "budget",
        ],
    },
    "fire": {
        "emoji": "🔥",
        "asset_svg": "3d-fire.svg",
        "category": "hype",
        "sentiment": "hype",
        "keywords": [
            "fire", "lit", "hot", "burn", "burning", "flame", "flames", "fired",
            "insane", "wild", "crazy", "spicy", "heat", "blazing", "trending",
            "viral", "epic", "legendary", "superhot", "cook", "cooking",
        ],
    },
    "rocket": {
        "emoji": "🚀",
        "asset_svg": "3d-rocket.svg",
        "category": "growth",
        "sentiment": "hype",
        "keywords": [
            "rocket", "launch", "launched", "launching", "moon", "explode", "exploded",
            "exploding", "skyrocket", "skyrocketed", "skyrocketing", "boost",
            "boosted", "scale", "scaling", "fly", "flying", "soar", "soaring",
            "fast", "speed", "exponential", "hypergrowth", "takeoff", "lift-off",
        ],
    },
    "dead": {
        "emoji": "💀",
        "asset_svg": "3d-skull.svg",
        "category": "reaction",
        "sentiment": "negative",
        "keywords": [
            "dead", "died", "dying", "death", "skull", "killed", "kill", "killing",
            "rip", "corpse", "funeral", "ruined", "destroyed", "buried", "rekt",
            "passed away", "game over", "lost it", "i'm dead", "im dead",
        ],
    },
    "growth": {
        "emoji": "📈",
        "asset_svg": "3d-chart-up.svg",
        "category": "growth",
        "sentiment": "positive",
        "keywords": [
            "growth", "grow", "growing", "grew", "chart", "trending", "stonks",
            "progress", "gain", "gains", "improve", "improvement", "uptrend",
            "surge", "spike", "peak", "climb", "escalate", "multiply",
        ],
    },
    "mindblown": {
        "emoji": "🤯",
        "asset_svg": "3d-exploding-head.svg",
        "category": "reaction",
        "sentiment": "hype",
        "keywords": [
            "mindblown", "mind-blown", "mind blown", "blown", "shocked", "shocking",
            "unbelievable", "insane", "omg", "wow", "astonishing", "speechless",
            "jaw dropping", "baffled", "crazy", "stunned", "disbelief",
        ],
    },
    "warning": {
        "emoji": "⚠️",
        "asset_svg": "3d-warning.svg",
        "category": "alert",
        "sentiment": "warning",
        "keywords": [
            "warning", "warn", "warned", "alert", "danger", "dangerous", "caution",
            "careful", "risk", "risky", "beware", "hazard", "threat", "alarm",
            "red flag", "critical", "scam", "trap", "watch out",
        ],
    },
    "stop": {
        "emoji": "🛑",
        "asset_svg": "3d-stop-sign.svg",
        "category": "alert",
        "sentiment": "warning",
        "keywords": [
            "stop", "halt", "pause", "never", "block", "blocked", "blocking",
            "cease", "quit", "prohibited", "banned", "forbidden", "cancel", "dont",
            "do not", "freeze",
        ],
    },
    "crying": {
        "emoji": "😭",
        "asset_svg": "3d-crying.svg",
        "category": "emotion",
        "sentiment": "negative",
        "keywords": [
            "crying", "cry", "cried", "sad", "sadness", "tear", "tears", "weep",
            "weeping", "emotional", "depressed", "depression", "heartbroken",
            "painful", "devastated", "tragic", "grief", "mourn", "hurt",
        ],
    },
    "heart": {
        "emoji": "❤️",
        "asset_svg": "3d-heart.svg",
        "category": "emotion",
        "sentiment": "positive",
        "keywords": [
            "love", "loved", "loving", "heart", "hearts", "passion", "favorite",
            "adore", "cherish", "caring", "beloved", "affection", "soul",
        ],
    },
    "hearteyes": {
        "emoji": "😍",
        "asset_svg": "3d-heart-eyes.svg",
        "category": "reaction",
        "sentiment": "positive",
        "keywords": [
            "crush", "obsessed", "beautiful", "gorgeous", "stunning", "pretty",
            "attractive", "perfect", "loves", "fascinated", "in love",
        ],
    },
    "laugh": {
        "emoji": "😂",
        "asset_svg": "3d-laughing.svg",
        "category": "reaction",
        "sentiment": "positive",
        "keywords": [
            "laugh", "laughing", "laughed", "lol", "lmao", "rofl", "hilarious",
            "funny", "joke", "comedy", "humor", "haha", "giggle", "crack up",
        ],
    },
    "brain": {
        "emoji": "🧠",
        "asset_svg": "3d-brain.svg",
        "category": "action",
        "sentiment": "positive",
        "keywords": [
            "brain", "smart", "intelligent", "intelligence", "genius", "think",
            "thinking", "thought", "thoughts", "strategy", "strategic", "mind",
            "logic", "logical", "iq", "clever", "mental", "cognitive",
        ],
    },
    "lightbulb": {
        "emoji": "💡",
        "asset_svg": "3d-lightbulb.svg",
        "category": "action",
        "sentiment": "positive",
        "keywords": [
            "lightbulb", "idea", "ideas", "solution", "solutions", "insight",
            "eureka", "invent", "invention", "innovate", "innovation", "creativity",
            "creative", "realize", "realization", "discovery", "tip", "secret",
        ],
    },
    "target": {
        "emoji": "🎯",
        "asset_svg": "3d-target.svg",
        "category": "action",
        "sentiment": "positive",
        "keywords": [
            "target", "targets", "targeted", "goal", "goals", "aim", "aiming",
            "focus", "focused", "bullseye", "mission", "objective", "accurate",
            "precision", "hitting", "milestone",
        ],
    },
    "muscle": {
        "emoji": "💪",
        "asset_svg": "3d-muscle.svg",
        "category": "action",
        "sentiment": "hype",
        "keywords": [
            "muscle", "muscles", "strong", "stronger", "power", "powerful", "strength",
            "grind", "grinding", "gym", "workout", "fitness", "hustle", "tough",
            "beast", "hard work", "discipline",
        ],
    },
    "crown": {
        "emoji": "👑",
        "asset_svg": "3d-crown.svg",
        "category": "status",
        "sentiment": "hype",
        "keywords": [
            "crown", "king", "queen", "royalty", "royal", "best", "goat", "top",
            "leader", "champion", "legend", "elite", "boss", "emperor", "dominate",
        ],
    },
    "trophy": {
        "emoji": "🏆",
        "asset_svg": "3d-trophy.svg",
        "category": "success",
        "sentiment": "positive",
        "keywords": [
            "trophy", "winner", "win", "winning", "won", "victory", "first place",
            "award", "prize", "achievement", "succeed", "success", "successful",
            "triumph", "conquer",
        ],
    },
    "party": {
        "emoji": "🎉",
        "asset_svg": "3d-party-popper.svg",
        "category": "hype",
        "sentiment": "hype",
        "keywords": [
            "party", "celebrate", "celebration", "celebrating", "congrats",
            "congratulations", "cheers", "hooray", "anniversary", "festival",
            "cheer", "excitement",
        ],
    },
    "clap": {
        "emoji": "👏",
        "asset_svg": "3d-clap.svg",
        "category": "reaction",
        "sentiment": "positive",
        "keywords": [
            "clap", "clapping", "clapped", "applause", "bravo", "kudos", "props",
            "respect", "salute", "shoutout", "applaud",
        ],
    },
    "eyes": {
        "emoji": "👀",
        "asset_svg": "3d-eyes.svg",
        "category": "reaction",
        "sentiment": "hype",
        "keywords": [
            "eyes", "look", "looking", "see", "seeing", "watch", "watching",
            "witness", "reveal", "revealing", "peek", "peeking", "notice",
            "secret", "curious", "check this", "listen to this",
        ],
    },
    "hundred": {
        "emoji": "💯",
        "asset_svg": "3d-hundred.svg",
        "category": "status",
        "sentiment": "hype",
        "keywords": [
            "hundred", "100", "perfect", "score", "flawless", "legit", "facts",
            "truth", "true", "accurate", "exact", "real", "keep it real", "100%",
        ],
    },
    "gem": {
        "emoji": "💎",
        "asset_svg": "3d-gem.svg",
        "category": "status",
        "sentiment": "positive",
        "keywords": [
            "gem", "gems", "diamond", "diamonds", "rare", "valuable", "jewel",
            "precious", "luxury", "pristine", "hidden gem", "treasure",
        ],
    },
    "lock": {
        "emoji": "🔒",
        "asset_svg": "3d-lock.svg",
        "category": "objects",
        "sentiment": "neutral",
        "keywords": [
            "lock", "locked", "locking", "secure", "security", "protect", "protected",
            "private", "privacy", "safety", "safe", "confidential", "vault",
        ],
    },
    "key": {
        "emoji": "🔑",
        "asset_svg": "3d-key.svg",
        "category": "objects",
        "sentiment": "positive",
        "keywords": [
            "key", "keys", "unlock", "unlocked", "unlocking", "access", "secret key",
            "fundamental", "crucial", "essential", "vital", "open the door",
        ],
    },
    "clock": {
        "emoji": "⏰",
        "asset_svg": "3d-clock.svg",
        "category": "objects",
        "sentiment": "warning",
        "keywords": [
            "clock", "time", "hours", "minutes", "seconds", "urgent", "hurry",
            "deadline", "late", "alarm", "wake up", "timer", "schedule", "patience",
        ],
    },
    "lightning": {
        "emoji": "⚡",
        "asset_svg": "3d-lightning.svg",
        "category": "hype",
        "sentiment": "hype",
        "keywords": [
            "lightning", "thunder", "instant", "electric", "energy", "quick",
            "flash", "fast", "speedy", "power", "surge", "charge", "zap",
        ],
    },
    "star": {
        "emoji": "⭐",
        "asset_svg": "3d-star.svg",
        "category": "status",
        "sentiment": "positive",
        "keywords": [
            "star", "stars", "stellar", "special", "featured", "famous", "celebrity",
            "favorite", "rating", "rated", "gold star", "spotlight",
        ],
    },
    "check": {
        "emoji": "✅",
        "asset_svg": "3d-check.svg",
        "category": "success",
        "sentiment": "positive",
        "keywords": [
            "check", "checked", "done", "verified", "verify", "success", "complete",
            "completed", "correct", "approved", "pass", "passed", "yes", "agreed",
        ],
    },
    "cross": {
        "emoji": "❌",
        "asset_svg": "3d-cross.svg",
        "category": "alert",
        "sentiment": "negative",
        "keywords": [
            "cross", "wrong", "fail", "failed", "failing", "error", "mistake",
            "cancel", "no", "denied", "rejected", "incorrect", "loss", "lose",
        ],
    },
    "chat": {
        "emoji": "💬",
        "asset_svg": "3d-chat.svg",
        "category": "action",
        "sentiment": "neutral",
        "keywords": [
            "chat", "talk", "talking", "talked", "podcast", "say", "saying", "speak",
            "speaking", "spoke", "comment", "commentary", "conversation", "message",
            "discussion", "interview",
        ],
    },
    "thumbsup": {
        "emoji": "👍",
        "asset_svg": "3d-thumbs-up.svg",
        "category": "reaction",
        "sentiment": "positive",
        "keywords": [
            "thumbsup", "thumbs up", "like", "liked", "agree", "agreed", "approve",
            "approved", "approval", "good", "great", "nice", "awesome",
        ],
    },
    "cool": {
        "emoji": "😎",
        "asset_svg": "3d-cool.svg",
        "category": "reaction",
        "sentiment": "hype",
        "keywords": [
            "cool", "sunglasses", "vibe", "vibes", "smooth", "chill", "relaxed",
            "badass", "swag", "flex", "stylish", "effortless",
        ],
    },
    "bomb": {
        "emoji": "💣",
        "asset_svg": "3d-bomb.svg",
        "category": "hype",
        "sentiment": "hype",
        "keywords": [
            "bomb", "boom", "explosive", "blast", "nuke", "detonate", "kaboom",
            "blow up", "dynamite", "drop the bomb",
        ],
    },
}

# Inverted keyword lookup table
_INVERTED_KEYWORD_INDEX: dict[str, tuple[str, str, str, str]] = {}
for entry_id, data in EMOJI_TAXONOMY.items():
    emoji_char = data["emoji"]
    asset_svg = data["asset_svg"]
    category = data["category"]
    _INVERTED_KEYWORD_INDEX[entry_id] = (entry_id, emoji_char, asset_svg, category)
    for kw in data["keywords"]:
        norm = kw.lower().strip()
        if norm not in _INVERTED_KEYWORD_INDEX:
            _INVERTED_KEYWORD_INDEX[norm] = (entry_id, emoji_char, asset_svg, category)


def stem_word(word: str) -> list[str]:
    """Extracts morphological stem candidates for English words."""
    clean = _PUNCT_RE.sub("", word).lower().strip()
    if not clean:
        return []

    candidates = [clean]

    # Plurals
    if clean.endswith("ies") and len(clean) > 4:
        candidates.append(clean[:-3] + "y")
    elif clean.endswith("es") and len(clean) > 3:
        candidates.append(clean[:-2])
    elif clean.endswith("s") and not clean.endswith("ss") and len(clean) > 2:
        candidates.append(clean[:-1])

    # Verb tenses (-ing, -ed)
    if clean.endswith("ing") and len(clean) > 4:
        candidates.append(clean[:-3])
        candidates.append(clean[:-3] + "e")  # e.g. scaling -> scale
        if len(clean) > 5 and clean[-4] == clean[-5]:
            candidates.append(clean[:-4])  # e.g. stopping -> stop

    if clean.endswith("ed") and len(clean) > 3:
        candidates.append(clean[:-2])
        candidates.append(clean[:-1])  # e.g. fired -> fire
        if len(clean) > 4 and clean[-3] == clean[-4]:
            candidates.append(clean[:-3])  # e.g. stopped -> stop

    return candidates


def match_word_emoji(word_or_phrase: str) -> tuple[str, str, str, str] | None:
    """Matches a word or phrase against the 3D emoji taxonomy.

    Returns (entry_id, emoji_char, asset_svg, category) or None.
    """
    if not word_or_phrase:
        return None

    clean = word_or_phrase.lower().strip()
    if clean in _INVERTED_KEYWORD_INDEX:
        return _INVERTED_KEYWORD_INDEX[clean]

    # Try stems
    stems = stem_word(clean)
    for s in stems:
        if s in _INVERTED_KEYWORD_INDEX:
            return _INVERTED_KEYWORD_INDEX[s]

    return None


@dataclass(frozen=True, slots=True)
class MatchedEmoji:
    word_id: str
    text: str
    start_ms: int
    end_ms: int
    emoji: str
    asset_key: str
    asset_svg: str
    category: str
    confidence: float


def match_transcript_emojis(
    words: list[Word],
    min_gap_ms: int = 2800,
    window_ms: int = 3000,
) -> list[MatchedEmoji]:
    """Scans transcript words and returns paced contextual emojis.

    Enforces pacing constraints:
    - Minimum distance between consecutive emojis >= min_gap_ms (2.8s)
    - Max 1 emoji per window_ms (3.0s)
    """
    candidates: list[MatchedEmoji] = []

    for word in words:
        matched = match_word_emoji(word.t)
        if matched is None:
            continue
        entry_id, emoji_char, asset_svg, category = matched
        candidates.append(
            MatchedEmoji(
                word_id=word.wid,
                text=word.t,
                start_ms=word.s,
                end_ms=word.e,
                emoji=emoji_char,
                asset_key=entry_id,
                asset_svg=asset_svg,
                category=category,
                confidence=0.98,
            )
        )

    if len(candidates) <= 1:
        return candidates

    # Apply pacing throttle
    accepted: list[MatchedEmoji] = []
    last_accepted_ms = -1_000_000

    for cand in candidates:
        if cand.start_ms - last_accepted_ms < min_gap_ms:
            continue

        window_start = cand.start_ms - window_ms
        in_window = sum(1 for a in accepted if a.start_ms > window_start)
        if in_window >= 1:
            continue

        accepted.append(cand)
        last_accepted_ms = cand.start_ms

    return accepted
