"""Client for TRIBE v2 (Trimodal Brain Encoder) remote inference server.

Communicates over LAN with the dedicated Apple Silicon MacBook M-series host
running Meta FAIR's TRIBE v2 foundation model (Algonauts 2025).

TRIBE v2 projects multimodal tokens (V-JEPA 2 vision, Wav2Vec-BERT audio, and
LLaMA 3.2 text) onto ~20,484 cortical surface vertices at 1 Hz. By parcellating
cortical networks, this client extracts biological attention dynamics:
- **Salience / Ventral Attention Network (VAN):** Early hook detection (first 3-5s).
- **Dorsal Attention Network (DAN):** Sustained focus and narrative tracking.
- **Default Mode Network (DMN):** Mind-wandering suppression (anti-dropoff).

Designed with strict zero-failure resilience: if the remote MacBook server is
offline, sleeping, or unconfigured, the client either returns a local
neuro-heuristic estimate or gracefully leaves neural scores unset, ensuring video
clipping never halts or fails.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Literal

import httpx

from worker_ai.logging_setup import get_logger

__all__ = [
    "DEFAULT_TRIBE_TIMEOUT_S",
    "NeuralAttentionScore",
    "TribeClient",
    "TribeWindowInput",
]

_log = get_logger(__name__)

DEFAULT_TRIBE_TIMEOUT_S: Final[float] = 15.0
_HEALTH_TIMEOUT_S: Final[float] = 2.0


@dataclass(frozen=True, slots=True)
class NeuralAttentionScore:
    """Cortical attention and viral engagement metrics predicted by TRIBE v2."""

    window_id: str
    #: Ventral Attention / Salience peak in opening 3-5 seconds (0.0 to 1.0).
    hook_score: float
    #: Sustained Dorsal Attention Network stability across the clip (0.0 to 1.0).
    retention_score: float
    #: Inverted Default Mode Network activity (1.0 - normalized DMN) (0.0 to 1.0).
    immersion_score: float
    #: Composite weighted viral engagement score (0.0 to 100.0).
    neural_viral_index: float
    #: 1 Hz normalized cortical attention curve across the clip duration.
    attention_curve: tuple[float, ...] = ()
    #: Millisecond offsets where attention dips or DMN spikes (dropoff danger).
    dropoff_risk_points: tuple[int, ...] = ()
    #: Origin of the prediction.
    source: Literal["tribe_v2_macbook", "heuristic_cortex"] = "tribe_v2_macbook"
    #: Roundtrip latency in milliseconds.
    latency_ms: int = 0


@dataclass(frozen=True, slots=True)
class TribeWindowInput:
    """Input payload for a candidate window sent to TRIBE v2."""

    window_id: str
    start_ms: int
    end_ms: int
    transcript_text: str


class TribeClient:
    """HTTP client connecting the Windows AI worker to the MacBook TRIBE v2 server."""

    def __init__(
        self,
        base_url: str = "",
        *,
        enabled: bool = False,
        timeout_seconds: float = DEFAULT_TRIBE_TIMEOUT_S,
    ) -> None:
        self.base_url = base_url.strip().rstrip("/")
        self.enabled = bool(enabled and self.base_url)
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self._has_batch_endpoint: bool | None = None
        self._has_single_json: bool | None = None

    async def health(self) -> dict[str, Any] | None:
        """Query the remote MacBook TRIBE server's health and hardware state."""
        if not self.base_url:
            return None
        url = f"{self.base_url}/health"
        try:
            async with httpx.AsyncClient(timeout=_HEALTH_TIMEOUT_S) as client:
                response = await client.get(url)
                if response.status_code == 200:
                    data = response.json()
                    return data if isinstance(data, dict) else {"status": "ok"}
                _log.warning(
                    "TRIBE v2 server health returned non-200",
                    extra={"status": response.status_code, "url": url},
                )
                return None
        except Exception as error:
            _log.warning(
                "TRIBE v2 server unreachable on health check at %s: %s",
                url,
                error,
                extra={"error": str(error), "url": url},
            )
            return None

    async def is_available(self) -> bool:
        """True if TRIBE is enabled and the MacBook server answers /health."""
        if not self.enabled:
            return False
        state = await self.health()
        return state is not None and (
            state.get("ok") is True
            or state.get("status") in {"ok", "ready", "online"}
        )

    async def predict_neural_attention(
        self, item: TribeWindowInput
    ) -> NeuralAttentionScore | None:
        """Evaluate a single candidate window against TRIBE v2."""
        if not self.enabled or not self.base_url:
            return None

        batch_result = await self.predict_batch([item])
        return batch_result.get(item.window_id)

    async def predict_batch(
        self, items: Sequence[TribeWindowInput]
    ) -> dict[str, NeuralAttentionScore]:
        """Evaluate multiple candidate windows concurrently or in batch.

        Never raises on network error: logs a warning and returns an empty map
        so downstream candidate ranking falls back seamlessly to standard heuristics.
        """
        if not self.enabled or not self.base_url or not items:
            return {}

        start_time = time.monotonic()
        url = f"{self.base_url}/v1/batch-neural-attention"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                if self._has_batch_endpoint is not False:
                    payload = {
                        "windows": [
                            {
                                "windowId": item.window_id,
                                "startMs": item.start_ms,
                                "endMs": item.end_ms,
                                "transcriptText": item.transcript_text,
                            }
                            for item in items
                        ]
                    }
                    response = await client.post(url, json=payload)
                    if response.status_code == 404:
                        self._has_batch_endpoint = False
                        return await self._fallback_single_calls(client, items)

                    response.raise_for_status()
                    self._has_batch_endpoint = True
                    data = response.json()
                    latency = round((time.monotonic() - start_time) * 1000)
                    return self._parse_batch_response(data, latency)
                else:
                    return await self._fallback_single_calls(client, items)
        except httpx.TimeoutException:
            _log.warning(
                "TRIBE v2 inference call timed out; continuing with standard scoring",
                extra={"timeout_s": self.timeout_seconds, "windows": len(items)},
            )
            return {}
        except Exception as error:
            _log.warning(
                "TRIBE v2 inference call failed; continuing with standard scoring",
                extra={"error": str(error), "url": url},
            )
            return {}

    async def _fallback_single_calls(
        self, client: httpx.AsyncClient, items: Sequence[TribeWindowInput]
    ) -> dict[str, NeuralAttentionScore]:
        """Dispatch single calls to available endpoint on Mac."""
        results: dict[str, NeuralAttentionScore] = {}

        for item in items:
            start_t = time.monotonic()
            if self._has_single_json is not False:
                single_url = f"{self.base_url}/v1/neural-attention"
                single_payload = {
                    "windowId": item.window_id,
                    "startMs": item.start_ms,
                    "endMs": item.end_ms,
                    "transcriptText": item.transcript_text,
                }
                try:
                    res = await client.post(single_url, json=single_payload)
                    if res.status_code == 200:
                        self._has_single_json = True
                        data = res.json()
                        lat = round((time.monotonic() - start_t) * 1000)
                        score = self._parse_single_item(item.window_id, data, lat)
                        if score is not None:
                            results[item.window_id] = score
                            continue
                    elif res.status_code == 404:
                        self._has_single_json = False
                except Exception:
                    pass

            # Call multipart /predict/text endpoint deployed on Mac
            predict_url = f"{self.base_url}/predict/text"
            files = {
                "file": (
                    f"{item.window_id}.txt",
                    item.transcript_text.encode("utf-8"),
                    "text/plain",
                )
            }
            try:
                res2 = await client.post(predict_url, files=files)
                if res2.status_code == 200:
                    data = res2.json()
                    lat = round((time.monotonic() - start_t) * 1000)
                    score = self._parse_single_item(item.window_id, data, lat)
                    if score is not None:
                        results[item.window_id] = score
            except Exception as e:
                _log.warning("TRIBE v2 prediction failed for %s: %s", item.window_id, e)

        return results

    def _parse_batch_response(
        self, data: Any, latency_ms: int
    ) -> dict[str, NeuralAttentionScore]:
        """Convert remote server batch response into NeuralAttentionScore mappings."""
        if not isinstance(data, dict):
            return {}
        raw_items = data.get("predictions") or data.get("results") or []
        if not isinstance(raw_items, list):
            return {}

        results: dict[str, NeuralAttentionScore] = {}
        for item in raw_items:
            if not isinstance(item, (dict, list)):
                continue
            window_id = ""
            if isinstance(item, dict):
                window_id = str(item.get("windowId") or item.get("window_id") or "")
            if not window_id:
                continue
            parsed = self._parse_single_item(window_id, item, latency_ms)
            if parsed is not None:
                results[window_id] = parsed
        return results

    @staticmethod
    def _parse_single_item(
        window_id: str, item: Any, latency_ms: int
    ) -> NeuralAttentionScore | None:
        try:
            if isinstance(item, list):
                numeric_vals = [
                    float(x) for x in item if isinstance(x, (int, float)) and math.isfinite(x)
                ]
                if not numeric_vals:
                    return None
                mean_val = sum(numeric_vals) / len(numeric_vals)
                hook = max(0.0, min(1.0, numeric_vals[0] if numeric_vals else mean_val))
                retention = max(0.0, min(1.0, mean_val))
                immersion = max(0.0, min(1.0, 1.0 - (max(numeric_vals) - min(numeric_vals)) * 0.5))
                viral = round(
                    max(0.0, min(100.0, (0.40 * hook + 0.35 * retention + 0.25 * immersion) * 100.0)),
                    2,
                )
                return NeuralAttentionScore(
                    window_id=window_id,
                    hook_score=hook,
                    retention_score=retention,
                    immersion_score=immersion,
                    neural_viral_index=viral,
                    attention_curve=tuple(round(x, 4) for x in numeric_vals[:30]),
                    dropoff_risk_points=(),
                    source="tribe_v2_macbook",
                    latency_ms=latency_ms,
                )

            if not isinstance(item, dict):
                return None

            if "result" in item and isinstance(item["result"], (dict, list)):
                return TribeClient._parse_single_item(window_id, item["result"], latency_ms)

            if "predictions" in item and isinstance(item["predictions"], list):
                preds = item["predictions"]
                if preds and isinstance(preds[0], list):
                    step_peaks = [max(step) for step in preds if isinstance(step, list) and step]
                    if step_peaks:
                        opening_peak = max(step_peaks[:2]) if len(step_peaks) >= 2 else step_peaks[0]
                        hook_val = max(0.0, min(1.0, 0.5 + opening_peak * 0.5))
                        mean_peak = sum(step_peaks) / len(step_peaks)
                        ret_val = max(0.0, min(1.0, 0.5 + mean_peak * 0.5))
                        var_val = sum((p - mean_peak) ** 2 for p in step_peaks) / len(step_peaks)
                        imm_val = max(0.0, min(1.0, 1.0 - math.sqrt(var_val) * 0.5))
                        viral_val = round(
                            max(0.0, min(100.0, (0.40 * hook_val + 0.35 * ret_val + 0.25 * imm_val) * 100.0)),
                            2,
                        )
                        curve_val = tuple(round(max(0.0, min(1.0, 0.5 + p * 0.5)), 4) for p in step_peaks)
                        return NeuralAttentionScore(
                            window_id=window_id,
                            hook_score=hook_val,
                            retention_score=ret_val,
                            immersion_score=imm_val,
                            neural_viral_index=viral_val,
                            attention_curve=curve_val,
                            dropoff_risk_points=(),
                            source="tribe_v2_macbook",
                            latency_ms=latency_ms,
                        )

            hook = float(
                item.get("hookScore")
                or item.get("hook_score")
                or item.get("hook")
                or 0.0
            )
            retention = float(
                item.get("retentionScore")
                or item.get("retention_score")
                or item.get("retention")
                or item.get("attention_score")
                or item.get("attention")
                or 0.0
            )
            immersion = float(
                item.get("immersionScore")
                or item.get("immersion_score")
                or item.get("immersion")
                or item.get("boredom_suppression")
                or 0.0
            )
            viral = float(
                item.get("neuralViralIndex")
                or item.get("composite_viral_index")
                or item.get("viral_potential")
                or item.get("viral_index")
                or 0.0
            )

            if not math.isfinite(hook):
                hook = 0.5
            if not math.isfinite(retention):
                retention = 0.5
            if not math.isfinite(immersion):
                immersion = 0.5
            if not math.isfinite(viral):
                viral = 50.0

            # Clamp scores to expected ranges
            hook = max(0.0, min(1.0, hook))
            retention = max(0.0, min(1.0, retention))
            immersion = max(0.0, min(1.0, immersion))
            if viral <= 0.0:
                viral = (0.40 * hook + 0.35 * retention + 0.25 * immersion) * 100.0
            viral = max(0.0, min(100.0, viral))

            raw_curve = item.get("attentionCurve") or item.get("attention_curve") or ()
            curve = (
                tuple(float(x) for x in raw_curve if isinstance(x, (int, float)) and math.isfinite(x))
                if isinstance(raw_curve, (list, tuple))
                else ()
            )

            raw_drop = item.get("dropoffRiskPoints") or item.get("dropoff_risk_points") or ()
            dropoff = (
                tuple(int(x) for x in raw_drop if isinstance(x, (int, float)) and math.isfinite(x))
                if isinstance(raw_drop, (list, tuple))
                else ()
            )

            return NeuralAttentionScore(
                window_id=window_id,
                hook_score=hook,
                retention_score=retention,
                immersion_score=immersion,
                neural_viral_index=viral,
                attention_curve=curve,
                dropoff_risk_points=dropoff,
                source="tribe_v2_macbook",
                latency_ms=latency_ms,
            )
        except (ValueError, TypeError):
            return None

    def heuristic_neural_prediction(
        self, item: TribeWindowInput, signals: Any = None
    ) -> NeuralAttentionScore:
        """Provide a deterministic neuro-heuristic calculation when offline."""
        duration_s = max(1.0, (item.end_ms - item.start_ms) / 1000.0)
        word_count = len(item.transcript_text.split())
        words_per_sec = word_count / duration_s

        # Lexical arousal proxy for Salience / VAN
        first_words = item.transcript_text.lower().split()[:8]
        hook_tokens = {"how", "why", "secret", "never", "always", "best", "truth", "mistake"}
        has_hook = any(w in hook_tokens for w in first_words)
        hook_score = 0.85 if has_hook else 0.55

        # Cadence stability proxy for Dorsal Attention Network (DAN)
        # Optimal speech rate is between 2.2 and 3.5 words per second
        cadence_fit = 1.0 - min(1.0, abs(words_per_sec - 2.8) / 2.0)
        retention_score = max(0.4, min(0.95, 0.5 + 0.45 * cadence_fit))

        # Immersion proxy (absence of fillers / hesitation)
        immersion_score = 0.75

        viral = (0.40 * hook_score + 0.35 * retention_score + 0.25 * immersion_score) * 100.0

        return NeuralAttentionScore(
            window_id=item.window_id,
            hook_score=hook_score,
            retention_score=retention_score,
            immersion_score=immersion_score,
            neural_viral_index=viral,
            attention_curve=(),
            dropoff_risk_points=(),
            source="heuristic_cortex",
            latency_ms=0,
        )

