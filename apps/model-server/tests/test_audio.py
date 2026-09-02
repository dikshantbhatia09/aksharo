"""Decoding the ``audio`` field: WAV, inline base64, local paths and URLs."""

from __future__ import annotations

import base64
import io
import struct
import wave
from pathlib import Path

import numpy as np
import pytest

from model_server.audio import TARGET_SAMPLE_RATE, decode_wav, load_audio, resample
from model_server.errors import AudioError, PayloadTooLargeError
from tests.conftest import SPEECH_CLIP, inline, make_wav

CAP = 64 * 1024 * 1024


def test_a_16k_mono_wav_decodes_unchanged() -> None:
    pcm = decode_wav(make_wav(1.0))
    assert pcm.sample_rate == TARGET_SAMPLE_RATE
    assert len(pcm.samples) == TARGET_SAMPLE_RATE
    assert pcm.samples.dtype == np.float32
    assert abs(pcm.duration_s - 1.0) < 0.001
    assert float(np.max(np.abs(pcm.samples))) <= 1.0


def test_a_stereo_wav_is_downmixed() -> None:
    frames = b"".join(struct.pack("<hh", 1000, -1000) for _ in range(16_000))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes(frames)
    pcm = decode_wav(buffer.getvalue())
    assert len(pcm.samples) == 16_000
    # Equal and opposite channels average to silence.
    assert float(np.max(np.abs(pcm.samples))) < 1e-6


def test_a_44k_wav_is_resampled_to_16k() -> None:
    pcm = decode_wav(make_wav(1.0, rate=44_100))
    assert pcm.sample_rate == TARGET_SAMPLE_RATE
    assert abs(len(pcm.samples) - TARGET_SAMPLE_RATE) <= 1


def test_resample_is_a_no_op_at_the_target_rate() -> None:
    samples = np.linspace(0, 1, 100, dtype=np.float32)
    assert resample(samples, 16_000, 16_000) is samples
    assert len(resample(np.array([], dtype=np.float32), 44_100, 16_000)) == 0


def test_inline_base64_and_data_uris_both_work() -> None:
    payload = make_wav(0.5)
    encoded = base64.b64encode(payload).decode("ascii")
    for spec in ("data:audio/wav;base64," + encoded, "base64:" + encoded):
        pcm = load_audio(spec, max_bytes=CAP, max_seconds=600)
        assert abs(pcm.duration_s - 0.5) < 0.01


def test_a_local_path_and_a_file_url_both_work(tmp_path: Path) -> None:
    path = tmp_path / "audio16k.wav"
    path.write_bytes(make_wav(0.25))
    assert abs(load_audio(str(path), max_bytes=CAP, max_seconds=600).duration_s - 0.25) < 0.01
    assert abs(load_audio(path.as_uri(), max_bytes=CAP, max_seconds=600).duration_s - 0.25) < 0.01


def test_an_empty_or_missing_audio_field_is_a_readable_error() -> None:
    with pytest.raises(AudioError, match="no audio"):
        load_audio("", max_bytes=CAP, max_seconds=600)
    with pytest.raises(AudioError, match="no audio at the path"):
        load_audio("/no/such/file.wav", max_bytes=CAP, max_seconds=600)


def test_bad_base64_and_bad_wav_are_errors_not_tracebacks() -> None:
    with pytest.raises(AudioError, match="valid base64"):
        load_audio("base64:not!base64", max_bytes=CAP, max_seconds=600)
    with pytest.raises(AudioError):
        load_audio(inline(b"RIFFnonsense"), max_bytes=CAP, max_seconds=600)


def test_the_byte_cap_is_enforced_on_inline_audio() -> None:
    with pytest.raises(PayloadTooLargeError):
        load_audio(inline(make_wav(1.0)), max_bytes=100, max_seconds=600)


def test_the_byte_cap_is_enforced_on_a_local_file(tmp_path: Path) -> None:
    path = tmp_path / "big.wav"
    path.write_bytes(make_wav(1.0))
    with pytest.raises(PayloadTooLargeError):
        load_audio(str(path), max_bytes=100, max_seconds=600)


def test_the_chunk_duration_cap_names_the_fix() -> None:
    with pytest.raises(AudioError, match="chunk it at VAD boundaries"):
        load_audio(inline(make_wav(2.0)), max_bytes=CAP, max_seconds=1.0)


def test_an_https_url_is_fetched_through_the_injected_client() -> None:
    import httpx2

    payload = make_wav(0.5)

    def handler(request: httpx2.Request) -> httpx2.Response:
        assert str(request.url) == "https://r2.test/audio16k.wav"
        return httpx2.Response(200, content=payload)

    client = httpx2.Client(transport=httpx2.MockTransport(handler))
    pcm = load_audio(
        "https://r2.test/audio16k.wav", max_bytes=CAP, max_seconds=600, http_client=client
    )
    assert abs(pcm.duration_s - 0.5) < 0.01


def test_a_url_that_declares_too_many_bytes_is_refused_before_the_download() -> None:
    import httpx2

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, content=b"x" * 10, headers={"content-length": "999999999"})

    client = httpx2.Client(transport=httpx2.MockTransport(handler))
    with pytest.raises(PayloadTooLargeError):
        load_audio("https://r2.test/big.wav", max_bytes=1024, max_seconds=600, http_client=client)


def test_a_url_that_errors_is_an_audio_error() -> None:
    import httpx2

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(404)

    client = httpx2.Client(transport=httpx2.MockTransport(handler))
    with pytest.raises(AudioError, match="404"):
        load_audio("https://r2.test/gone.wav", max_bytes=CAP, max_seconds=600, http_client=client)


@pytest.mark.skipif(not SPEECH_CLIP.is_file(), reason="A10's speech-5s clip is not present")
def test_the_five_second_fixture_clip_decodes() -> None:
    pcm = load_audio(str(SPEECH_CLIP), max_bytes=CAP, max_seconds=600)
    assert pcm.sample_rate == TARGET_SAMPLE_RATE
    assert 4.9 < pcm.duration_s < 5.1
