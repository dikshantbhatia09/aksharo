"""Loader and resolver for ``routing.yaml`` — the v2 routing table of `09 §1`.

The worker reads the table; it never writes it. Weights become admin-editable
through :func:`apply_overrides`, which takes the same shape the admin console
will serve, so everything here stays pure: load once, overlay overrides once,
resolve per job.

Resolution has three steps, and keeping them apart is what lets an operator read
``GET /providers`` and understand a decision:

* :meth:`RoutingTable.lane_for` picks the lane from the detected language. That is
  a property of the *table*.
* :func:`resolve_chain` walks that lane's candidates in order and returns every
  one this deployment can actually run, primary first. That is a property of the
  *environment*, and it is why a lane can name Sarvam while a developer machine
  transcribes on the mock.
* :func:`resolve` is the head of that chain — the primary. ``ai.transcribe`` walks
  the rest of it when a vendor fails (`09 §1`: fallback on provider error or an
  unsupported language).

**Some components are not routable at all.** :data:`NEVER_ROUTE` lists them with
their reason, and naming one — in the file, in an admin override, or in the
aligner registry — fails the worker's boot rather than waiting for a code review
someone has to remember. Two entries today, both licence or contract exclusions:
Bhashini, whose public API is proof-of-concept-only by its own documentation
(D63, RR-02 F3), and Meta MMS, whose forced-alignment export is CC-BY-NC-4.0 and
therefore non-commercial (D77).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal

import yaml

from worker_ai.languages import base_tag
from worker_ai.providers.registry import ProviderRegistry

__all__ = [
    "DEFAULT_ROUTING_FILE",
    "NEVER_ROUTE",
    "AlignmentPolicy",
    "RoutingCandidate",
    "RoutingDecision",
    "RoutingError",
    "RoutingLane",
    "RoutingTable",
    "load_overrides",
    "load_routing_table",
    "resolve",
    "resolve_chain",
]

#: Shipped alongside this module so the package is self-contained in a container.
DEFAULT_ROUTING_FILE = Path(__file__).with_name("routing.yaml")

#: Components that must never be routed to, and why. Naming one in a lane, in an
#: admin override, or in the aligner registry is an error rather than a review
#: someone has to remember. Both entries are **licence or contract** exclusions,
#: which is why they are enforced in code and not behind a feature flag: a flag
#: can be switched on by an operator who does not know what it means.
NEVER_ROUTE: dict[str, str] = {
    "bhashini": (
        "the Bhashini public API is proof-of-concept only by its own terms; it "
        "stays a shadow-routing challenger until a paid agreement exists (D63)"
    ),
    "mms": (
        "the Meta MMS forced-alignment export is CC-BY-NC-4.0, which is "
        "non-commercial; it is excluded from the product and rung 3 of the "
        "`09 §2` chain is XLSR-53 (Apache-2.0) instead (D77)"
    ),
}

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
    #: Chunks in flight against this vendor; ``0`` means "use the adapter's own
    #: ``max_parallel_requests``". A vendor rate limit is a routing fact, not an
    #: adapter fact, because it is bought per account (RR-02 F1).
    max_parallel_chunks: int = 0
    #: An operator can switch one candidate off without deleting the row, which
    #: is what the admin console's per-provider toggle writes.
    enabled: bool = True

    @property
    def batch(self) -> bool:
        """True when the lane says to send the whole file as one vendor job."""
        return self.api == "batch"

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {
            "provider": self.provider,
            "model": self.model,
            "alignment": self.alignment,
            "weight": self.weight,
            "costPerMinuteInr": self.cost_per_minute_inr,
            "enabled": self.enabled,
        }
        if self.mode is not None:
            wire["mode"] = self.mode
        if self.api is not None:
            wire["api"] = self.api
        if self.max_parallel_chunks:
            wire["maxParallelChunks"] = self.max_parallel_chunks
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
    #: True once :meth:`apply_overrides` has laid admin weights over the file.
    overrides_applied: bool = False

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
            "overrides": self.overrides_applied,
            "lanes": [lane.to_wire() for lane in self.lanes],
        }

    def apply_overrides(self, overrides: dict[str, Any]) -> RoutingTable:
        """A copy of this table with the admin console's edits laid over it.

        The shape is deliberately narrow — weights, the enable switch and the
        cost — because those are the three things `09 §1` says an operator may
        change without an eval run. A lane's providers, its ``mode`` and its
        alignment policy are product decisions (D12) and stay in the file.

        ```json
        { "lanes": { "hinglish": { "candidates": {
              "sarvam": { "weight": 0, "enabled": false },
              "elevenlabs": { "weight": 100 } } } } }
        ```

        Reordering follows the weights: within a lane, candidates are sorted by
        descending weight and ties keep the file's order, so raising a
        challenger's weight above the incumbent's promotes it.
        """
        lanes_raw = overrides.get("lanes")
        if not isinstance(lanes_raw, dict) or not lanes_raw:
            return self

        for lane_override in lanes_raw.values():
            if not isinstance(lane_override, dict):
                continue
            candidates_raw = lane_override.get("candidates")
            if not isinstance(candidates_raw, dict):
                continue
            for provider in candidates_raw:
                forbidden = NEVER_ROUTE.get(str(provider))
                if forbidden is not None:
                    raise RoutingError(
                        "a routing override names " + repr(provider) + " — " + forbidden
                    )

        lanes: list[RoutingLane] = []
        touched = False
        for lane in self.lanes:
            lane_override = lanes_raw.get(lane.id)
            if not isinstance(lane_override, dict):
                lanes.append(lane)
                continue
            candidates_raw = lane_override.get("candidates")
            if not isinstance(candidates_raw, dict):
                lanes.append(lane)
                continue
            candidates = tuple(
                _override_candidate(candidate, candidates_raw.get(candidate.provider))
                for candidate in lane.candidates
            )
            ordered = tuple(
                sorted(
                    enumerate(candidates),
                    key=lambda pair: (-pair[1].weight, pair[0]),
                )
            )
            lanes.append(replace(lane, candidates=tuple(item for _index, item in ordered)))
            touched = True

        if not touched:
            return self
        return replace(self, lanes=tuple(lanes), overrides_applied=True)


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    """What the worker chose, and what it skipped to get there."""

    lane: RoutingLane
    candidate: RoutingCandidate
    #: ``(provider, reason)`` for every candidate passed over, oldest first.
    skipped: tuple[tuple[str, str], ...] = ()
    #: 0 for the primary, 1 for the first fallback, and so on.
    rank: int = 0

    @property
    def needs_alignment(self) -> bool:
        return self.candidate.alignment == "required"

    @property
    def is_fallback(self) -> bool:
        return self.rank > 0

    def to_wire(self) -> dict[str, Any]:
        return {
            "lane": self.lane.id,
            "provider": self.candidate.provider,
            "model": self.candidate.model,
            "alignment": self.candidate.alignment,
            "rank": self.rank,
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
    provider = str(entry["provider"])
    forbidden = NEVER_ROUTE.get(provider)
    if forbidden is not None:
        raise RoutingError(
            str(source) + ": lane " + repr(lane_id) + " names " + repr(provider) + " — " + forbidden
        )
    return RoutingCandidate(
        provider=provider,
        model=str(entry.get("model") or ""),
        alignment=policy,
        mode=str(entry["mode"]) if entry.get("mode") else None,
        api=str(entry["api"]) if entry.get("api") else None,
        weight=int(entry.get("weight", 0)),
        cost_per_minute_inr=float(entry.get("costPerMinuteInr", 0.0)),
        max_parallel_chunks=int(entry.get("maxParallelChunks", 0) or 0),
        enabled=bool(entry.get("enabled", True)),
    )


def _override_candidate(candidate: RoutingCandidate, override: object) -> RoutingCandidate:
    """Lay one admin override over one candidate; unknown keys are ignored."""
    if not isinstance(override, dict):
        return candidate
    changes: dict[str, Any] = {}
    if isinstance(override.get("weight"), int) and not isinstance(override["weight"], bool):
        changes["weight"] = int(override["weight"])
    if isinstance(override.get("enabled"), bool):
        changes["enabled"] = bool(override["enabled"])
    cost = override.get("costPerMinuteInr")
    if isinstance(cost, int | float) and not isinstance(cost, bool):
        changes["cost_per_minute_inr"] = float(cost)
    parallel = override.get("maxParallelChunks")
    if isinstance(parallel, int) and not isinstance(parallel, bool) and parallel > 0:
        changes["max_parallel_chunks"] = int(parallel)
    return replace(candidate, **changes) if changes else candidate


def load_overrides(raw: str | None) -> dict[str, Any]:
    """Parse ``ROUTING_OVERRIDES_JSON``; an empty or broken value means "none".

    A malformed override must not stop a worker booting — the file is the
    product decision and the overrides are a tuning knob, so the worker logs the
    problem and runs the table as written.
    """
    if not raw or not raw.strip():
        return {}
    try:
        parsed: Any = json.loads(raw)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def resolve_chain(
    table: RoutingTable,
    registry: ProviderRegistry,
    *,
    language: str | None,
    code_mix: bool = False,
    capability: str = "transcribe",
) -> tuple[RoutingDecision, ...]:
    """Every candidate this deployment can run for the matching lane, best first.

    The head is the primary; the tail is the fallback chain ``ai.transcribe``
    walks when a vendor errors (`09 §1`). Candidates are skipped, with a reason
    each, when the provider is disabled here, when the operator switched the row
    off, when the adapter cannot do the job, or when the adapter's declared
    languages do not include the detected one — that last case is the "fallback
    on an unsupported language" rule, and it is why Urdu never reaches Scribe.

    :raises RoutingError: when nothing in the lane, and nothing in the default
        lane, can run here. The message lists every rejection, because that is
        the whole diagnosis.
    """
    lane = table.lane_for(language, code_mix=code_mix)
    skipped: list[tuple[str, str]] = []
    chain: list[RoutingDecision] = []
    seen: set[str] = set()

    lanes: list[tuple[RoutingLane, bool]] = [(lane, False)]
    if lane.id != table.default_lane_id:
        lanes.append((table.lane(table.default_lane_id), True))

    for candidate_lane, borrowed in lanes:
        for candidate in candidate_lane.candidates:
            if candidate.provider in seen:
                continue
            reason = _rejection(registry, candidate, language, code_mix, capability, borrowed)
            if reason is not None:
                skipped.append((candidate.provider, reason))
                seen.add(candidate.provider)
                continue
            seen.add(candidate.provider)
            chain.append(
                RoutingDecision(
                    lane=lane,
                    candidate=candidate,
                    skipped=tuple(skipped),
                    rank=len(chain),
                )
            )

    if chain:
        return tuple(chain)

    # Last resort: the mock, when this deployment has explicitly allowed it. The
    # lane is still reported, so a transcript never silently claims a vendor.
    if registry.enabled("mock"):
        return (
            RoutingDecision(
                lane=lane,
                candidate=RoutingCandidate(provider="mock", model="fixture-v1"),
                skipped=tuple(skipped),
            ),
        )

    detail = "; ".join(f"{provider}: {reason}" for provider, reason in skipped) or "none tried"
    raise RoutingError(f"no provider can serve lane {lane.id!r} ({detail})")


def resolve(
    table: RoutingTable,
    registry: ProviderRegistry,
    *,
    language: str | None,
    code_mix: bool = False,
    capability: str = "transcribe",
) -> RoutingDecision:
    """The primary: the head of :func:`resolve_chain`."""
    return resolve_chain(
        table,
        registry,
        language=language,
        code_mix=code_mix,
        capability=capability,
    )[0]


def _rejection(
    registry: ProviderRegistry,
    candidate: RoutingCandidate,
    language: str | None,
    code_mix: bool,
    capability: str,
    borrowed: bool,
) -> str | None:
    """Why ``candidate`` cannot serve this job, or ``None`` when it can.

    ``borrowed`` marks a candidate reached by falling through to the default
    lane. **Inside its own lane the table is the authority**: D12 put ElevenLabs
    behind Sarvam on the Hinglish lane deliberately, and an adapter's declared
    language list is documentation, not a veto. A borrowed candidate made no such
    claim, so there the declared list *is* checked — otherwise a Hindi job whose
    whole lane is down would land on an English-only adapter and come back as
    confident nonsense.
    """
    if not candidate.enabled:
        return "the routing table has this candidate switched off"
    reason = registry.reason_disabled(candidate.provider)
    if reason is not None:
        return reason
    if capability == "transcribe" and not registry.supports(candidate.provider, "transcribe"):
        return "the adapter does not transcribe"
    if borrowed:
        wanted = "hi-en" if code_mix else base_tag(language)
        if wanted and not registry.covers(candidate.provider, wanted):
            return "the adapter does not cover " + wanted
    return None
