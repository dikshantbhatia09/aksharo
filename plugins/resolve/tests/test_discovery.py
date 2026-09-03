from __future__ import annotations

from pathlib import Path

from aksharo_core_app.discovery import (
    DiscoveryFile,
    generate_bearer_token,
    read_discovery_file,
    write_discovery_file,
)


def test_generate_bearer_token_is_high_entropy_and_unique() -> None:
    a = generate_bearer_token()
    b = generate_bearer_token()
    assert a != b
    assert len(a) >= 32


def test_write_then_read_discovery_file_round_trips(tmp_path: Path) -> None:
    target = tmp_path / "resolve.json"
    file = DiscoveryFile(
        port=47841, bearer="tok123", pid=1234, version="0.1.0", started_at="2026-09-03T00:00:00Z"
    )
    write_discovery_file(file, target)

    assert target.exists()  # mode is asserted POSIX-side only; Windows ACLs differ
    loaded = read_discovery_file(target)
    assert loaded == file


def test_read_discovery_file_returns_none_when_missing(tmp_path: Path) -> None:
    assert read_discovery_file(tmp_path / "missing.json") is None


def test_read_discovery_file_returns_none_on_bad_json(tmp_path: Path) -> None:
    target = tmp_path / "resolve.json"
    target.write_text("not json", encoding="utf-8")
    assert read_discovery_file(target) is None


def test_read_discovery_file_returns_none_on_missing_fields(tmp_path: Path) -> None:
    target = tmp_path / "resolve.json"
    target.write_text('{"port": 1}', encoding="utf-8")
    assert read_discovery_file(target) is None


def test_write_discovery_file_creates_parent_dir(tmp_path: Path) -> None:
    nested = tmp_path / "nested" / "resolve.json"
    file = DiscoveryFile(port=47842, bearer="t", pid=1, version="0.1.0", started_at="now")
    write_discovery_file(file, nested)
    assert nested.exists()
