"""Tests for Trend-Aware Hashtag Recommendation Engine (Pillar 7 §03)."""

from __future__ import annotations

import time

from worker_ai.highlights.hashtags import (
  assemble_pyramid_bundle,
  classify_tier,
  clean_hashtag,
  detect_domain,
  get_platform_hashtags,
)


def test_clean_hashtag_enforces_valid_syntax_and_unicode_safety() -> None:
  assert clean_hashtag("ai") == "#ai"
  assert clean_hashtag("#MachineLearning") == "#MachineLearning"
  assert clean_hashtag("  #TechTrends!  ") == "#TechTrends"
  assert clean_hashtag("crypto🚀moon") == "#cryptomoon"
  assert clean_hashtag("#saving tips") == "#savingtips"
  assert clean_hashtag("#हिंदी_वीडियो") == "#हिंदी_वीडियो"
  assert clean_hashtag("") is None
  assert clean_hashtag("###") is None
  assert clean_hashtag("!@#$%^") is None


def test_classify_tier_categorizes_volume_distribution() -> None:
  assert classify_tier("#ai") == "BROAD"
  assert classify_tier("#technology") == "BROAD"
  assert classify_tier("#business") == "BROAD"
  assert classify_tier("#aiproductivity") == "COMMUNITY"
  assert classify_tier("#saasgrowth") == "COMMUNITY"
  assert classify_tier("#gymtok") == "COMMUNITY"
  assert classify_tier("#vectordatabases") == "NICHE"
  assert classify_tier("#ragpipeline") == "NICHE"
  assert classify_tier("#retrievalaugmentedgeneration") == "NICHE"


def test_detect_domain_maps_semantic_context() -> None:
  ai_text = "We built a RAG pipeline utilizing vector databases and local LLMs for inference."
  assert detect_domain(ai_text, "Local AI Agents") == "ai"

  business_text = "How we bootstrapped our B2B SaaS startup to one million ARR with high retention."
  assert detect_domain(business_text, "SaaS Growth Secrets") == "business"

  fitness_text = "Progressive overload on the bench press and squat is key for muscle hypertrophy."
  assert detect_domain(fitness_text, "Gym workout routine") == "fitness"

  finance_text = "Here is how compound interest in index funds generates passive income and wealth."
  assert detect_domain(finance_text, "Investing Guide") == "finance"


def test_pyramid_bundle_assembles_balanced_3_tier_structure() -> None:
  transcript = (
    "Using LangChain and Qdrant to build our semantic search pipeline cut LLM tokens significantly."
  )
  title = "Vector Search Architectures"

  bundle = assemble_pyramid_bundle(text=transcript, title=title, platform="default")

  assert len(bundle.broad) >= 1
  assert len(bundle.community) >= 2
  assert len(bundle.niche) >= 1
  assert bundle.domain == "ai"
  assert bundle.formatted.startswith("#")
  assert len(bundle.all) >= 5

  # Check zero duplicate tags (case-insensitive)
  lower_tags = [t.casefold() for t in bundle.all]
  assert len(lower_tags) == len(set(lower_tags))


def test_platform_count_throttles_and_banned_tags() -> None:
  transcript = "Growing your audience with short form video editing and visual hooks."
  title = "Viral Video Strategy"

  # 1. YouTube Shorts: 3-5 tags
  yt_bundle = assemble_pyramid_bundle(transcript, title, platform="youtube")
  assert 3 <= len(yt_bundle.all) <= 5

  # 2. Instagram: 5-8 tags
  ig_bundle = assemble_pyramid_bundle(transcript, title, platform="instagram")
  assert 5 <= len(ig_bundle.all) <= 8

  # 3. TikTok: 3-6 tags
  tt_bundle = assemble_pyramid_bundle(transcript, title, platform="tiktok")
  assert 3 <= len(tt_bundle.all) <= 6

  # 4. LinkedIn: 2-3 tags, strictly bans #fyp and #viral spam
  li_bundle = assemble_pyramid_bundle(
    transcript,
    title,
    platform="linkedin",
    custom_tags=("#fyp", "#viral", "#leadership"),
  )
  assert len(li_bundle.all) <= 3
  assert not any("fyp" in t.casefold() for t in li_bundle.all)
  assert not any("viral" in t.casefold() for t in li_bundle.all)

  # 5. X (Twitter): 1-3 tags
  x_bundle = assemble_pyramid_bundle(transcript, title, platform="x")
  assert 1 <= len(x_bundle.all) <= 3


def test_get_platform_hashtags_returns_clean_list() -> None:
  tags = get_platform_hashtags(
    "How to code in Python with clean architecture and fast testing.",
    title="Clean Code Tips",
    platform="youtube",
  )
  assert isinstance(tags, list)
  assert 3 <= len(tags) <= 5
  assert all(t.startswith("#") and " " not in t for t in tags)


def test_hashtag_generation_latency_sla() -> None:
  """Verifies SLA of <= 300ms generation latency."""
  text = "Deep learning and neural network training with PyTorch and GPU optimization."
  title = "AI Training Pipeline"

  start = time.perf_counter()
  for _ in range(100):
    assemble_pyramid_bundle(text, title, platform="instagram")
  elapsed = (time.perf_counter() - start) / 100 * 1000  # ms per call

  # Target SLA is <= 300ms; should easily execute in < 10ms
  assert elapsed < 50.0, f"Average generation latency {elapsed:.2f}ms exceeded SLA"
