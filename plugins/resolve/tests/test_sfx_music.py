from __future__ import annotations

from aksharo_core_app.host.resolve import FakeResolveHost, TimelineHandle
from aksharo_core_app.licence import LicenceSnapshot
from aksharo_core_app.markers import find_mapping
from aksharo_core_app.sfx_music import (
    DuckSpec,
    SfxMusicItem,
    apply_sfx_music,
    build_duck_keyframes,
    build_volume_keyframes,
)

FPS = 25.0


def _timeline() -> TimelineHandle:
    return TimelineHandle(name="tl", fps=FPS)


def _sfx_item(**overrides: object) -> SfxMusicItem:
    base: dict[str, object] = {
        "item_id": "sfx-1",
        "project_id": "proj-1",
        "kind": "sfx",
        "asset_id": "asset-1",
        "start_ms": 1000,
        "duration_ms": 400,
        "gain_db": -4,
        "fade_in_ms": 40,
        "fade_out_ms": 40,
        "duck": DuckSpec(depth_db=-8, attack_ms=20, release_ms=100),
        "licence_snapshot": LicenceSnapshot(allows_raw_file_delivery=True, surface=("panel",)),
    }
    base.update(overrides)
    return SfxMusicItem(**base)  # type: ignore[arg-type]


def _music_item(**overrides: object) -> SfxMusicItem:
    base: dict[str, object] = {
        "item_id": "music-1",
        "project_id": "proj-1",
        "kind": "music",
        "asset_id": "asset-partner-1",
        "start_ms": 0,
        "duration_ms": 4000,
        "gain_db": -12,
        "fade_in_ms": 0,
        "fade_out_ms": 0,
        "duck": None,
        "licence_snapshot": LicenceSnapshot(
            allows_raw_file_delivery=False, surface=("cloud_render",)
        ),
    }
    base.update(overrides)
    return SfxMusicItem(**base)  # type: ignore[arg-type]


def test_build_volume_keyframes_ramps_in_and_out() -> None:
    item = _sfx_item()
    keyframes = build_volume_keyframes(item, FPS)
    assert keyframes == [(25, -60.0), (26, -4), (34, -4), (35, -60.0)]


def test_build_volume_keyframes_flat_when_no_fade() -> None:
    item = _sfx_item(fade_in_ms=0, fade_out_ms=0)
    assert build_volume_keyframes(item, FPS) == [(25, -4)]


def test_build_duck_keyframes_dips_between_attack_and_release() -> None:
    # Python's `round()` is banker's rounding (round-half-to-even), unlike JS's `Math.round`
    # (round-half-away-from-zero); `ms_to_frame(20, 25)` (0.5) rounds to 0 here vs. 1 in the TS
    # side's own `msToFrames`. This is an accepted, documented divergence — the two hosts run
    # independent frame-rounding, not byte-identical maths; only the plan *shape* is required to
    # match (the parity fixture test), not every frame number for every fps/ms combination.
    item = _sfx_item()
    assert build_duck_keyframes(item, FPS) == [(25, 0.0), (25, -8), (33, -8), (35, 0.0)]


def test_build_duck_keyframes_none_without_a_duck_spec() -> None:
    item = _sfx_item(duck=None)
    assert build_duck_keyframes(item, FPS) is None


def test_apply_sfx_music_places_an_owned_panel_licensed_clip() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)

    result = apply_sfx_music(
        host, timeline, [_sfx_item()], {"asset-1": "s3://media/asset-1.wav"}, FPS
    )

    assert result.refusals == ()
    assert result.skipped == ()
    assert len(result.placed) == 1
    placed = result.placed[0]
    assert placed.item_id == "sfx-1"
    assert placed.kind == "sfx"

    clip = next(i for i in timeline.items if i.item_id == placed.track_item_id)
    assert clip.track_type == "audio"
    assert clip.properties["volumeKeyframes"] == [(25, -60.0), (26, -4), (34, -4), (35, -60.0)]
    mapping = find_mapping(host, clip)
    assert mapping is not None
    assert mapping.ref_id == "sfx-1"


def test_apply_sfx_music_refuses_a_partner_catalogue_item() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)

    result = apply_sfx_music(
        host, timeline, [_music_item()], {"asset-partner-1": "s3://media/partner.wav"}, FPS
    )

    assert result.placed == ()
    assert len(result.refusals) == 1
    assert result.refusals[0].item_id == "music-1"
    assert result.refusals[0].reasons == ("not-owned", "surface-not-allowed")


def test_apply_sfx_music_skips_an_item_with_no_downloaded_asset() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)

    result = apply_sfx_music(host, timeline, [_sfx_item()], {}, FPS)

    assert result.placed == ()
    assert result.skipped == ("sfx-1",)


def test_apply_sfx_music_reuses_the_same_track_for_two_sfx_items() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)

    items = [
        _sfx_item(item_id="sfx-a"),
        _sfx_item(item_id="sfx-b", start_ms=2000, duration_ms=400),
    ]
    result = apply_sfx_music(host, timeline, items, {"asset-1": "s3://media/asset-1.wav"}, FPS)

    assert len(result.placed) == 2
    audio_items = [i for i in timeline.items if i.track_type == "audio"]
    track_indices = {i.track_index for i in audio_items}
    assert len(track_indices) == 1
    # TimelineHandle defaults audio_track_count to 1; one add_track call brings it to 2.
    assert timeline.audio_track_count == 2


def test_apply_sfx_music_ducks_the_dialogue_track_item() -> None:
    host = FakeResolveHost()
    timeline = _timeline()
    host.set_timeline(timeline)
    dialogue_item = host.import_alpha_overlay(timeline, 1, 0, 100, "s3://media/dialogue.mov")

    apply_sfx_music(
        host, timeline, [_sfx_item()], {"asset-1": "s3://media/asset-1.wav"}, FPS,
        dialogue_track_item=dialogue_item,
    )

    assert dialogue_item.properties["volumeKeyframes"] == [(25, 0.0), (25, -8), (33, -8), (35, 0.0)]
