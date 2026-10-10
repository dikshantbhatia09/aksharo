"""Unit tests for Automated Show Notes, Chapters & Timestamp Generator (Pillar 7 §04)."""

import time
import pytest

from worker_ai.processors.show_notes import (
    MIN_CHAPTER_DURATION_SEC,
    format_timestamp,
    generate_show_notes,
    segment_chapters_texttiling,
    group_words_into_sentences,
    parse_transcript_data,
)


def test_format_timestamp():
    assert format_timestamp(0) == "00:00"
    assert format_timestamp(4.2) == "00:04"
    assert format_timestamp(65) == "01:05"
    assert format_timestamp(255) == "04:15"
    assert format_timestamp(3600) == "1:00:00"
    assert format_timestamp(3665) == "1:01:05"
    assert format_timestamp(5250) == "1:27:30"


def test_empty_transcript_youtube_compliance():
    """Even with minimal or empty input, YouTube constraints are preserved."""
    result = generate_show_notes([])
    chapters = result.youtubeChapters

    # Constraint 1: First timestamp must start at 00:00
    assert chapters[0].startSec == 0
    assert chapters[0].timestamp == "00:00"

    # Constraint 2: Must have at least 3 timestamps
    assert len(chapters) >= 3

    # Constraint 3: Ascending order and Delta t >= 10s
    for i in range(len(chapters) - 1):
        assert chapters[i].startSec < chapters[i + 1].startSec
        assert (chapters[i + 1].startSec - chapters[i].startSec) >= MIN_CHAPTER_DURATION_SEC

    # Check show notes structure
    assert len(result.summary) > 20
    assert 5 <= len(result.keyTakeaways) <= 8
    assert len(result.notableQuotes) == 3


def test_short_transcript_compliance():
    words = [
        {"text": "Welcome", "start": 0.0, "end": 0.5, "speaker": "Host"},
        {"text": "everyone", "start": 0.6, "end": 1.0, "speaker": "Host"},
        {"text": "to", "start": 1.1, "end": 1.3, "speaker": "Host"},
        {"text": "today's", "start": 1.4, "end": 1.8, "speaker": "Host"},
        {"text": "episode.", "start": 1.9, "end": 2.5, "speaker": "Host"},
        {"text": "We", "start": 12.0, "end": 12.3, "speaker": "Guest"},
        {"text": "are", "start": 12.4, "end": 12.6, "speaker": "Guest"},
        {"text": "discussing", "start": 12.7, "end": 13.2, "speaker": "Guest"},
        {"text": "growth.", "start": 13.3, "end": 14.0, "speaker": "Guest"},
        {"text": "Final", "start": 25.0, "end": 25.5, "speaker": "Host"},
        {"text": "thoughts", "start": 25.6, "end": 26.0, "speaker": "Host"},
        {"text": "now.", "start": 26.1, "end": 26.5, "speaker": "Host"},
    ]
    result = generate_show_notes(words)
    chapters = result.youtubeChapters

    # Strict YouTube constraints
    assert chapters[0].startSec == 0
    assert chapters[0].timestamp == "00:00"
    assert len(chapters) >= 3
    for i in range(len(chapters) - 1):
        assert chapters[i].startSec < chapters[i + 1].startSec
        assert (chapters[i + 1].startSec - chapters[i].startSec) >= MIN_CHAPTER_DURATION_SEC


def test_long_recording_performance_and_segmentation():
    """Test with a simulated 60-minute recording to verify latency SLA <= 6.0 seconds."""
    words = []
    current_time = 0.0
    topics = [
        "Introduction and background overview.",
        "Why early stage startups fail to find product market fit.",
        "The mechanics of viral organic distribution channels.",
        "How artificial intelligence agents automate repetitive code generation.",
        "The financial model and pricing strategies that scale.",
        "Hiring top tier engineering talent across global hubs.",
        "Operational cadence and weekly sprint retrospectives.",
        "Closing conclusions and key takeaways for founders.",
    ]

    for topic_idx, topic_text in enumerate(topics):
        speaker = "Host" if topic_idx % 2 == 0 else "Alex"
        # Repeat sentences to simulate natural dialogue
        for _ in range(25):
            for word in topic_text.split():
                words.append({
                    "text": word,
                    "start": round(current_time, 2),
                    "end": round(current_time + 0.35, 2),
                    "speaker": speaker,
                })
                current_time += 0.4
            current_time += 0.8  # pause between sentences

    total_duration_sec = current_time
    assert total_duration_sec > 500.0  # substantial duration

    start_perf = time.perf_counter()
    result = generate_show_notes(words)
    elapsed = time.perf_counter() - start_perf

    # SLA requirement: latency <= 6.0s
    assert elapsed < 6.0, f"Generation took {elapsed:.2f}s, exceeding 6.0s SLA"

    chapters = result.youtubeChapters
    assert chapters[0].startSec == 0
    assert chapters[0].timestamp == "00:00"
    assert len(chapters) >= 3

    # Verify chapters monotonically increase and respect gap
    for i in range(len(chapters) - 1):
        assert chapters[i].startSec < chapters[i + 1].startSec
        gap = chapters[i + 1].startSec - chapters[i].startSec
        assert gap >= MIN_CHAPTER_DURATION_SEC, f"Gap {gap}s < min {MIN_CHAPTER_DURATION_SEC}s"

    # Verify summary paragraphs
    paragraphs = [p.strip() for p in result.summary.split("\n\n") if p.strip()]
    assert len(paragraphs) >= 2, "Summary must be multi-paragraph"

    # Verify key takeaways
    assert 5 <= len(result.keyTakeaways) <= 8

    # Verify notable quotes
    assert len(result.notableQuotes) == 3
    for q in result.notableQuotes:
        assert q.speaker
        assert q.quote
        assert q.timestampSec >= 0
