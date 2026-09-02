"""Style -> Resolve Fusion Text+ parameter mapping (C08b, scope 2).

For each of the 30 `@montaj/caption-styles` documents this module computes,
never hand-types:

- a font mapping onto a bundled OFL font (`@montaj/fonts`'s `pack/fonts.json`
  manifest) — exact family+weight when bundled, else the nearest bundled
  weight in that family, noted as a reason;
- a classification (`supported` / `approximate` / `unsupported`) against what
  the `AksharoCaption.setting` macro (`macro.py`) can actually express, driven
  entirely by the explicit predicate table in `classification_rules.json` —
  the same table C06b mirrors for the Premiere MOGRT side, so both hosts'
  coverage reports are derived from one rule set, not two hand-written ones.

Every unsupported/approximate style still reaches picture: C08's
`captions.build_segment_item` falls back to a pre-rendered alpha overlay
whenever `CaptionStyle.ass_renderable` is false, independent of the Fusion
macro path this module scores.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

_FUSION_DIR = Path(__file__).resolve().parent
_PLUGIN_ROOT = _FUSION_DIR.parents[1]  # plugins/resolve
_REPO_ROOT = _PLUGIN_ROOT.parents[1]  # repo root (plugins/resolve/../..)

STYLES_DIR = _REPO_ROOT / "packages" / "caption-styles" / "styles"
FONTS_MANIFEST = _REPO_ROOT / "packages" / "fonts" / "pack" / "fonts.json"
CLASSIFICATION_RULES_PATH = _FUSION_DIR / "classification_rules.json"
COVERAGE_REPORT_PATH = _PLUGIN_ROOT / "docs" / "RESOLVE-STYLE-COVERAGE.md"

Status = Literal["supported", "approximate", "unsupported"]
_STATUS_RANK: dict[Status, int] = {"supported": 0, "approximate": 1, "unsupported": 2}


@dataclass(frozen=True, slots=True)
class FontMapping:
    requested_family: str
    requested_weight: int
    bundled_family: str | None
    bundled_weight: int | None
    bundled_file: str | None
    exact: bool
    note: str | None


@dataclass(frozen=True, slots=True)
class StyleMapping:
    style_id: str
    name: str
    category: str
    status: Status
    reasons: tuple[str, ...]
    font: FontMapping
    ass_renderable: bool
    parity_score: float | None
    fallback: str = "alpha overlay"


def _get_path(doc: dict[str, object], dotted: str) -> object:
    node: object = doc
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def load_style_docs(styles_dir: Path = STYLES_DIR) -> list[dict[str, object]]:
    """All 30 style JSON documents, sorted by id for a deterministic order.
    `registry.json` (the catalogue index, not a style) is skipped explicitly."""
    docs: list[dict[str, object]] = []
    for path in sorted(styles_dir.glob("*.json")):
        if path.stem == "registry":
            continue
        docs.append(cast("dict[str, object]", json.loads(path.read_text(encoding="utf-8"))))
    docs.sort(key=lambda d: cast("str", d["id"]))
    return docs


def load_font_catalog(manifest_path: Path = FONTS_MANIFEST) -> dict[str, dict[int, str]]:
    """`{family: {weight: file}}` built from `@montaj/fonts`'s bundled manifest."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    catalog: dict[str, dict[int, str]] = {}
    for entry in manifest["fonts"]:
        catalog.setdefault(entry["family"], {})[int(entry["weight"])] = entry["file"]
    return catalog


def map_font(family: str, weight: int, catalog: dict[str, dict[int, str]]) -> FontMapping:
    weights = catalog.get(family)
    if not weights:
        return FontMapping(
            requested_family=family,
            requested_weight=weight,
            bundled_family=None,
            bundled_weight=None,
            bundled_file=None,
            exact=False,
            note=f"font family {family!r} is not in the bundled OFL catalogue.",
        )
    if weight in weights:
        return FontMapping(
            requested_family=family,
            requested_weight=weight,
            bundled_family=family,
            bundled_weight=weight,
            bundled_file=weights[weight],
            exact=True,
            note=None,
        )
    nearest = min(weights, key=lambda w: (abs(w - weight), w))
    return FontMapping(
        requested_family=family,
        requested_weight=weight,
        bundled_family=family,
        bundled_weight=nearest,
        bundled_file=weights[nearest],
        exact=False,
        note=f"weight snapped from {weight} to the nearest bundled weight {nearest}.",
    )


@dataclass(frozen=True, slots=True)
class _Rule:
    rule_id: str
    field: str
    status: Status
    reason: str
    equals: object | None
    less_than: float | None
    when_field: str | None
    when_equals: object | None

    def fires(self, doc: dict[str, object]) -> bool:
        if self.when_field is not None and _get_path(doc, self.when_field) != self.when_equals:
            return False
        value = _get_path(doc, self.field)
        if self.equals is not None:
            return bool(value == self.equals)
        if self.less_than is not None:
            return isinstance(value, int | float) and value < self.less_than
        return False


def load_rules(rules_path: Path = CLASSIFICATION_RULES_PATH) -> list[_Rule]:
    data = json.loads(rules_path.read_text(encoding="utf-8"))
    rules: list[_Rule] = []
    for raw in data["rules"]:
        when = raw.get("when")
        rules.append(
            _Rule(
                rule_id=raw["id"],
                field=raw["field"],
                status=raw["status"],
                reason=raw["reason"],
                equals=raw.get("equals"),
                less_than=raw.get("lt"),
                when_field=when["field"] if when else None,
                when_equals=when["equals"] if when else None,
            )
        )
    return rules


