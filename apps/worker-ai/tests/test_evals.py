"""The eval harness: manifest format, WER/CER metrics, runner and CLI (`09 §8`)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from worker_ai.evals import (
    FIXTURES_DIR,
    EvalManifestError,
    available_sets,
    load_eval_set,
    run_eval_set,
)
from worker_ai.evals.__main__ import main
from worker_ai.evals.metrics import cer, median_onset_error_ms, normalise, score, wer
from worker_ai.providers.base import ProviderError
from worker_ai.providers.mock import MockProvider

# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def test_normalisation_strips_punctuation_and_case() -> None:
    assert normalise("Toh, AAJ hum!") == "toh aaj hum"


def test_normalisation_strips_the_devanagari_danda() -> None:
    """A Latin-only normaliser would score `।` as a substituted word."""
    assert normalise("आज हम बात करेंगे।") == "आज हम बात करेंगे"


def test_normalisation_collapses_whitespace_and_normalises_unicode() -> None:
    assert normalise("  toh \n\t aaj  ") == "toh aaj"
    # NFD and NFC forms of the same string must score identically.
    assert normalise("é") == normalise("é")


def test_wer_and_cer_are_zero_for_an_identical_transcript() -> None:
    assert wer("toh aaj hum", "Toh, aaj hum.") == 0.0
    assert cer("toh aaj hum", "Toh, aaj hum.") == 0.0


def test_one_substitution_in_three_words_is_a_third() -> None:
    assert wer("toh aaj hum", "toh aaj tum") == pytest.approx(1 / 3)


def test_cer_is_finer_grained_than_wer() -> None:
    """One wrong letter is a whole word wrong, but only one character wrong."""
    assert wer("banate", "banata") == 1.0
    assert cer("banate", "banata") == pytest.approx(1 / 6)


def test_empty_sides_are_handled_rather_than_dividing_by_zero() -> None:
    assert wer("", "") == 0.0
    assert wer("", "hallucinated") == 1.0
    assert cer("", "") == 0.0
    assert cer("", "x") == 1.0


def test_median_onset_error_needs_aligned_sequences() -> None:
    assert median_onset_error_ms([0, 100, 200], [10, 90, 260]) == 10.0
    assert median_onset_error_ms([0, 100], [5, 95, 200]) is None
    assert median_onset_error_ms([], []) is None


def test_median_onset_error_of_an_even_count_is_the_midpoint() -> None:
    assert median_onset_error_ms([0, 100], [20, 140]) == 30.0


def test_a_score_records_both_word_counts() -> None:
    result = score("hm-001", "toh aaj hum", "toh aaj")
    assert result.reference_words == 3
    assert result.hypothesis_words == 2
    assert result.to_wire()["itemId"] == "hm-001"


# ---------------------------------------------------------------------------
# Manifests
# ---------------------------------------------------------------------------


def test_the_shipped_hinglish_set_loads() -> None:
    assert "hinglish-mini" in available_sets()
    eval_set = load_eval_set("hinglish-mini")

    assert eval_set.language == "hi-en"
    assert eval_set.code_mix is True
    # `09 §8`: the real audio arrives with A00-05; the references are real now.
    assert eval_set.audio_available is False
    assert len(eval_set.items) == 3
    assert eval_set.items[0].id == "hm-001"
    assert eval_set.items[0].words is not None
    assert eval_set.items[0].words.is_file()
    assert eval_set.items[0].hints == ("Aksharo",)


def test_a_set_can_be_loaded_by_path() -> None:
    eval_set = load_eval_set(FIXTURES_DIR / "hinglish-mini")
    assert eval_set.name == "hinglish-mini"


def test_an_unknown_set_lists_what_is_available() -> None:
    with pytest.raises(EvalManifestError, match="hinglish-mini"):
        load_eval_set("no-such-set")


def test_available_sets_of_a_missing_directory_is_empty(tmp_path: Path) -> None:
    assert available_sets(tmp_path / "nothing") == ()


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ("- not a mapping", "must hold a mapping"),
        ("set: x\nitems: []", "lists no items"),
        ("set: x\nitems:\n  - reference: hi", "every item needs an id"),
        ("set: x\nitems:\n  - id: a\n    reference: '  '", "no reference transcript"),
        ("set: x\nitems:\n  - id: a\n    reference: hi\n    hints: 5", "malformed hints"),
    ],
)
def test_a_malformed_manifest_names_what_is_wrong(tmp_path: Path, body: str, message: str) -> None:
    directory = tmp_path / "broken"
    directory.mkdir()
    (directory / "manifest.yaml").write_text(body, encoding="utf-8")
    with pytest.raises(EvalManifestError, match=message):
        load_eval_set(directory)


def test_duplicate_item_ids_are_refused(tmp_path: Path) -> None:
    directory = tmp_path / "dupes"
    directory.mkdir()
    (directory / "manifest.yaml").write_text(
        "set: d\nitems:\n  - id: a\n    reference: x\n  - id: a\n    reference: y\n",
        encoding="utf-8",
    )
    with pytest.raises(EvalManifestError, match="duplicate item ids"):
        load_eval_set(directory)


def test_invalid_yaml_is_refused(tmp_path: Path) -> None:
    directory = tmp_path / "bad"
    directory.mkdir()
    (directory / "manifest.yaml").write_text("items: [\n", encoding="utf-8")
    with pytest.raises(EvalManifestError, match="not valid YAML"):
        load_eval_set(directory)


# ---------------------------------------------------------------------------
# The runner
# ---------------------------------------------------------------------------


async def test_the_mock_provider_scores_the_shipped_set() -> None:
    report = await run_eval_set(load_eval_set("hinglish-mini"), MockProvider())

    assert report.provider == "mock"
    assert len(report.scores) == 3
    assert report.skipped == ()
    # The fixture words differ from the references in two places out of 24, so
    # the corpus WER is small but not zero — a harness that always scored 0 would
    # be testing nothing.
    assert 0.0 < report.corpus_wer < 0.2
    assert 0.0 < report.corpus_cer < report.corpus_wer
    assert report.scores[0].wer == 0.0


async def test_an_item_whose_audio_is_missing_is_skipped_not_failed() -> None:
    """A provider that reads audio cannot run a set whose media has not shipped."""

    class _NeedsAudio(MockProvider):
        reads_audio = True

    report = await run_eval_set(load_eval_set("hinglish-mini"), _NeedsAudio())

    assert report.scores == ()
    assert len(report.skipped) == 3
    assert "A00-05" in report.skipped[0][1]
    assert report.corpus_wer == 0.0


async def test_a_provider_failure_skips_the_item_and_keeps_going(tmp_path: Path) -> None:
    directory = tmp_path / "tiny"
    (directory / "words").mkdir(parents=True)
    (directory / "manifest.yaml").write_text(
        "set: tiny\nlanguage: hi\nitems:\n"
        "  - id: a\n    reference: ek do\n    words: words/missing.json\n"
        "  - id: b\n    reference: ek do\n    words: words/b.json\n",
        encoding="utf-8",
    )
    (directory / "words" / "b.json").write_text(json.dumps(["ek", "do"]), encoding="utf-8")

    report = await run_eval_set(load_eval_set(directory), MockProvider())

    assert [item.item_id for item in report.scores] == ["b"]
    assert report.skipped[0][0] == "a"
    assert report.corpus_wer == 0.0


async def test_the_report_renders_a_table_and_json() -> None:
    report = await run_eval_set(load_eval_set("hinglish-mini"), MockProvider())

    table = report.table()
    assert "hinglish-mini" in table
    assert "hm-001" in table
    assert "corpus" in table

    wire = report.to_wire()
    assert wire["set"] == "hinglish-mini"
    assert len(wire["items"]) == 3


async def test_a_missing_word_fixture_is_a_provider_error(tmp_path: Path) -> None:
    from worker_ai.providers.base import TranscriptionRequest

    with pytest.raises(ProviderError):
        await MockProvider().transcribe(
            TranscriptionRequest(
                audio_uri="eval://x",
                options={"wordFixture": str(tmp_path / "missing.json")},
            )
        )


# ---------------------------------------------------------------------------
# The CLI
# ---------------------------------------------------------------------------


def test_the_cli_lists_the_installed_sets(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["list"]) == 0
    assert "hinglish-mini" in capsys.readouterr().out


def test_the_cli_prints_a_table(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run", "--set", "fixtures/hinglish-mini"]) == 0
    out = capsys.readouterr().out
    assert "hm-001" in out
    assert "corpus" in out


def test_the_cli_prints_json_on_request(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run", "--set", "hinglish-mini", "--json"]) == 0
    parsed = json.loads(capsys.readouterr().out)
    assert parsed["set"] == "hinglish-mini"
    assert parsed["provider"] == "mock"


def test_the_cli_gate_fails_a_regression(capsys: pytest.CaptureFixture[str]) -> None:
    """`09 §8`: a routing change is blocked on a WER regression."""
    assert main(["run", "--set", "hinglish-mini", "--max-wer", "0.0"]) == 1
    assert "exceeds" in capsys.readouterr().err


def test_the_cli_gate_passes_a_good_run() -> None:
    assert main(["run", "--set", "hinglish-mini", "--max-wer", "1.0"]) == 0


def test_the_cli_reports_an_unknown_set(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["run", "--set", "no-such-set"]) == 2
    assert "no eval set" in capsys.readouterr().err


def test_the_cli_refuses_a_provider_it_cannot_run() -> None:
    with pytest.raises(SystemExit, match="unknown provider"):
        main(["run", "--set", "hinglish-mini", "--provider", "deepgram"])


@pytest.mark.parametrize(
    "provider", ["mock", "sarvam", "elevenlabs", "assemblyai", "serverless-whisper"]
)
def test_the_harness_scores_every_adapter_from_its_recorded_session(
    provider: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """`09 §8` needs the harness to be able to run each lane, key or no key."""
    assert main(["run", "--set", "vendor-replay", "--provider", provider]) == 0
    printed = capsys.readouterr().out
    assert "provider " + provider in printed
    assert "corpus" in printed


@pytest.mark.parametrize("provider", ["sarvam", "elevenlabs", "assemblyai"])
def test_a_replayed_vendor_parses_its_own_fixture_exactly(provider: str) -> None:
    """A non-zero WER here is an adapter bug, not a vendor measurement."""
    from worker_ai.evals.replay import build_replay_provider
    from worker_ai.evals.runner import run_eval_set

    adapter, _session = build_replay_provider(provider)
    report = asyncio.run(run_eval_set(load_eval_set("vendor-replay"), adapter))
    assert report.skipped == ()
    assert report.corpus_wer == 0.0


def test_live_asks_the_registry_rather_than_the_fixtures() -> None:
    """`--live` is the A00-06 path and must fail loudly without a key."""
    with pytest.raises(SystemExit, match="cannot run live here"):
        main(["run", "--set", "vendor-replay", "--provider", "sarvam", "--live"])
