"""Test Suite: Teaser, Intro & Sponsor Read Filtering Engine (Pillar 2 §04).

Asserts:
1. 100% detection precision on 20 known podcast / YouTube ad reads.
2. 0% false positive rate on valid conversation / technical dialogue.
3. Outro CTA detector catching subscribe / like calls-to-action.
4. Introductory duplicate teaser detector identifying previews in first 90s matching later dialogue (>180s).
5. Window pruning correctly dropping commercial windows and teaser overlaps.
"""

from __future__ import annotations

import pytest

from worker_ai.highlights.contracts import ExcludeRange
from worker_ai.highlights.sponsors import (
    COMMERCIAL_SCORE_THRESHOLD,
    classify_commercial_intent,
    commercial_score,
    detect_intro_teasers,
    filter_commercial_windows,
    is_commercial_segment,
)
from worker_ai.highlights.windows import Window, Word

# ---------------------------------------------------------------------------
# 20 Known Podcast / YouTube Ad Reads
# ---------------------------------------------------------------------------
KNOWN_PODCAST_AD_READS: tuple[str, ...] = (
    # 1. NordVPN
    (
        "This episode is brought to you by NordVPN. Protect your online privacy and secure "
        "your data today. Go to nordvpn.com/podcast to get 70% off plus a 30-day money-back guarantee with promo code PODCAST."
    ),
    # 2. Athletic Greens (AG1)
    (
        "A quick word from our sponsor, Athletic Greens. I take AG1 every single morning to support gut "
        "health and energy. Check out the link in the description for a free one-year supply of vitamin D with your first order."
    ),
    # 3. BetterHelp
    (
        "This podcast is sponsored by BetterHelp. If you're struggling with stress or anxiety, give online "
        "therapy a try. Head over to betterhelp.com/creator to get 10% off your first month."
    ),
    # 4. Manscaped
    (
        "Huge thank you to our sponsor Manscaped. Get the Lawn Mower 5.0 Ultra with free shipping and 20% off "
        "when you use code VIRAL at manscaped.com."
    ),
    # 5. Factor Meals
    (
        "Today's episode is brought to you by Factor Meals. Ready-to-eat chef-crafted meals delivered straight to "
        "your door. Head over to factormeals.com/show50 and use code SHOW50 to get 50% off your first box."
    ),
    # 6. Squarespace
    (
        "Thanks to Squarespace for sponsoring today's video. Whether you need a portfolio, blog or online store, "
        "Squarespace makes it easy. Go to squarespace.com/tech for a free trial and use coupon code TECH for 10% off."
    ),
    # 7. ExpressVPN
    (
        "Today's sponsor is ExpressVPN. Don't let your internet provider spy on your browsing habits. Visit "
        "expressvpn.com/talk to get three extra months free trial on a 12-month plan."
    ),
    # 8. Surfshark
    (
        "This video is sponsored by Surfshark VPN. Protect unlimited devices on a single account. Use code "
        "CREATOR at checkout for an exclusive offer plus 3 extra months free trial."
    ),
    # 9. HelloFresh
    (
        "A huge thank you to HelloFresh for sponsoring today's episode. America's number one meal kit with "
        "pre-portioned ingredients. Use code FRESH16 for 16 free meals and free shipping."
    ),
    # 10. Ridge Wallet
    (
        "Support for today's show comes from Ridge Wallet. The sleek, RFID-blocking titanium wallet designed to "
        "hold up to 12 cards. Check out the link down below and use code RIDGE for 10% off."
    ),
    # 11. Raycon
    (
        "Our partner of today's episode is Raycon Everyday Earbuds. Premium audio quality at half the price of "
        "other brands. Go to buyraycon.com/listen and use code LISTEN to get 15% off your order."
    ),
    # 12. Babbel
    (
        "Brought to you by Babbel, the language learning app that teaches real-world conversations in just 10 "
        "minutes a day. Use our special discount link in bio to get up to 60% off your subscription."
    ),
    # 13. Skillshare
    (
        "In partnership with Skillshare. Explore thousands of inspiring creative classes in animation, video "
        "editing, and design. The first 500 people to use the link below get a one-month free trial."
    ),
    # 14. Audible
    (
        "This episode is proudly supported by Audible. Listen to thousands of audiobooks, podcasts, and "
        "originals. Visit audible.com/stories or text STORIES to 500-500 for a 30-day free trial."
    ),
    # 15. SeatGeek
    (
        "Today's video is brought to you by SeatGeek, the ticketing app that rates every ticket deal on a scale "
        "from 1 to 100. Use promo code SCORE for $20 off your first ticket purchase."
    ),
    # 16. PrizePicks
    (
        "We are partnered with PrizePicks, the daily fantasy sports game made easy. Download the app and use code "
        "WIN to get a 100% deposit match up to $100 on your first deposit."
    ),
    # 17. DraftKings
    (
        "Huge shoutout to our sponsor DraftKings Sportsbook. Download the app now and use promo code BETS to claim "
        "your special welcome bonus today."
    ),
    # 18. Rocket Money
    (
        "Sponsored by Rocket Money. Cancel unwanted subscriptions and lower your bills effortlessly with one "
        "click. Head over to rocketmoney.com/save to start saving risk-free for 30 days."
    ),
    # 19. Incogni
    (
        "A quick word from today's sponsor, Incogni. Protect your personal information and wipe your data from "
        "data brokers. Use code PRIVACY to get 60% off the annual plan."
    ),
    # 20. SimpliSafe
    (
        "This episode is brought to you by SimpliSafe home security. Award-winning whole-home protection with 24/7 "
        "professional monitoring. Go to simplisafe.com/secure for 40% off and a 60-day money-back guarantee."
    ),
)

