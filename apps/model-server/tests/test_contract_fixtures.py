"""The wire contract, checked against A10's recorded session — not against prose.

``apps/worker-ai/worker_ai/fixtures/vendor/gpu-whisper/session.json`` is what the
worker's adapters were written and tested against. If this server returns a body
that the recording would not match, the worker breaks in production and every
test on both sides still passes, because each side is testing its own idea of the
contract. So this file reads the recording and asserts the live response is a
**superset with matching types**: every recorded key present, every recorded type
the same, every recorded list-item key present on the live items.

Supersets are allowed deliberately (this server adds ``usage`` and
``engineVersions``, which the recording predates) and missing keys are not.

The second half checks the two constants the two apps must agree on by *value*:
pyannote's model id and its CC-BY-4.0 attribution string. They are read out of the
worker's source with ``ast`` rather than imported, because ``worker_ai`` is a
different app with a different virtual environment and this test must not need it
installed.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from model_server.models.diariser import (
    PYANNOTE_ATTRIBUTION,
    PYANNOTE_LICENCE,
    PYANNOTE_MODEL,
)
from tests.conftest import GPU_FIXTURE, WORKER_AI, inline, make_wav

pytestmark = pytest.mark.skipif(
    not GPU_FIXTURE.is_file(), reason="apps/worker-ai's recorded GPU session is not present"
)


def _recorded() -> dict[str, dict[str, Any]]:
    """The recorded response body for each path in the session file."""
    session = json.loads(GPU_FIXTURE.read_text(encoding="utf-8"))
    return {
        str(exchange["path"]): exchange["json"]
        for exchange in session["exchanges"]
        if exchange.get("json") is not None
    }


def _same_kind(recorded: Any, live: Any) -> bool:
    """Type equality, with ints accepted where a float was recorded."""
    if isinstance(recorded, bool) or isinstance(live, bool):
        return isinstance(recorded, bool) and isinstance(live, bool)
    if isinstance(recorded, int | float):
        return isinstance(live, int | float)
    return isinstance(live, type(recorded))


def assert_superset(recorded: Any, live: Any, path: str = "") -> None:
    """Every recorded key exists on the live body, with the same kind of value."""
    assert _same_kind(recorded, live), (
        "type changed at "
        + (path or "<root>")
        + ": recorded "
        + type(recorded).__name__
        + ", live "
        + type(live).__name__
    )
    if isinstance(recorded, dict):
        for key, value in recorded.items():
            assert key in live, "missing key " + path + "." + key + " in the live response"
            assert_superset(value, live[key], path + "." + key)
    elif isinstance(recorded, list) and recorded:
        assert live, "the live response returned an empty list at " + path
        # Shape, not length: the recording's ten words are one example of a list
        # of words, not a promise that every clip has ten.
        assert_superset(recorded[0], live[0], path + "[0]")


def test_transcribe_matches_the_recorded_shape(client: TestClient, auth: dict[str, str]) -> None:
    recorded = _recorded()["/transcribe"]
    live = client.post(
        "/transcribe",
        json={
            "audio": inline(make_wav(4.0)),
            "language": "hi",
            "wordTimestamps": True,
            "model": "large-v3-turbo",
        },
        headers=auth,
    ).json()
    assert_superset(recorded, live)


def test_diarise_matches_the_recorded_shape(client: TestClient, auth: dict[str, str]) -> None:
    recorded = _recorded()["/diarise"]
    live = client.post(
        "/diarise",
        json={"audio": inline(make_wav(4.0)), "model": PYANNOTE_MODEL},
        headers=auth,
    ).json()
    assert_superset(recorded, live)
    assert live["model"] == recorded["model"]


def test_detect_language_matches_the_recorded_shape(
    client: TestClient, auth: dict[str, str]
) -> None:
    recorded = _recorded()["/detect-language"]
    live = client.post(
        "/detect-language",
        json={"audio": inline(make_wav(4.0)), "windows": [[0, 4000]]},
        headers=auth,
    ).json()
    assert_superset(recorded, live)


def test_align_words_use_the_same_shape_as_transcribe(
    client: TestClient, auth: dict[str, str]
) -> None:
    """``/align`` has no recording yet, so it is pinned to ``/transcribe``'s word shape.

    The worker's ``_words()`` parser reads ``{start, end, word, probability}``; an
    aligner that answered ``{startS, endS, text}`` would need a second parser for
    no reason, and A10b would find that out at integration time.
    """
    recorded_word = _recorded()["/transcribe"]["words"][0]
    live = client.post(
        "/align",
        json={"audio": inline(make_wav(4.0)), "words": ["toh", "aaj"], "language": "hi"},
        headers=auth,
    ).json()
    assert_superset(recorded_word, live["words"][0], ".words[0]")


# ---------------------------------------------------------------------------
# Constants both apps must agree on, by value
# ---------------------------------------------------------------------------


def _constant(source: Path, name: str) -> str:
    """Read a module-level string constant without importing the module."""
    tree = ast.parse(source.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if name in targets:
                return str(ast.literal_eval(node.value))
    raise AssertionError(name + " is not a module-level constant in " + str(source))


@pytest.mark.skipif(
    not (WORKER_AI / "diarisation" / "pyannote.py").is_file(),
    reason="apps/worker-ai is not present",
)
def test_pyannote_constants_match_the_worker() -> None:
    source = WORKER_AI / "diarisation" / "pyannote.py"
    assert _constant(source, "PYANNOTE_MODEL") == PYANNOTE_MODEL
    assert _constant(source, "PYANNOTE_LICENCE") == PYANNOTE_LICENCE
    # CC-BY-4.0 obliges a specific attribution; two copies that drift are two
    # chances to ship the wrong one.
    assert _constant(source, "PYANNOTE_ATTRIBUTION") == PYANNOTE_ATTRIBUTION


@pytest.mark.skipif(
    not (WORKER_AI / "alignment" / "mms.py").is_file(), reason="apps/worker-ai is not present"
)
def test_no_mms_checkpoint_is_reachable_from_this_server() -> None:
    """Decision **D77**: the CC-BY-NC-4.0 MMS export never ships.

    The worker still carries an ``MmsAligner`` class, inert without a model
    directory, which is A10b's to remove. What this server must guarantee is that
    *its* aligner can never resolve to MMS for any language, including ones with
    no Indic checkpoint.
    """
    from model_server.models.aligner import FAMILIES, family_for

    assert "mms" not in FAMILIES
    for language in ("hi", "ta", "en", "de", "sw", "zz", ""):
        assert family_for(language) in {"indicwav2vec", "xlsr53"}
        assert "mms" not in FAMILIES[family_for(language)][0].casefold()
