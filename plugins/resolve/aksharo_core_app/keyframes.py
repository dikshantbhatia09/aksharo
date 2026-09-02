"""Python decoder for the MKF2 packed keyframe format.

Port of `packages/edg/src/passes/keyframes.ts` (TS is the source of truth; this
module must stay byte-for-byte compatible with it). B19b's `PassItem` carries
`payload.keyframes` (base64 MKF2) or `payload.keyframesRef` (an object-storage
key, CONTRACTS §6) for zoom/reframe items; this decoder is what
`zooms.py` feeds into `DynamicZoomEase` start/end rects.

### Byte layout (little-endian, version 1)

```
offset  size  field
0       4     magic   ASCII "MKF2"
4       4     version uint32 LE, currently 1
8       4     count   uint32 LE, number of keyframe rows
12      20*n  rows    n x { tMs: f32, zoom: f32, cx: f32, cy: f32, ease: f32 }, all LE
```

`ease` is packed as a float (0.0 = "linear", 1.0 = "inOut") so every row is a
flat run of 5 little-endian float32 values.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Literal, get_args

Ease = Literal["linear", "inOut"]

_MAGIC = b"MKF2"
_CURRENT_VERSION = 1
_HEADER_BYTES = 12
_ROW_BYTES = 20
_ROW_STRUCT = struct.Struct("<fffff")  # tMs, zoom, cx, cy, ease

_EASE_TO_FLOAT: dict[Ease, float] = {"linear": 0.0, "inOut": 1.0}
_FLOAT_TO_EASE: tuple[Ease, ...] = get_args(Ease)


class KeyframeDecodeError(ValueError):
    """Raised when a buffer is not a valid MKF2-encoded keyframe curve."""


@dataclass(frozen=True, slots=True)
class Keyframe:
    """One decoded keyframe: a subject/crop centre and zoom factor at an offset."""

    t_ms: float
    zoom: float
    cx: float
    cy: float
    ease: Ease


def encode_keyframes(frames: list[Keyframe]) -> bytes:
    """Encode keyframes as the packed little-endian buffer described above."""
    ordered = sorted(frames, key=lambda f: f.t_ms)
    header = _MAGIC + struct.pack("<II", _CURRENT_VERSION, len(ordered))
    rows = b"".join(
        _ROW_STRUCT.pack(f.t_ms, f.zoom, f.cx, f.cy, _EASE_TO_FLOAT[f.ease]) for f in ordered
    )
    return header + rows


def decode_keyframes(data: bytes) -> list[Keyframe]:
    """Decode a buffer `encode_keyframes` (or the TS `encodeKeyframes`) produced."""
    if len(data) < _HEADER_BYTES:
        raise KeyframeDecodeError(f"keyframe buffer too short: {len(data)} bytes")
    if data[0:4] != _MAGIC:
        raise KeyframeDecodeError("bad magic: not a packed keyframe buffer (expected MKF2)")
    version, count = struct.unpack_from("<II", data, 4)
    if version != _CURRENT_VERSION:
        raise KeyframeDecodeError(f"unsupported keyframe version: {version}")
    expected = _HEADER_BYTES + count * _ROW_BYTES
    if len(data) != expected:
        raise KeyframeDecodeError(
            f"keyframe buffer length {len(data)} does not match count={count} (expected {expected})"
        )

    frames: list[Keyframe] = []
    for index in range(count):
        offset = _HEADER_BYTES + index * _ROW_BYTES
        t_ms, zoom, cx, cy, ease_value = _ROW_STRUCT.unpack_from(data, offset)
        rounded = round(ease_value)
        if rounded < 0 or rounded >= len(_FLOAT_TO_EASE):
            raise KeyframeDecodeError(f"unrecognised ease value at row {index}: {ease_value}")
        frames.append(Keyframe(t_ms=t_ms, zoom=zoom, cx=cx, cy=cy, ease=_FLOAT_TO_EASE[rounded]))
    return frames