# ---------------------------------------------------------------------------
# Valid Dialogue / Organic Discourse (Must NOT be flagged as commercial)
# ---------------------------------------------------------------------------
VALID_DIALOGUE_SAMPLES: tuple[str, ...] = (
    "We walked to the market and then we came back home after that because the weather was very pleasant.",
    "The discovery of quantum entanglement fundamentally challenged classical mechanics and Einstein's view of physics.",
    "When you design distributed microservices, ensuring partition tolerance is vital according to the CAP theorem.",
    "In 1969, Apollo 11 landed humans on the Moon, marking a historic achievement for human exploration and engineering.",
    "Local Whisper models can transcribe Hindi and English audio with impressive accuracy without cloud egress.",
    "The author explained how character development drives emotional resonance across literary trilogies.",
    "We analyzed neural firing rates in the primary visual cortex using two-photon calcium imaging.",
    "The architectural design prioritizes low-latency audio packet processing and deterministic event loops.",
)

# ---------------------------------------------------------------------------
# Outro & Subscribe CTAs
# ---------------------------------------------------------------------------
OUTRO_CTA_SAMPLES: tuple[str, ...] = (
    "Thanks for watching everyone, don't forget to like and subscribe and hit that subscribe button!",
    "Leave a review on Apple Podcasts and see you in the next episode!",
    "Ring that notification bell and smash that like button if you enjoyed this video!",
    "Thank you for listening to today's episode, tune in next week for more discussions!",
    "Channel ko subscribe karein aur video ko like karein, milte hain agli video mein!",
)


def test_20_podcast_ad_reads_have_100_percent_detection() -> None:
    """SLA: 100% detection on 20 known podcast sponsor reads (commercial_score > 0.40)."""
    assert len(KNOWN_PODCAST_AD_READS) == 20

    detected_count = 0
    for idx, ad_read in enumerate(KNOWN_PODCAST_AD_READS, start=1):
        score = commercial_score(ad_read)
        is_comm = is_commercial_segment(ad_read)
        classification = classify_commercial_intent(ad_read)

        assert score > COMMERCIAL_SCORE_THRESHOLD, (
            f"Ad read #{idx} failed detection! Score: {score:.2f}, Text: {ad_read}"
        )
        assert is_comm is True
        assert classification.is_commercial is True
        assert len(classification.reasons) > 0
        detected_count += 1

    detection_rate = detected_count / len(KNOWN_PODCAST_AD_READS)
    assert detection_rate == 1.0


def test_valid_dialogue_false_positive_rate_is_zero() -> None:
    """SLA: <= 0.5% false positive rate on valid organic conversational dialogue."""
    for sample in VALID_DIALOGUE_SAMPLES:
        score = commercial_score(sample)
        is_comm = is_commercial_segment(sample)
        classification = classify_commercial_intent(sample)

        assert score <= 0.05, f"False positive detected! Score: {score:.2f}, Text: {sample}"
        assert is_comm is False
        assert classification.is_commercial is False


