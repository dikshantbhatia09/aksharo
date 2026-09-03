"""Apply accepted `sfx`/`music` pass items to a Resolve timeline (D09 brief §Scope 2).

`05-system-architecture.md`/CONTRACTS §2 amendment: audio clips on new tracks
(`MediaPool.ImportMedia` + `AppendToTimeline` on an audio track — `ResolveHost.import_audio_clip`),
fades via clip properties, ducking as keyframed volume where the API allows (documented limit,
see `host/resolve.py`'s `set_volume_keyframes` docstring). Only owned, panel-licensed assets are
ever placed — `licence.py`'s `check_licence_for_panel` is re-checked here, same rule as
`plugins/premiere-uxp/src/apply/sfxMusic.ts`, D43's "cloud render only" gate.
"""

from __future__ import annotations

from dataclasses import dataclass

from aksharo_core_app.host.resolve import ResolveHost, TimelineHandle, TimelineItemHandle
from aksharo_core_app.licence import (
    CLOUD_RENDER_ONLY_MESSAGE,
    LicenceSnapshot,
    check_licence_for_panel,
)
from aksharo_core_app.markers import HostMapping, stamp_item

SFX_TRACK_NAME = "Aksharo SFX"
MUSIC_TRACK_NAME = "Aksharo Music"
SILENT_VOLUME_DB = -60.0


@dataclass(frozen=True, slots=True)
class DuckSpec:
    depth_db: float
    attack_ms: float
    release_ms: float


@dataclass(frozen=True, slots=True)
class SfxMusicItem:
    item_id: str
    project_id: str
    kind: str  # "sfx" | "music"
    asset_id: str
    start_ms: float
    duration_ms: float
    gain_db: float
    fade_in_ms: float
    fade_out_ms: float
    duck: DuckSpec | None
    licence_snapshot: LicenceSnapshot
    rev: int = 0


@dataclass(frozen=True, slots=True)
class PlacedAudioClip:
    item_id: str
    track_item_id: str
    kind: str


@dataclass(frozen=True, slots=True)
class AudioClipRefusal:
    item_id: str
    kind: str
    asset_id: str
    reasons: tuple[str, ...]
    message: str = CLOUD_RENDER_ONLY_MESSAGE


@dataclass(frozen=True, slots=True)
class ApplySfxMusicResult:
    placed: tuple[PlacedAudioClip, ...]
    skipped: tuple[str, ...]  # item ids with no local asset path supplied
    refusals: tuple[AudioClipRefusal, ...]


def ms_to_frame(ms: float, fps: float) -> int:
    return round(ms / 1000.0 * fps)


def build_volume_keyframes(
    item: SfxMusicItem, fps: float
) -> list[tuple[int, float]]:
    """Fade-in/out volume keyframes (brief: "fades via clip properties")."""
    start_frame = ms_to_frame(item.start_ms, fps)
    end_frame = ms_to_frame(item.start_ms + item.duration_ms, fps)
    keyframes: list[tuple[int, float]] = []

    if item.fade_in_ms > 0:
        keyframes.append((start_frame, SILENT_VOLUME_DB))
        keyframes.append((start_frame + ms_to_frame(item.fade_in_ms, fps), item.gain_db))
    else:
        keyframes.append((start_frame, item.gain_db))

    if item.fade_out_ms > 0:
        keyframes.append(
            (max(end_frame - ms_to_frame(item.fade_out_ms, fps), start_frame), item.gain_db)
        )
        keyframes.append((end_frame, SILENT_VOLUME_DB))

    return keyframes


def build_duck_keyframes(item: SfxMusicItem, fps: float) -> list[tuple[int, float]] | None:
    """Ducking approximation on the dialogue track (documented approximation, matching
    `plugins/premiere-uxp/src/apply/sfxMusic.ts`'s own `buildDuckKeyframes`)."""
    if item.duck is None:
        return None
    start_frame = ms_to_frame(item.start_ms, fps)
    end_frame = ms_to_frame(item.start_ms + item.duration_ms, fps)
    attack_end = min(start_frame + ms_to_frame(item.duck.attack_ms, fps), end_frame)
    release_start = max(end_frame - ms_to_frame(item.duck.release_ms, fps), attack_end)
    return [
        (start_frame, 0.0),
        (attack_end, item.duck.depth_db),
        (release_start, item.duck.depth_db),
        (end_frame, 0.0),
    ]


def apply_sfx_music(
    host: ResolveHost,
    timeline: TimelineHandle,
    items: list[SfxMusicItem],
    asset_local_paths: dict[str, str],
    fps: float,
    dialogue_track_item: TimelineItemHandle | None = None,
) -> ApplySfxMusicResult:
    placed: list[PlacedAudioClip] = []
    skipped: list[str] = []
    refusals: list[AudioClipRefusal] = []
    # `ResolveHost.add_track` (per its Protocol docstring, "AddTrack(trackType) then name it via
    # SetTrackName") documents no idempotent "find by name" behaviour the way
    # `PremiereHost.ensureTrack` does — this dict is this function's own within-call dedupe so
    # two sfx items in the same `apply_sfx_music` call share one "Aksharo SFX" track rather than
    # each getting their own. It does NOT persist across separate calls/re-applies: a second
    # `apply_sfx_music` run on an already-built timeline will still add a new track, which is
    # flagged as an open item for a follow-up WP (mirroring the marker-based re-sync this module
    # does not yet perform for its own tracks, only for its own clips via `stamp_item`).
    track_index_by_name: dict[str, int] = {}

    for item in items:
        check = check_licence_for_panel(item.licence_snapshot)
        if not check.allowed:
            refusals.append(
                AudioClipRefusal(
                    item_id=item.item_id, kind=item.kind, asset_id=item.asset_id,
                    reasons=check.reasons,
                )
            )
            continue

        local_path = asset_local_paths.get(item.asset_id)
        if local_path is None:
            skipped.append(item.item_id)
            continue

        track_name = SFX_TRACK_NAME if item.kind == "sfx" else MUSIC_TRACK_NAME
        track_index = track_index_by_name.get(track_name)
        if track_index is None:
            track_index = host.add_track(timeline, "audio", track_name)
            track_index_by_name[track_name] = track_index
        start_frame = ms_to_frame(item.start_ms, fps)
        end_frame = ms_to_frame(item.start_ms + item.duration_ms, fps)
        clip = host.import_audio_clip(timeline, track_index, start_frame, end_frame, local_path)

        host.set_volume_keyframes(clip, build_volume_keyframes(item, fps))
        duck_keyframes = build_duck_keyframes(item, fps)
        if duck_keyframes is not None and dialogue_track_item is not None:
            host.set_volume_keyframes(dialogue_track_item, duck_keyframes)

        mapping = HostMapping(
            project_id=item.project_id, ref_kind="itemId", ref_id=item.item_id, rev=item.rev
        )
        stamp_item(host, clip, mapping)
        placed.append(
            PlacedAudioClip(item_id=item.item_id, track_item_id=clip.item_id, kind=item.kind)
        )

    return ApplySfxMusicResult(
        placed=tuple(placed), skipped=tuple(skipped), refusals=tuple(refusals)
    )
