"""MKF2 round-trip tests, including against fixture bytes produced by the TS
`encodeKeyframes` in `packages/edg/src/passes/keyframes.ts` (same algorithm,
same test vectors as `packages/edg/src/passes/keyframes.test.ts`) — this is
the acceptance-criteria "MKF2 round-trip against the TS fixture" check.
"""

from __future__ import annotations

import pytest

from aksharo_core_app.keyframes import (
    Keyframe,
    KeyframeDecodeError,
    decode_keyframes,
    encode_keyframes,
)

# Produced by running the TS `encodeKeyframes` (packages/edg/src/passes/keyframes.ts)
# over `encodeKeyframes([])` and over the exact "typical zoom curve" fixture from
# `keyframes.test.ts`, then hex-dumping the resulting bytes.
TS_EMPTY_FIXTURE_HEX = "4d4b46320100000000000000"
TS_TYPICAL_CURVE_FIXTURE_HEX = (
    "4d4b46320100000003000000000000000000803f0000003f0000003f00000000"
    "000034439a99993f0000003f0000003f0000803f000043449a99993f0000003f0000003f0000803f"
)


def test_round_trips_empty_curve() -> None:
    packed = encode_keyframes([])
    assert len(packed) == 12
    assert decode_keyframes(packed) == []


def test_matches_ts_empty_fixture_bytes() -> None:
    assert encode_keyframes([]).hex() == TS_EMPTY_FIXTURE_HEX


def test_round_trips_typical_zoom_curve_against_ts_fixture() -> None:
    packed = bytes.fromhex(TS_TYPICAL_CURVE_FIXTURE_HEX)
    decoded = decode_keyframes(packed)
    assert [f.t_ms for f in decoded] == pytest.approx([0.0, 180.0, 780.0])
    assert [round(f.zoom, 5) for f in decoded] == [1.0, 1.2, 1.2]
    assert [f.ease for f in decoded] == ["linear", "inOut", "inOut"]

    frames = [
        Keyframe(t_ms=0, zoom=1, cx=0.5, cy=0.5, ease="linear"),
        Keyframe(t_ms=180, zoom=1.2, cx=0.5, cy=0.5, ease="inOut"),
        Keyframe(t_ms=780, zoom=1.2, cx=0.5, cy=0.5, ease="inOut"),
    ]
    assert encode_keyframes(frames) == packed


def test_sorts_rows_by_t_ms_before_packing() -> None:
    packed = encode_keyframes(
        [
            Keyframe(t_ms=500, zoom=1, cx=0.1, cy=0.1, ease="linear"),
            Keyframe(t_ms=0, zoom=1, cx=0.2, cy=0.2, ease="inOut"),
        ]
    )
    decoded = decode_keyframes(packed)
    assert [f.t_ms for f in decoded] == [0, 500]
    assert [f.ease for f in decoded] == ["inOut", "linear"]


def test_rejects_bad_magic() -> None:
    with pytest.raises(KeyframeDecodeError):
        decode_keyframes(bytes(12))


def test_rejects_length_disagreeing_with_count_header() -> None:
    packed = encode_keyframes([Keyframe(t_ms=0, zoom=1, cx=0.5, cy=0.5, ease="linear")])
    with pytest.raises(KeyframeDecodeError):
        decode_keyframes(packed[:-1])


def test_rejects_unsupported_version() -> None:
    packed = bytearray(encode_keyframes([Keyframe(t_ms=0, zoom=1, cx=0.5, cy=0.5, ease="linear")]))
    packed[4:8] = (99).to_bytes(4, "little")
    with pytest.raises(KeyframeDecodeError):
        decode_keyframes(bytes(packed))


def test_rejects_buffer_shorter_than_header() -> None:
    with pytest.raises(KeyframeDecodeError):
        decode_keyframes(bytes(4))
