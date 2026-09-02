"""`AksharoCaption.setting` — the Fusion Text+ macro C08's caption builder uses
when it is installed (`fusion_macro_available()`), falling back to the minimal
Text+ param path (`captions.py`, pre-C08b) otherwise.

There is no Resolve/Fusion on this machine (brief C08b), so this module does
not target Fusion's real `.setting` serialisation byte-for-byte. It defines a
small, explicit grammar — a Lua-table-like subset deliberately close to how
Fusion writes `Tool { Inputs = { Name = Input { Value = ... } } }` — emits it
deterministically from `MacroDefaults`/`HighlightKeyframes`, and parses that
same subset back with `parse_macro`, so the pair round-trips. Real-Fusion
verification (does DaVinci Resolve actually load this file, do character-range
inputs paint correctly) is tracked in `docs/GATE-C-CHECKLIST.md`, not here.

Published inputs (brief C08b, scope 1): `Text`, `Font`, `Size`, `Colour`,
`StrokeColour`, `StrokeWidth`, `ShadowOpacity`, `PositionY`, `HighlightColour`,
`HighlightStart`, `HighlightEnd` (per-word timing, keyframed 0..1 ramps), plus
a `StyleId` comment field carrying the originating `@montaj/caption-styles` id.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

MACRO_TOOL_NAME = "AksharoCaption"
MACRO_FILENAME = f"{MACRO_TOOL_NAME}.setting"

_FUSION_DIR = Path(__file__).resolve().parent

# Published input names, in the fixed order the generator writes them.
PUBLISHED_INPUTS = (
    "Text",
    "Font",
    "Size",
    "Colour",
    "StrokeColour",
    "StrokeWidth",
    "ShadowOpacity",
    "PositionY",
    "HighlightColour",
    "HighlightStart",
    "HighlightEnd",
)

RGBA = tuple[float, float, float, float]


class MacroFormatError(Exception):
    """The text is not valid in the subset this module emits/parses."""


@dataclass(frozen=True, slots=True)
class KeyframeTrack:
    """A sparse `frame -> value` ramp (0..1), e.g. a per-word highlight wipe.

    Frames must be strictly increasing; this is a Fusion `KeyFrames` table,
    not an interpolation curve — the macro's `HighlightStart`/`HighlightEnd`
    inputs step between 0 and 1 at each published word boundary.
    """

    points: tuple[tuple[int, float], ...] = ()

    def __post_init__(self) -> None:
        frames = [frame for frame, _ in self.points]
        if frames != sorted(frames) or len(set(frames)) != len(frames):
            raise ValueError("KeyFrames must have strictly increasing, unique frame numbers")


@dataclass(frozen=True, slots=True)
class MacroDefaults:
    """The default value baked into each published input when the macro is
    dropped onto a clip; the caption builder overwrites `Text`/`PositionY`/
    per-word highlight timing per segment, but the style-derived cosmetic
    defaults (font, size, colours, stroke, shadow) come from here so the tool
    looks right even before the builder touches it."""

    style_id: str
    text: str = ""
    font: str = "Inter"
    size: float = 0.05
    colour: RGBA = (1.0, 1.0, 1.0, 1.0)
    stroke_colour: RGBA = (0.0, 0.0, 0.0, 1.0)
    stroke_width: float = 0.0
    shadow_opacity: float = 0.0
    position_y: float = 0.5
    highlight_colour: RGBA = (1.0, 1.0, 0.0, 1.0)
    highlight_start: KeyframeTrack = field(default_factory=KeyframeTrack)
    highlight_end: KeyframeTrack = field(default_factory=KeyframeTrack)


def _fmt_num(value: float) -> str:
    """Deterministic, round-trippable number formatting: integral floats print
    with one decimal (`1.0`), everything else to 6 significant decimal
    places with trailing zeros trimmed (never fewer than one)."""
    rounded = round(float(value), 6)
    if rounded == int(rounded):
        return f"{int(rounded)}.0"
    text = f"{rounded:.6f}".rstrip("0")
    return text if text[-1] != "." else f"{text}0"


def _fmt_str(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _fmt_color(rgba: RGBA) -> str:
    return "{ " + ", ".join(_fmt_num(c) for c in rgba) + " }"


def _keyframe_block_lines(track: KeyframeTrack, indent: str) -> list[str]:
    """Lines for one `HighlightStart`/`HighlightEnd` input's `{ KeyFrames = { ... } }`
    body, at the given (already-inside-the-input-brace) indent."""
    lines = [f"{indent}KeyFrames = {{"]
    for frame, value in track.points:
        lines.append(f"{indent}    [{frame}] = {_fmt_num(value)},")
    lines.append(f"{indent}}},")
    return lines


def generate_macro(defaults: MacroDefaults) -> str:
    """Emit the deterministic `.setting` text for one style's macro defaults."""
    ind1 = " " * 4
    ind2 = " " * 8
    ind3 = " " * 12
    ind4 = " " * 16

    scalar_inputs: dict[str, str] = {
        "Text": _fmt_str(defaults.text),
        "Font": _fmt_str(defaults.font),
        "Size": _fmt_num(defaults.size),
        "Colour": _fmt_color(defaults.colour),
        "StrokeColour": _fmt_color(defaults.stroke_colour),
        "StrokeWidth": _fmt_num(defaults.stroke_width),
        "ShadowOpacity": _fmt_num(defaults.shadow_opacity),
        "PositionY": _fmt_num(defaults.position_y),
        "HighlightColour": _fmt_color(defaults.highlight_colour),
    }

    lines: list[str] = []
    lines.append("Composition {")
    lines.append(f"{ind1}Tools = {{")
    lines.append(f"{ind2}{MACRO_TOOL_NAME} = TextPlusMacro {{")
    lines.append(f"{ind3}StyleId = {_fmt_str(defaults.style_id)},")
    lines.append(f"{ind3}Inputs = {{")
    for name in PUBLISHED_INPUTS:
        if name in scalar_inputs:
            lines.append(f"{ind4}{name} = {{ Value = {scalar_inputs[name]} }},")
        elif name == "HighlightStart":
            lines.append(f"{ind4}HighlightStart = {{")
            lines.extend(_keyframe_block_lines(defaults.highlight_start, ind4 + "    "))
            lines.append(f"{ind4}}},")
        elif name == "HighlightEnd":
            lines.append(f"{ind4}HighlightEnd = {{")
            lines.extend(_keyframe_block_lines(defaults.highlight_end, ind4 + "    "))
            lines.append(f"{ind4}}},")
    lines.append(f"{ind3}}},")
    lines.append(f"{ind2}}},")
    lines.append(f"{ind1}}},")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Parser for the exact subset `generate_macro` emits.
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<number>-?\d+(?:\.\d+)?)
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<lbrace>\{)
  | (?P<rbrace>\})
  | (?P<lbracket>\[)
  | (?P<rbracket>\])
  | (?P<equals>=)
  | (?P<comma>,)
    """,
    re.VERBOSE,
)


@dataclass(frozen=True, slots=True)
class _Token:
    kind: str
    text: str


def _tokenize(text: str) -> list[_Token]:
    tokens: list[_Token] = []
    pos = 0
    while pos < len(text):
        match = _TOKEN_RE.match(text, pos)
        if match is None:
            raise MacroFormatError(f"unexpected character at offset {pos}: {text[pos]!r}")
        pos = match.end()
        kind = match.lastgroup
        if kind == "ws" or kind is None:
            continue
        tokens.append(_Token(kind, match.group()))
    return tokens


@dataclass(frozen=True, slots=True)
class MacroNode:
    """One parsed `Name { ... }` or bare `{ ... }` table.

    `entries` preserves source order; a key is `str` for a named field
    (`Font = ...`), `int` for a bracketed keyframe key (`[12] = ...`), or
    `None` for a positional element of an array-like table (a colour tuple).
    """

    type_name: str | None
    entries: tuple[tuple[str | int | None, object], ...]

    def get(self, key: str) -> object:
        for entry_key, value in self.entries:
            if entry_key == key:
                return value
        raise KeyError(key)


class _Parser:
    def __init__(self, tokens: list[_Token]) -> None:
        self._tokens = tokens
        self._pos = 0

    def _peek(self) -> _Token | None:
        return self._tokens[self._pos] if self._pos < len(self._tokens) else None

    def _advance(self) -> _Token:
        token = self._peek()
        if token is None:
            raise MacroFormatError("unexpected end of input")
        self._pos += 1
        return token

    def _expect(self, kind: str) -> _Token:
        token = self._advance()
        if token.kind != kind:
            raise MacroFormatError(f"expected {kind}, got {token.kind} ({token.text!r})")
        return token

    def parse_document(self) -> MacroNode:
        node = self._parse_value()
        if self._peek() is not None:
            raise MacroFormatError("trailing tokens after top-level table")
        if not isinstance(node, MacroNode):
            raise MacroFormatError("top-level value must be a table")
        return node

    def _parse_value(self) -> object:
        token = self._peek()
        if token is None:
            raise MacroFormatError("unexpected end of input while parsing a value")
        if token.kind == "string":
            self._advance()
            return token.text[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        if token.kind == "number":
            self._advance()
            return float(token.text)
        if token.kind == "ident":
            # Either `Name { ... }` (named table) or a bare identifier value
            # (not used by this grammar, but rejected explicitly for clarity).
            name = self._advance().text
            if self._peek() is not None and self._peek().kind == "lbrace":  # type: ignore[union-attr]
                return self._parse_table(type_name=name)
            raise MacroFormatError(f"identifier {name!r} not followed by a table")
        if token.kind == "lbrace":
            return self._parse_table(type_name=None)
        raise MacroFormatError(f"unexpected token {token.kind} ({token.text!r})")

    def _parse_table(self, type_name: str | None) -> MacroNode:
        self._expect("lbrace")
        entries: list[tuple[str | int | None, object]] = []
        while True:
            token = self._peek()
            if token is None:
                raise MacroFormatError("unterminated table")
            if token.kind == "rbrace":
                self._advance()
                break
            key, value = self._parse_member()
            entries.append((key, value))
            token = self._peek()
            if token is not None and token.kind == "comma":
                self._advance()
        return MacroNode(type_name=type_name, entries=tuple(entries))

    def _parse_member(self) -> tuple[str | int | None, object]:
        token = self._peek()
        if token is None:
            raise MacroFormatError("unexpected end of input while parsing a member")
        if token.kind == "lbracket":
            self._advance()
            index_token = self._expect("number")
            self._expect("rbracket")
            self._expect("equals")
            value = self._parse_value()
            return int(float(index_token.text)), value
        if token.kind == "ident":
            # Lookahead: `Ident =` is a named field; `Ident {` (handled in
            # `_parse_value`) never reaches here as a member key.
            save = self._pos
            name = self._advance().text
            nxt = self._peek()
            if nxt is not None and nxt.kind == "equals":
                self._advance()
                value = self._parse_value()
                return name, value
            self._pos = save
        # Positional element (e.g. a bare number inside a colour tuple).
        return None, self._parse_value()


def parse_macro(text: str) -> MacroNode:
    """Parse `.setting` text emitted by `generate_macro` back into a `MacroNode`
    tree. Raises `MacroFormatError` for anything outside that subset."""
    return _Parser(_tokenize(text)).parse_document()


def _find_tool_node(document: MacroNode) -> MacroNode:
    tools = document.get("Tools")
    if not isinstance(tools, MacroNode):
        raise MacroFormatError("Composition.Tools is not a table")
    tool = tools.get(MACRO_TOOL_NAME)
    if not isinstance(tool, MacroNode):
        raise MacroFormatError(f"Tools.{MACRO_TOOL_NAME} is not a table")
    return tool


def _color_from_node(node: object) -> RGBA:
    if not isinstance(node, MacroNode) or node.type_name is not None:
        raise MacroFormatError("expected a positional colour table")
    values = [value for key, value in node.entries if key is None]
    if len(values) != 4 or not all(isinstance(v, int | float) for v in values):
        raise MacroFormatError("colour table must have exactly 4 numeric components")
    numbers = cast("list[float]", values)
    return (numbers[0], numbers[1], numbers[2], numbers[3])


def _keyframes_from_node(node: object) -> KeyframeTrack:
    if not isinstance(node, MacroNode):
        raise MacroFormatError("expected a HighlightStart/HighlightEnd table")
    keyframes_node = node.get("KeyFrames")
    if not isinstance(keyframes_node, MacroNode):
        raise MacroFormatError("expected a KeyFrames table")
    points = tuple(
        (key, cast("float", value))
        for key, value in keyframes_node.entries
        if isinstance(key, int) and isinstance(value, int | float)
    )
    return KeyframeTrack(points=points)


def defaults_from_macro(text: str) -> MacroDefaults:
    """The other half of the round trip: parse `.setting` text back into
    `MacroDefaults`, used by the golden/round-trip tests."""
    document = parse_macro(text)
    tool = _find_tool_node(document)
    style_id = tool.get("StyleId")
    if not isinstance(style_id, str):
        raise MacroFormatError("StyleId must be a string")
    inputs = tool.get("Inputs")
    if not isinstance(inputs, MacroNode):
        raise MacroFormatError("Inputs is not a table")

    def scalar(name: str) -> object:
        node = inputs.get(name)
        if not isinstance(node, MacroNode):
            raise MacroFormatError(f"Inputs.{name} is not a table")
        return node.get("Value")

    text_value = scalar("Text")
    font_value = scalar("Font")
    if not isinstance(text_value, str) or not isinstance(font_value, str):
        raise MacroFormatError("Text/Font must be strings")

    return MacroDefaults(
        style_id=style_id,
        text=text_value,
        font=font_value,
        size=float(scalar("Size")),  # type: ignore[arg-type]
        colour=_color_from_node(scalar("Colour")),
        stroke_colour=_color_from_node(scalar("StrokeColour")),
        stroke_width=float(scalar("StrokeWidth")),  # type: ignore[arg-type]
        shadow_opacity=float(scalar("ShadowOpacity")),  # type: ignore[arg-type]
        position_y=float(scalar("PositionY")),  # type: ignore[arg-type]
        highlight_colour=_color_from_node(scalar("HighlightColour")),
        highlight_start=_keyframes_from_node(inputs.get("HighlightStart")),
        highlight_end=_keyframes_from_node(inputs.get("HighlightEnd")),
    )


DEFAULT_MACRO_DEFAULTS = MacroDefaults(style_id="default")
"""The canonical macro dropped into `AksharoCaption.setting`: neutral cosmetic
defaults (white text, no stroke/shadow, centred). C08's caption builder
overwrites every published input per segment via `SetInput`/the params dict
(`captions.py`); this is only what a user sees before the builder — or a
human editor — touches the tool."""


def generate_default_macro() -> str:
    return generate_macro(DEFAULT_MACRO_DEFAULTS)


def macro_path() -> Path:
    """Where the caption builder looks for the installed macro, mirroring the
    Fusion `Macros` folder layout C10's installer copies this file into
    (`plugins/resolve/installer/manifest.json`)."""
    return _FUSION_DIR / MACRO_FILENAME


def fusion_macro_available(path: Path | None = None) -> bool:
    """True once `AksharoCaption.setting` is present next to this module (dev/CI:
    generated by `scripts/generate_macro.py`; installed builds: copied by C10's
    Resolve installer per `plugins/resolve/installer/manifest.json`)."""
    return (path if path is not None else macro_path()).is_file()
