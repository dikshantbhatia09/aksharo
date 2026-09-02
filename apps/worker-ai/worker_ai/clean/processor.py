"""``ai.clean`` (B10) — denoise, optional de-reverb/de-esser, loudness normalise.

Input: ``audio48k.wav`` (CONTRACTS section 6). Output, uploaded to the derived
bucket next to it: ``clean48k-{cleanId}.wav`` and two 20 s A/B preview clips,
``preview-{cleanId}-original.mp3`` / ``preview-{cleanId}-cleaned.mp3``, taken from
the loudest region of the file. ``result`` also carries the metrics JSON the
brief asks for, so the API can store it on the ``audio_cleans`` row without a
second read of the object.

Long files are processed in :data:`worker_ai.clean.dsp.CHUNK_WINDOW_MS` windows
with a trailing :data:`worker_ai.clean.dsp.CHUNK_CROSSFADE_MS` overlap so peak
memory stays bounded regardless of file length (brief acceptance criterion 1:
a 60-minute file under 2 GB RSS) — each window is denoised, normalised and
released before the next is decoded.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np

from worker_ai.audio import Pcm, ffmpeg_path, write_wav
from worker_ai.callbacks import JobUsage
from worker_ai.clean.dsp import (
    CHUNK_CROSSFADE_MS,
    CHUNK_WINDOW_MS,
    STRENGTH_MIX_RATIO,
    TARGET_LUFS,
    TRUE_PEAK_CEILING_DBTP,
    CleanMetrics,
    Strength,
    clip_count,
    crossfade_concat,
    deess,
    integrated_loudness,
    mix,
    normalize_loudness,
    spectral_gate_denoise,
    suppress_reverb,
    true_peak_dbtp,
)
from worker_ai.logging_setup import get_logger
from worker_ai.processors.context import JobContext, JobFailureError, ProcessorOutcome
from worker_ai.storage import StorageError, clean_audio_key, clean_preview_key, derived_key

__all__ = ["ChunkResult", "process_clean", "run_clean_chain"]

_log = get_logger(__name__)

_PREVIEW_SECONDS = 20
_PREVIEW_WINDOW_MS = _PREVIEW_SECONDS * 1000


@dataclass(frozen=True, slots=True)
class ChunkResult:
    original: Pcm
    cleaned: Pcm


def _load_48k(context: JobContext) -> Pcm:
    """Fetch and decode ``audio48k.wav`` (A07's 48 kHz derived key, brief §Context)."""
    from worker_ai.audio import read_pcm

    media_id = context.payload_str("mediaId", required=True)
    local = context.payload_str("audioUri")
    if local:
        path = Path(local)
        if not path.is_file():
            raise JobFailureError(
                "worker/invalid_payload", f"audioUri {path.name} does not exist", retryable=False
            )
        return read_pcm(path, sample_rate=48_000)

    project_id = context.payload_str("projectId") or (context.envelope.project_id or "")
    if not project_id:
        raise JobFailureError(
            "worker/invalid_payload",
            "derived media keys need a projectId (CONTRACTS section 6)",
            retryable=False,
        )
    store = context.services.derived_store
    if store is None:
        raise JobFailureError(
            "worker/storage_unconfigured",
            "R2_ENDPOINT, R2_BUCKET_DERIVED and the R2 credentials are required",
            retryable=False,
        )
    try:
        key = derived_key(context.envelope.workspace_id, project_id, media_id, "audio48k.wav")
        destination = context.workdir / "audio48k.wav"
        store.download(key, destination)
    except StorageError as error:
        raise JobFailureError("worker/storage_unavailable", str(error), retryable=True) from error
    try:
        return read_pcm(destination, sample_rate=48_000)
    except Exception as error:
        raise JobFailureError(
            "worker/undecodable_audio", f"could not decode audio48k.wav: {error}", retryable=False
        ) from error


def _clean_one_window(pcm: Pcm, *, dereverb: bool, deesser: bool) -> Pcm:
    cleaned = spectral_gate_denoise(pcm)
    if dereverb:
        cleaned = suppress_reverb(cleaned)
    if deesser:
        cleaned = deess(cleaned)
    return cleaned


def run_clean_chain(
    original: Pcm,
    *,
    strength: Strength,
    target: Literal["social", "youtube", "podcast"],
    dereverb: bool,
    deesser: bool,
    window_ms: int = CHUNK_WINDOW_MS,
    crossfade_ms: int = CHUNK_CROSSFADE_MS,
) -> tuple[Pcm, CleanMetrics]:
    """Run the full chain and return the mixed, normalised output plus metrics.

    Chunked for any file longer than one window; a short clip runs in one pass
    with no crossfade and an identical result either way (the loop below
    degrades to a single iteration).
    """
    sample_rate = original.sample_rate
    window_samples = int(sample_rate * window_ms / 1000)
    crossfade_samples = int(sample_rate * crossfade_ms / 1000)
    total = len(original.samples)

    input_lufs = integrated_loudness(original)
    target_lufs = TARGET_LUFS[target]
    ratio = STRENGTH_MIX_RATIO[strength]

    processed_chunks: list[Pcm] = []
    cursor = 0
    while cursor < total or (cursor == 0 and total == 0):
        end = min(cursor + window_samples + crossfade_samples, total)
        window = Pcm(samples=original.samples[cursor:end], sample_rate=sample_rate)
        cleaned = _clean_one_window(window, dereverb=dereverb, deesser=deesser)
        blended = mix(window, cleaned, ratio)
        processed_chunks.append(blended)
        if end >= total:
            break
        cursor += window_samples

    processed = crossfade_concat(processed_chunks, crossfade_ms=crossfade_ms)
    normalized, output_lufs = normalize_loudness(
        processed, target_lufs=target_lufs, true_peak_ceiling_dbtp=TRUE_PEAK_CEILING_DBTP
    )

    metrics = CleanMetrics(
        input_lufs=input_lufs,
        output_lufs=output_lufs,
        snr_gain_db=_estimate_snr_gain(original, normalized),
        clipping_count=clip_count(normalized.samples),
        true_peak_dbtp=true_peak_dbtp(normalized.samples),
    )
    return normalized, metrics


def _estimate_snr_gain(original: Pcm, cleaned: Pcm) -> float:
    """Noise-floor drop as an SNR-gain proxy, in dB.

    A proxy rather than a true SNR — no clean reference exists for a real
    recording, consistent with how the noise floor itself is estimated in
    :func:`worker_ai.clean.dsp.spectral_gate_denoise`. Each signal is peak-
    normalised to 1.0 before its floor (10th-percentile short-time RMS) is
    measured, which is what makes the comparison meaningful: ``cleaned`` has
    just been loudness-normalised to a target LUFS that has nothing to do with
    ``original``'s level, and comparing raw floors would mostly measure that
    gain difference rather than how much quieter the noise got relative to the
    programme content.
    """
    length = min(len(original.samples), len(cleaned.samples))
    if length == 0:
        return 0.0
    frame = 2048
    n = max(length // frame, 1)

    def floor_db_relative_to_peak(samples: np.ndarray) -> float:
        peak = float(np.max(np.abs(samples))) + 1e-12
        normalized = samples / peak
        trimmed = (
            normalized[: n * frame].reshape(n, frame)
            if n * frame <= len(normalized)
            else normalized[None, :]
        )
        rms = np.sqrt(np.mean(np.square(trimmed, dtype=np.float64), axis=1)) + 1e-12
        return float(20.0 * np.log10(np.quantile(rms, 0.1)))

    before = floor_db_relative_to_peak(original.samples[:length])
    after = floor_db_relative_to_peak(cleaned.samples[:length])
    return before - after


def _loudest_window(pcm: Pcm, *, window_ms: int = _PREVIEW_WINDOW_MS) -> tuple[int, int]:
    """``[start_ms, end_ms)`` of the loudest ``window_ms`` stretch of ``pcm``."""
    window_samples = int(pcm.sample_rate * window_ms / 1000)
    total = len(pcm.samples)
    if total <= window_samples:
        return 0, pcm.duration_ms
    step = max(window_samples // 4, 1)
    best_start = 0
    best_energy = -1.0
    for start in range(0, total - window_samples, step):
        energy = float(
            np.mean(np.square(pcm.samples[start : start + window_samples], dtype=np.float64))
        )
        if energy > best_energy:
            best_energy = energy
            best_start = start
    start_ms = round(best_start * 1000 / pcm.sample_rate)
    return start_ms, start_ms + window_ms


def _encode_mp3(wav_path: Path, mp3_path: Path) -> Path:
    """20 s preview to MP3 via ffmpeg — the worker has no pure-Python encoder."""
    argv = [
        ffmpeg_path(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        str(wav_path),
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "128k",
        str(mp3_path),
    ]
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, shell=False, fixed binary
            argv, check=False, capture_output=True, timeout=120
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise JobFailureError(
            "worker/ffmpeg_failed", f"mp3 encode failed: {error}", retryable=True
        ) from error
    if completed.returncode != 0:
        tail = completed.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise JobFailureError(
            "worker/ffmpeg_failed", f"mp3 encode failed: {' / '.join(tail)}", retryable=True
        )
    return mp3_path


async def process_clean(context: JobContext) -> ProcessorOutcome:
    """Denoise, optionally de-reverb/de-ess, loudness-normalise, and upload."""
    clean_id = context.payload_str("cleanId", required=True)
    strength_raw = context.payload_str("strength", default="medium")
    target_raw = context.payload_str("target", default="social")
    dereverb = bool(context.envelope.payload.get("dereverb", False))
    deesser = bool(context.envelope.payload.get("deesser", False))

    if strength_raw not in STRENGTH_MIX_RATIO:
        raise JobFailureError(
            "worker/invalid_payload", f"unknown strength {strength_raw!r}", retryable=False
        )
    if target_raw not in TARGET_LUFS:
        raise JobFailureError(
            "worker/invalid_payload", f"unknown target {target_raw!r}", retryable=False
        )
    strength: Strength = strength_raw
    target: Literal["social", "youtube", "podcast"] = target_raw

    await context.progress(5, message="fetching audio48k.wav")
    original = _load_48k(context)

    await context.progress(20, message="denoising")
    normalized, metrics = run_clean_chain(
        original, strength=strength, target=target, dereverb=dereverb, deesser=deesser
    )
    await context.progress(70, message="rendering previews")

    media_id = context.payload_str("mediaId", required=True)
    project_id = context.payload_str("projectId") or (context.envelope.project_id or "")
    workspace_id = context.envelope.workspace_id

    cleaned_wav = context.workdir / f"clean48k-{clean_id}.wav"
    write_wav(cleaned_wav, normalized)

    start_ms, end_ms = _loudest_window(normalized)
    original_clip = Pcm(
        samples=original.samples[
            round(start_ms * original.sample_rate / 1000) : round(
                end_ms * original.sample_rate / 1000
            )
        ],
        sample_rate=original.sample_rate,
    )
    cleaned_clip = Pcm(
        samples=normalized.samples[
            round(start_ms * normalized.sample_rate / 1000) : round(
                end_ms * normalized.sample_rate / 1000
            )
        ],
        sample_rate=normalized.sample_rate,
    )
    original_wav = context.workdir / "preview-original.wav"
    cleaned_wav_clip = context.workdir / "preview-cleaned.wav"
    write_wav(original_wav, original_clip)
    write_wav(cleaned_wav_clip, cleaned_clip)
    original_mp3 = _encode_mp3(original_wav, context.workdir / f"preview-{clean_id}-original.mp3")
    cleaned_mp3 = _encode_mp3(cleaned_wav_clip, context.workdir / f"preview-{clean_id}-cleaned.mp3")

    await context.progress(90, message="uploading")
    store = context.services.derived_store
    output_keys: dict[str, str] = {}
    if store is not None and project_id:
        output_keys["cleanedAudioUrl"] = store.upload(
            cleaned_wav, clean_audio_key(workspace_id, project_id, media_id, clean_id)
        )
        output_keys["previewOriginalUrl"] = store.upload(
            original_mp3,
            clean_preview_key(workspace_id, project_id, media_id, clean_id, "original"),
        )
        output_keys["previewCleanedUrl"] = store.upload(
            cleaned_mp3, clean_preview_key(workspace_id, project_id, media_id, clean_id, "cleaned")
        )
    else:
        _log.warning(
            "no derived store configured; ai.clean output stays on local disk only",
            extra=context.envelope.log_fields(),
        )

    await context.progress(100, message="done")
    _log.info(
        "clean complete",
        extra={
            **context.envelope.log_fields(),
            "mediaId": media_id,
            "cleanId": clean_id,
            "strength": strength,
            "target": target,
            **metrics.to_wire(),
        },
    )
    return ProcessorOutcome(
        result={
            "cleanId": clean_id,
            "mediaId": media_id,
            "strength": strength,
            "target": target,
            "dereverb": dereverb,
            "deesser": deesser,
            "storageKeys": output_keys,
            "previewWindowMs": {"startMs": start_ms, "endMs": end_ms},
            "metrics": metrics.to_wire(),
        },
        usage=JobUsage(
            media_seconds=original.duration_ms / 1000,
            provider="worker-ai/clean",
            cost_minor=0,
        ),
    )