def test_outro_detector_catches_subscribe_ctas() -> None:
    """Verifies that channel subscription CTAs and sign-offs are tagged as commercial/outro."""
    for outro in OUTRO_CTA_SAMPLES:
        classification = classify_commercial_intent(outro)
        assert classification.is_outro is True
        assert classification.commercial_score >= COMMERCIAL_SCORE_THRESHOLD
        assert is_commercial_segment(outro) is True


def test_intro_teaser_deduplication() -> None:
    """Detects introductory duplicate teaser in first 90s when matching dialogue appears after 180s."""
    phrase_1 = "quantum computers will break RSA encryption within ten years and world governments are frantically preparing"
    phrase_2 = "today we will discuss modern cryptography and mathematics in detail"
    phrase_3 = "here is the historical context of cryptography starting from ancient caesar ciphers"

    words: list[Word] = []
    wid = 1

    # Intro segment at 5s - 25s (duplicate teaser preview)
    for w in phrase_1.split():
        words.append(Word(wid=f"w{wid}", text=w, start_ms=5_000 + wid * 800, end_ms=5_500 + wid * 800))
        wid += 1

    # Intro regular speech at 30s - 50s
    for w in phrase_2.split():
        words.append(Word(wid=f"w{wid}", text=w, start_ms=30_000 + wid * 800, end_ms=30_500 + wid * 800))
        wid += 1

    # Later body background at 120s - 160s
    for w in phrase_3.split():
        words.append(Word(wid=f"w{wid}", text=w, start_ms=120_000 + wid * 800, end_ms=120_500 + wid * 800))
        wid += 1

    # Full moment reappears in main body at 220s - 240s (>180s)
    for w in phrase_1.split():
        words.append(Word(wid=f"w{wid}", text=w, start_ms=220_000 + wid * 800, end_ms=220_500 + wid * 800))
        wid += 1

    teasers = detect_intro_teasers(words)
    assert len(teasers) > 0, "Failed to detect introductory duplicate teaser!"
    teaser_start, teaser_end = teasers[0]
    # Assert teaser start lies in the first 90 seconds
    assert teaser_start < 90_000
    assert teaser_end <= 90_000


def test_filter_commercial_windows_prunes_ad_reads_and_exclude_spans() -> None:
    """Candidate windows overlapping sponsor reads or exclude intervals are strictly pruned."""
    words = [
        # Normal content: 0s - 20s
        Word("w1", "This", 0, 500),
        Word("w2", "is", 500, 1000),
        Word("w3", "groundbreaking", 1000, 2000),
        Word("w4", "scientific", 2000, 3000),
        Word("w5", "research.", 3000, 4000),
        # Sponsor read: 25s - 45s
        Word("w6", "This", 25000, 25500),
        Word("w7", "episode", 25500, 26000),
        Word("w8", "is", 26000, 26500),
        Word("w9", "sponsored", 26500, 27000),
        Word("w10", "by", 27000, 27500),
        Word("w11", "NordVPN", 27500, 28000),
        Word("w12", "use", 28000, 28500),
        Word("w13", "promo", 28500, 29000),
        Word("w14", "code", 29000, 29500),
        Word("w15", "SAVE.", 29500, 30000),
        # Normal content: 50s - 70s
        Word("w16", "Let", 50000, 50500),
        Word("w17", "us", 50500, 51000),
        Word("w18", "examine", 51000, 51500),
        Word("w19", "the", 51500, 52000),
        Word("w20", "data.", 52000, 52500),
    ]

    windows = [
        Window("win-1", first=0, last=4, start_ms=0, end_ms=4000),
        Window("win-2", first=5, last=14, start_ms=25000, end_ms=30000),
        Window("win-3", first=15, last=19, start_ms=50000, end_ms=52500),
    ]

    # Without external exclude ranges: win-2 must be dropped because of commercial_score
    clean = filter_commercial_windows(windows, words)
    assert len(clean) == 2
    assert [w.window_id for w in clean] == ["win-1", "win-3"]

    # With external exclude range covering win-3: only win-1 survives
    clean_with_exclude = filter_commercial_windows(
        windows,
        words,
        exclude_ranges=[(48000, 55000)],
    )
    assert len(clean_with_exclude) == 1
    assert clean_with_exclude[0].window_id == "win-1"
