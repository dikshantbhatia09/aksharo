from __future__ import annotations

from pathlib import Path

from aksharo_core_app.fusion.style_map import (
    STYLES_DIR,
    FontMapping,
    classify_all_styles,
    classify_style,
    generate_coverage_report,
    load_font_catalog,
    load_rules,
    load_style_docs,
    map_font,
)

_STATUSES = {"supported", "approximate", "unsupported"}


def test_loads_exactly_thirty_styles_and_skips_the_registry_index() -> None:
    docs = load_style_docs()
    assert len(docs) == 30
    assert all("id" in doc for doc in docs)
    assert len({doc["id"] for doc in docs}) == 30  # every id distinct
    assert any(path.stem == "registry" for path in STYLES_DIR.glob("*.json")), (
        "registry.json should exist and be excluded by load_style_docs, not merely absent"
    )


def test_every_style_gets_exactly_one_status_and_all_are_accounted_for() -> None:
    mappings = classify_all_styles()
    assert len(mappings) == 30
    ids = {m.style_id for m in mappings}
    assert len(ids) == 30
    for mapping in mappings:
        assert mapping.status in _STATUSES
        assert mapping.fallback == "alpha overlay"
        # No style is simultaneously supported and unsupported: `status` is a
        # single scalar field, so this is structural, but assert the classifier
        # didn't silently produce an empty/invalid value.
        assert mapping.status


def test_classification_matches_known_counts() -> None:
    """Pins the current classification so a rule-table or font-catalogue change
    is a deliberate, reviewed edit, not a silent drift."""
    mappings = classify_all_styles()
    counts = {"supported": 0, "approximate": 0, "unsupported": 0}
    for mapping in mappings:
        counts[mapping.status] += 1
    assert counts == {"supported": 19, "approximate": 6, "unsupported": 5}


def test_unsupported_styles_all_carry_a_reason() -> None:
    for mapping in classify_all_styles():
        if mapping.status != "supported":
            assert mapping.reasons, f"{mapping.style_id} is {mapping.status} with no reason"


def test_map_font_exact_match() -> None:
    catalog = load_font_catalog()
    mapping = map_font("Inter", 700, catalog)
    assert mapping == FontMapping(
        requested_family="Inter",
        requested_weight=700,
        bundled_family="Inter",
        bundled_weight=700,
        bundled_file="inter-700.ttf",
        exact=True,
        note=None,
    )


def test_map_font_snaps_to_nearest_bundled_weight() -> None:
    catalog = load_font_catalog()
    mapping = map_font("Inter", 650, catalog)
    assert mapping.exact is False
    assert mapping.bundled_weight in (600, 700)
    assert mapping.note is not None and "nearest bundled weight" in mapping.note


def test_map_font_unknown_family_is_unsupported() -> None:
    catalog = load_font_catalog()
    mapping = map_font("Definitely Not A Bundled Font", 400, catalog)
    assert mapping.bundled_family is None
    assert mapping.exact is False


def test_coverage_report_generation_is_deterministic() -> None:
    mappings = classify_all_styles()
    first = generate_coverage_report(mappings)
    second = generate_coverage_report(classify_all_styles())
    assert first == second


def test_coverage_report_lists_every_style_with_a_reason_column() -> None:
    mappings = classify_all_styles()
    report = generate_coverage_report(mappings)
    for mapping in mappings:
        assert f"`{mapping.style_id}`" in report
    assert "19 supported, 6 approximate, 5 unsupported" in report


def test_coverage_report_file_is_up_to_date(tmp_path: Path) -> None:
    """`docs/RESOLVE-STYLE-COVERAGE.md` is a generated, committed artefact
    (`scripts/generate_style_coverage.py`) — it must not drift from the
    generator."""
    committed = (Path(__file__).parents[1] / "docs" / "RESOLVE-STYLE-COVERAGE.md").read_text(
        encoding="utf-8"
    )
    assert committed == generate_coverage_report(classify_all_styles())


def test_classification_rules_json_is_the_single_source_c06b_mirrors() -> None:
    rules = load_rules()
    assert len(rules) > 0
    ids = [rule.rule_id for rule in rules]
    assert len(ids) == len(set(ids)), "duplicate rule ids"


def test_classify_style_accepts_precomputed_catalog_and_rules_for_reuse() -> None:
    catalog = load_font_catalog()
    rules = load_rules()
    doc = load_style_docs()[0]
    a = classify_style(doc, catalog, rules)
    b = classify_style(doc)
    assert a == b
