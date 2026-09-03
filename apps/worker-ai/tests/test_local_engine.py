"""`worker_ai.evals.local_engine`: the metrics bridge C03b's Node harness calls (`09 §8`)."""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from worker_ai.evals.local_engine import LocalEngineScore, main, score_item


def test_identical_transcripts_score_zero_wer_and_cer() -> None:
    score = score_item("toh aaj hum shuru karte hain", "toh aaj hum shuru karte hain")
    assert score.wer == 0.0
    assert score.cer == 0.0
    assert score.onset_error_median_ms is None  # no word-onset lists given


def test_onset_error_is_the_median_absolute_difference() -> None:
    score = score_item(
        "toh aaj hum",
        "toh aaj hum",
        reference_words_ms=[0, 300, 600],
        hypothesis_words_ms=[10, 340, 590],
    )
    # |0-10|=10, |300-340|=40, |600-590|=10 -> sorted [10,10,40] -> median 10
    assert score.onset_error_median_ms == pytest.approx(10.0)


def test_onset_error_is_none_when_lists_differ_in_length() -> None:
    score = score_item(
        "toh aaj hum",
        "toh aaj",
        reference_words_ms=[0, 300, 600],
        hypothesis_words_ms=[0, 300],
    )
    assert score.onset_error_median_ms is None


def test_one_substitution_reflects_in_wer_not_only_cer() -> None:
    score = score_item("toh aaj hum", "toh aaj tum")
    assert score.wer == pytest.approx(1 / 3)
    assert 0 < score.cer < score.wer


def test_to_wire_rounds_and_is_json_serialisable() -> None:
    score = LocalEngineScore(wer=0.123456, cer=0.0, onset_error_median_ms=12.5)
    wire = score.to_wire()
    assert wire == {"wer": 0.1235, "cer": 0.0, "onsetErrorMedianMs": 12.5}
    json.dumps(wire)  # must not raise


def test_main_reads_stdin_json_and_writes_stdout_json(capsys: pytest.CaptureFixture[str]) -> None:
    payload = {
        "referenceText": "toh aaj hum",
        "hypothesisText": "toh aaj hum",
        "referenceWordsMs": [0, 300, 600],
        "hypothesisWordsMs": [5, 295, 610],
    }
    import io

    sys.stdin = io.StringIO(json.dumps(payload))
    try:
        exit_code = main([])
    finally:
        sys.stdin = sys.__stdin__
    assert exit_code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["wer"] == 0.0
    assert out["cer"] == 0.0
    assert out["onsetErrorMedianMs"] == pytest.approx(5.0)


def test_main_reports_invalid_json_as_a_clean_error(capsys: pytest.CaptureFixture[str]) -> None:
    import io

    sys.stdin = io.StringIO("not json")
    try:
        exit_code = main([])
    finally:
        sys.stdin = sys.__stdin__
    assert exit_code == 1
    assert "invalid JSON" in capsys.readouterr().err


def test_cli_subprocess_round_trip() -> None:
    """The exact invocation the Node harness uses: `python -m worker_ai.evals.local_engine`."""
    payload = json.dumps({"referenceText": "toh aaj hum", "hypothesisText": "toh aaj hum"})
    result = subprocess.run(
        [sys.executable, "-m", "worker_ai.evals.local_engine"],
        input=payload,
        capture_output=True,
        text=True,
        check=True,
    )
    out = json.loads(result.stdout)
    assert out == {"wer": 0.0, "cer": 0.0, "onsetErrorMedianMs": None}
