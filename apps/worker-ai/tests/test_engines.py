"""Flash/Pro engine presets (D07 SS2) — Python mirror of `@montaj/config`'s `engines.ts`."""

from __future__ import annotations

from worker_ai.passes.engines import ENGINE_PRESETS, engine_params_for


def test_flash_is_vad_only_540p_cached_no_repass() -> None:
    flash = ENGINE_PRESETS["flash"]
    assert flash.autocut.strategy == "vad_only"
    assert flash.autocut.cached_picks is True
    assert flash.tracking.resolution == "540p"
    assert flash.asr.repass_model is None


def test_pro_is_llm_reranked_full_res_with_a_repass_model() -> None:
    pro = ENGINE_PRESETS["pro"]
    assert pro.autocut.strategy == "llm_reranked"
    assert pro.autocut.cached_picks is False
    assert pro.tracking.resolution == "full_res"
    assert pro.asr.repass_model is not None


def test_engine_params_for_defaults_to_flash() -> None:
    assert engine_params_for(None) is ENGINE_PRESETS["flash"]
    assert engine_params_for("pro") is ENGINE_PRESETS["pro"]
    assert engine_params_for("unknown") is ENGINE_PRESETS["flash"]  # type: ignore[arg-type]
