"""Loader and resolver for ``routing.yaml`` — the v2 routing table of `09 §1`.

The worker reads the table; it never writes it. Admin editing of the weights is a
later work package, so everything here is pure: load once, resolve per job.

Resolution has two steps, and keeping them apart is what lets an operator read
``GET /providers`` and understand a decision:

* :meth:`RoutingTable.lane_for` picks the lane from the detected language. That is
  a property of the *table*.
* :func:`resolve` walks that lane's candidates in order and returns the first one
  whose provider is enabled in this deployment. That is a property of the
  *environment*, and it is why a lane can name Sarvam while a developer machine
  transcribes on the mock.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml

from worker_ai.providers.registry import ProviderRegistry

__all__ = [
    "DEFAULT_ROUTING_FILE",
    "AlignmentPolicy",
    "RoutingCandidate",
    "RoutingDecision",
    "RoutingError",
    "RoutingLane",
    "RoutingTable",
    "load_routing_table",
    "resolve",
]

#: Shipped alongside this module so the package is self-contained in a container.
DEFAULT_ROUTING_FILE = Path(__file__).with_name("routing.yaml")

AlignmentPolicy = Literal["required", "optional", "none"]


class RoutingError(RuntimeError):
    """The routing file is malformed, or no candidate can serve a job."""


@dataclass(frozen=True, slots=True)
class RoutingCandidate:
    """One provider option inside a lane, in preference order."""

    provider: str
    model: str
    alignment: AlignmentPolicy = "optional"
    mode: str | None = None
    api: str | None = None
    weight: int = 0
    cost_per_minute_inr: float = 0.0

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "provider": self.provider,
            "model": self.model,
            "alignment": self.alignment,
            "weight": self.weight,
            "costPerMinuteInr": self.cost_per_minute_inr,
        }
        if self.mode is not None:
            wire["mode"] = self.mode
        if self.api is not None:
            wire["api"] = self.api
        return wire

    def provider_options(self) -> dict[str, Any]:
        """Vendor knobs to hand to :class:`~worker_ai.providers.base.Provider`."""
        options: dict[str, Any] = {}
        if self.mode is not None:
            options["mode"] = self.mode
        if self.api is not None:
            options["api"] = self.api
        return options


@dataclass(frozen=True, slots=True)
class RoutingLane:
    """One row of the v2 table."""

    id: str
    label: str
    languages: tuple[str, ...]
    candidates: tuple[RoutingCandidate, ...]
    code_mix: bool = False

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "languages": list(self.languages),
            "codeMix": self.code_mix,
            "candidates": [candidate.to_wire() for candidate in self.candidates],
        }


@dataclass(frozen=True, slots=True)
class RoutingTable:
    """The whole table, plus the lane used when nothing matches."""

    version: int
    lanes: tuple[RoutingLane, ...]
    default_lane_id: str
    source: str = ""

    def lane(self, lane_id: str) -> RoutingLane:
        for candidate in self.lanes:
            if candidate.id == lane_id:
                return candidate
        raise RoutingError(f"no lane {lane_id!r} in the routing table")

    def lane_for(self, language: str | None, *, code_mix: bool = False) -> RoutingLane:
        """The lane for a detected language tag.

        Matching is exact first, then on the base subtag, so ``ta-IN`` reaches the
        ``ta`` lane without the table having to enumerate regions. A code-mix
        signal wins outright, because a two-signal LID agreement is the only way
        a job is flagged code-mix in the first place (D14).
        """
        if code_mix:
            for lane in self.lanes:
                if lane.code_mix:
                    return lane
        if language:
            wanted = language.strip()
            folded = wanted.casefold()
            base = folded.split("-")[0]
            for lane in self.lanes:
                if any(tag.casefold() == folded for tag in lane.languages):
                    return lane
            for lane in self.lanes:
                if any(tag.casefold() == base for tag in lane.languages):
                    return lane
        return self.lane(self.default_lane_id)

    def to_wire(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "default": self.default_lane_id,
            "source": self.source,
            "lanes": [lane.to_wire() for lane in self.lanes],
        }


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    """What the worker chose, and what it skipped to get there."""

    lane: RoutingLane
    candidate: RoutingCandidate
    #: ``(provider, reason)`` for every candidate passed over, oldest first.
    skipped: tuple[tuple[str, str], ...] = ()

    @property
    def needs_alignment(self) -> bool:
        return self.candidate.alignment == "required"

    def to_wire(self) -> dict[str, Any]:
        return {
            "lane": self.lane.id,
            "provider": self.candidate.provider,
            "model": self.candidate.model,
            "alignment": self.candidate.alignment,
            "skipped": [
                {"provider": provider, "reason": reason} for provider, reason in self.skipped
            ],
        }


def load_routing_table(path: str | Path | None = None) -> RoutingTable:
    """Parse ``routing.yaml``.

    :param path: overrides the packaged file (``WORKER_AI_ROUTING_FILE``).
    :raises RoutingError: when the file is missing or does not match the schema.
    """
    source = Path(path) if path else DEFAULT_ROUTING_FILE
    try:
        raw = yaml.safe_load(source.read_text(encoding="utf-8"))
    except OSError as error:
        raise RoutingError(f"could not read {source}: {error}") from error
    except yaml.YAMLError as error:
        raise RoutingError(f"{source} is not valid YAML: {error}") from error

    if not isinstance(raw, dict):
        raise RoutingError(f"{source} must hold a mapping")

    lanes_raw = raw.get("lanes")
    if not isinstance(lanes_raw, list) or not lanes_raw:
        raise RoutingError(f"{source} must define at least one lane")

    lanes = tuple(_lane(entry, source) for entry in lanes_raw)
    ids = [lane.id for lane in lanes]
    if len(set(ids)) != len(ids):
        raise RoutingError(f"{source} has duplicate lane ids")

    default_lane_id = str(raw.get("default") or lanes[-1].id)
    if default_lane_id not in ids:
        raise RoutingError(f"{source} names a default lane {default_lane_id!r} that does not exist")

    return RoutingTable(
        version=int(raw.get("version", 2)),
        lanes=lanes,
        default_lane_id=default_lane_id,
        source=str(source),
    )


def _lane(entry: object, source: Path) -> RoutingLane:
    if not isinstance(entry, dict) or not entry.get("id"):
        raise RoutingError(f"{source}: every lane needs an id")
    candidates_raw = entry.get("candidates")
    if not isinstance(candidates_raw, list) or not candidates_raw:
        raise RoutingError(f"{source}: lane {entry['id']!r} has no candidates")
    languages_raw = entry.get("languages") or []
    if not isinstance(languages_raw, list):
        raise RoutingError(f"{source}: lane {entry['id']!r} has a malformed language list")
    return RoutingLane(
        id=str(entry["id"]),
        label=str(entry.get("label") or entry["id"]),
        languages=tuple(str(tag) for tag in languages_raw),
        code_mix=bool(entry.get("codeMix", False)),
        candidates=tuple(_candidate(item, source, str(entry["id"])) for item in candidates_raw),
    )


def _candidate(entry: object, source: Path, lane_id: str) -> RoutingCandidate:
    if not isinstance(entry, dict) or not entry.get("provider"):
        raise RoutingError(f"{source}: lane {lane_id!r} has a candidate without a provider")
    alignment = str(entry.get("alignment", "optional"))
    if alignment not in {"required", "optional", "none"}:
        raise RoutingError(
            f"{source}: lane {lane_id!r} has an unknown alignment policy {alignment!r}"
        )
    policy: AlignmentPolicy = (
        "required" if alignment == "required" else ("none" if alignment == "none" else "optional")
    )
    return RoutingCandidate(
        provider=str(entry["provider"]),
        model=str(entry.get("model") or ""),
        alignment=policy,
        mode=str(entry["mode"]) if entry.get("mode") else None,
        api=str(entry["api"]) if entry.get("api") else None,
        weight=int(entry.get("weight", 0)),
        cost_per_minute_inr=float(entry.get("costPerMinuteInr", 0.0)),
    )


def resolve(
    table: RoutingTable,
    registry: ProviderRegistry,
    *,
    language: str | None,
    code_mix: bool = False,
    capability: str = "transcribe",
) -> RoutingDecision:
    """Pick the first candidate of the matching lane whose provider is enabled.

    :raises RoutingError: when nothing in the lane, and nothing in the default
        lane, can run here. The message lists every rejection, because that is
        the whole diagnosis.
    """
    lane = table.lane_for(language, code_mix=code_mix)
    skipped: list[tuple[str, str]] = []

    lanes: list[RoutingLane] = [lane]
    if lane.id != table.default_lane_id:
        lanes.append(table.lane(table.default_lane_id))

    for candidate_lane in lanes:
        for candidate in candidate_lane.candidates:
            reason = registry.reason_disabled(candidate.provider)
            if reason is not None:
                skipped.append((candidate.provider, reason))
                continue
            if capability == "transcribe" and not registry.supports(
                candidate.provider, "transcribe"
            ):
                skipped.append((candidate.provider, "the adapter does not transcribe"))
                continue
            return RoutingDecision(lane=lane, candidate=candidate, skipped=tuple(skipped))

    # Last resort: the mock, when this deployment has explicitly allowed it. The
    # lane is still reported, so a transcript never silently claims a vendor.
    if registry.enabled("mock"):
        return RoutingDecision(
            lane=lane,
            candidate=RoutingCandidate(provider="mock", model="fixture-v1"),
            skipped=tuple(skipped),
        )

    detail = "; ".join(f"{provider}: {reason}" for provider, reason in skipped) or "none tried"
    raise RoutingError(f"no provider can serve lane {lane.id!r} ({detail})")
