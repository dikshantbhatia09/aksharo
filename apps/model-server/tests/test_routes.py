"""The four routes over HTTP, with fake models: shapes, times and usage."""

from __future__ import annotations

from collections.abc import Sequence

from fastapi import FastAPI
from fastapi.testclient import TestClient

from model_server.models.base import TranscribeJob, TranscribeOutput
from tests.conftest import FIXTURE_WORDS, build_app, inline, make_wav


def test_transcribe_returns_words_in_seconds(
    client: TestClient, auth: dict[str, str], audio: str
) -> None:
    response = client.post(
        "/transcribe",
        json={"audio": audio, "language": "hi", "wordTimestamps": True, "model": "large-v3-turbo"},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["language"] == "hi"
    assert 0.0 < body["languageProbability"] <= 1.0
    assert body["durationS"] == 4.0
    assert body["model"] == "large-v3-turbo"
    assert body["requestId"]
    assert [word["word"] for word in body["words"]] == list(FIXTURE_WORDS)
    # Times are seconds and monotonic, and inside the clip.
    starts = [word["start"] for word in body["words"]]
    assert starts == sorted(starts)
    assert body["words"][-1]["end"] <= body["durationS"] + 0.001


def test_transcribe_reports_usage(client: TestClient, auth: dict[str, str], audio: str) -> None:
    body = client.post("/transcribe", json={"audio": audio}, headers=auth).json()
    usage = body["usage"]
    assert usage["audioSeconds"] == 4.0
    assert usage["model"] == "large-v3-turbo"
    assert usage["batchSize"] >= 1
    assert usage["gpuSeconds"] >= 0.0


def test_transcribe_passes_beam_and_temperature_through(
    app: FastAPI, auth: dict[str, str], audio: str
) -> None:
    captured: list[tuple[int, tuple[float, ...], str | None]] = []
    original = app.state.registry.asr.transcribe

    def spy(jobs: Sequence[TranscribeJob]) -> list[TranscribeOutput]:
        captured.extend((job.beam_size, job.temperature, job.initial_prompt) for job in jobs)
        outputs: list[TranscribeOutput] = original(jobs)
        return outputs

    app.state.registry.asr.transcribe = spy
    with TestClient(app) as client:
        client.post(
            "/transcribe",
            json={
                "audio": audio,
                "beamSize": 3,
                "temperature": [0.0, 0.2, 0.4],
                "hints": ["Aksharo", "reels"],
            },
            headers=auth,
        )
    assert captured == [(3, (0.0, 0.2, 0.4), "Aksharo, reels")]


def test_align_returns_file_times_for_a_span(
    client: TestClient, auth: dict[str, str], audio: str
) -> None:
    response = client.post(
        "/align",
        json={
            "audio": audio,
            "words": ["toh", "aaj", "hum"],
            "language": "hi",
            "startS": 1.0,
            "endS": 3.0,
        },
        headers=auth,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["licence"] == "MIT"
    assert body["model"].startswith("ai4bharat/indicwav2vec")
    assert body["durationS"] == 2.0
    assert [word["word"] for word in body["words"]] == ["toh", "aaj", "hum"]
    # File time, not span time: the span started at 1.0 s.
    assert body["words"][0]["start"] >= 1.0
    assert body["words"][-1]["end"] <= 3.001


def test_align_refuses_a_language_with_no_checkpoint(auth: dict[str, str], audio: str) -> None:
    from tests.conftest import FakeAligner

    app = build_app(aligner=FakeAligner(missing_for=("sw",)))
    with TestClient(app) as client:
        response = client.post(
            "/align", json={"audio": audio, "words": ["jambo"], "language": "sw"}, headers=auth
        )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "model-server/model-unavailable"


def test_diarise_surfaces_the_cc_by_attribution(
    client: TestClient, auth: dict[str, str], audio: str
) -> None:
    response = client.post("/diarise", json={"audio": audio, "numSpeakers": 2}, headers=auth)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["model"] == "pyannote/speaker-diarization-community-1"
    assert [turn["speaker"] for turn in body["turns"]] == ["SPEAKER_00", "SPEAKER_01"]
    versions = body["engineVersions"]
    assert versions["diarise.licence"] == "CC-BY-4.0"
    assert "CC-BY-4.0" in versions["diarise.attribution"]
    assert "pyannote" in versions["diarise.attribution"]


def test_detect_language_pools_windows_and_echoes_the_text_signal(
    client: TestClient, auth: dict[str, str], audio: str
) -> None:
    response = client.post(
        "/detect-language",
        json={
            "audio": audio,
            "windows": [[0, 2000], [2000, 4000]],
            "textSignal": {"language": "hi-en", "confidence": 0.62},
        },
        headers=auth,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["language"] == "hi"
    assert body["probability"] == 0.88
    assert len(body["windows"]) == 2
    assert body["windows"][0]["startMs"] == 0
    # The caller's own signal comes back untouched; the server never folds it in.
    assert body["textSignal"] == {"language": "hi-en", "confidence": 0.62}


def test_detect_language_defaults_to_the_first_thirty_seconds(
    client: TestClient, auth: dict[str, str]
) -> None:
    body = client.post(
        "/detect-language", json={"audio": inline(make_wav(2.0))}, headers=auth
    ).json()
    assert len(body["windows"]) == 1
    assert body["windows"][0]["startMs"] == 0
    assert body["windows"][0]["endMs"] == 2000


def test_audio_longer_than_the_chunk_limit_is_refused(auth: dict[str, str]) -> None:
    app = build_app(settings=None)
    app.state.settings = app.state.settings  # keep the default 600 s
    with TestClient(app) as client:
        response = client.post(
            "/transcribe",
            json={"audio": inline(make_wav(3.0))},
            headers=auth,
        )
    assert response.status_code == 200

    from tests.conftest import build_settings

    short = build_app(settings=build_settings(max_audio_seconds=1.0))
    with TestClient(short) as client:
        response = client.post("/transcribe", json={"audio": inline(make_wav(3.0))}, headers=auth)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "model-server/bad-audio"


def test_a_malformed_body_is_422_and_does_not_echo_the_body(
    client: TestClient, auth: dict[str, str]
) -> None:
    response = client.post("/transcribe", json={"language": "hi"}, headers=auth)
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "model-server/invalid-request"
    assert "audio" not in response.text.lower().replace("model-server", "")


def test_unknown_request_fields_are_ignored_not_rejected(
    client: TestClient, auth: dict[str, str], audio: str
) -> None:
    # ServerlessWhisperProvider splats request.options into the body; a server
    # that 422'd on an option it had not shipped yet would break every rollout.
    response = client.post(
        "/transcribe",
        json={"audio": audio, "somethingTheRoutingTableAddedLater": True},
        headers=auth,
    )
    assert response.status_code == 200