def classify_style(
    doc: dict[str, object],
    catalog: dict[str, dict[int, str]] | None = None,
    rules: list[_Rule] | None = None,
) -> StyleMapping:
    catalog = catalog if catalog is not None else load_font_catalog()
    rules = rules if rules is not None else load_rules()

    typography = cast("dict[str, object]", doc["typography"])
    font = map_font(
        cast("str", typography["fontFamily"]), cast("int", typography["weight"]), catalog
    )

    reasons: list[str] = []
    status: Status = "supported"
    if not font.exact and font.note is not None:
        reasons.append(font.note)
        status = "approximate" if font.bundled_family is not None else "unsupported"

    for rule in rules:
        if rule.fires(doc):
            reasons.append(rule.reason)
            if _STATUS_RANK[rule.status] > _STATUS_RANK[status]:
                status = rule.status

    return StyleMapping(
        style_id=cast("str", doc["id"]),
        name=cast("str", doc["name"]),
        category=cast("str", doc["category"]),
        status=status,
        reasons=tuple(reasons),
        font=font,
        ass_renderable=cast("bool", doc["assRenderable"]),
        parity_score=cast("float | None", doc.get("parityScore")),
    )


def classify_all_styles(
    styles_dir: Path = STYLES_DIR,
    manifest_path: Path = FONTS_MANIFEST,
    rules_path: Path = CLASSIFICATION_RULES_PATH,
) -> list[StyleMapping]:
    catalog = load_font_catalog(manifest_path)
    rules = load_rules(rules_path)
    return [classify_style(doc, catalog, rules) for doc in load_style_docs(styles_dir)]


_STATUS_LABEL: dict[Status, str] = {
    "supported": "Supported",
    "approximate": "Approximate",
    "unsupported": "Unsupported",
}


def generate_coverage_report(mappings: list[StyleMapping]) -> str:
    """The markdown table C11/C10's plugins page and this repo's docs cite.
    Deterministic: same input list -> byte-identical output (styles are
    already sorted by id by `load_style_docs`)."""
    counts: dict[Status, int] = {"supported": 0, "approximate": 0, "unsupported": 0}
    for mapping in mappings:
        counts[mapping.status] += 1

    lines: list[str] = []
    lines.append("# Resolve Fusion Text+ style coverage")
    lines.append("")
    lines.append(
        "Generated by `plugins/resolve/aksharo_core_app/fusion/style_map.py` "
        "(`scripts/generate_style_coverage.py`) from `packages/caption-styles/styles/*.json` "
        "and `packages/fonts/pack/fonts.json` — never hand-edited. Re-run the script after "
        "either changes."
    )
    lines.append("")
    lines.append(
        f"**{counts['supported']} supported, {counts['approximate']} approximate, "
        f"{counts['unsupported']} unsupported** of {len(mappings)} styles."
    )
    lines.append("")
    lines.append(
        "Every style reaches picture regardless of this table: C08's caption builder "
        "(`aksharo_core_app/captions.py`) uses a pre-rendered alpha overlay fallback "
        "whenever a style isn't Text+-exact, so *unsupported*/*approximate* here means "
        '"not a native, re-timeable Fusion Text+ clip in the Resolve timeline", never '
        '"missing from the export."'
    )
    lines.append("")
    lines.append(
        "`assRenderable`/`parityScore` (A18a) are a *different* gate — Skia vs. libass "
        "parity for the `.ass` sidecar/web-player path — shown here only for cross-reference; "
        "the Supported/Approximate/Unsupported column is this module's own Text+ capability "
        "classification, driven by `classification_rules.json`."
    )
    lines.append("")
    lines.append(
        "| Style | Category | Status | Reason | Font (Resolve) | assRenderable | parityScore |"
    )
    lines.append("|---|---|---|---|---|---|---|")
    for mapping in mappings:
        reason = " ".join(mapping.reasons) if mapping.reasons else "—"
        font_cell = (
            f"{mapping.font.bundled_family} {mapping.font.bundled_weight}"
            if mapping.font.bundled_family is not None
            else "*(none bundled)*"
        )
        parity = "—" if mapping.parity_score is None else f"{mapping.parity_score:.4f}"
        lines.append(
            f"| {mapping.name} (`{mapping.style_id}`) | {mapping.category} | "
            f"{_STATUS_LABEL[mapping.status]} | {reason} | {font_cell} | "
            f"{mapping.ass_renderable} | {parity} |"
        )
    lines.append("")
    lines.append("## Known limitations (not scored per-style above)")
    lines.append("")
    lines.append(
        "- **Non-Latin script fallback fonts are not selectable per character.** Every style "
        "carries `typography.fallbacks` (e.g. Noto Sans Devanagari/Tamil) for scripts the "
        "primary font lacks; the macro's single `Font` input cannot switch fonts mid-string, "
        "so a Hinglish/Indic caption authored through the macro renders in the primary font "
        "only (missing glyphs show as `.notdef` boxes) — the alpha-overlay fallback remains the "
        "correct path for multi-script captions until a future macro revision adds per-run font "
        "inputs."
    )
    lines.append(
        "- **Fusion-side verification is pending.** No DaVinci Resolve install exists on this "
        "build host (A00-04 spike). This module's classification is derived from the StyleDoc "
        "fields and Text+'s documented capabilities, not from loading the macro in Resolve. "
        "Real-Fusion verification is tracked in `docs/GATE-C-CHECKLIST.md`."
    )
    lines.append("")
    return "\n".join(lines)


def write_coverage_report(path: Path = COVERAGE_REPORT_PATH) -> str:
    report = generate_coverage_report(classify_all_styles())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(report, encoding="utf-8", newline="\n")
    return report
