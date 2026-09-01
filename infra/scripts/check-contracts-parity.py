#!/usr/bin/env python3
"""Check that the infrastructure matches docs/CONTRACTS.md.

Two contracts are checked, both of which are silent failures in production if
they drift:

  section 1 (environment variables)
      Every variable must have exactly one SSM parameter declared in
      infra/terraform/modules/secrets/contract.tf and exactly one entry in the
      chart's externalSecrets.variables list. A variable missing from either
      produces a pod that boots without it; an extra one produces a parameter
      nobody reads, which is the shape a stale credential hides in.

  section 3 (queue names)
      Every queue must be consumed by something. A queue with no KEDA trigger
      and no documented owner is a queue that fills up silently.

Run from the repository root:

    python3 infra/scripts/check-contracts-parity.py

Exits non-zero and prints GitHub Actions error annotations on any mismatch.
This is the evidence for X05 acceptance criterion 2.
"""

from __future__ import annotations

import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]

CONTRACTS = ROOT / "docs" / "CONTRACTS.md"
SECRETS_TF = ROOT / "infra" / "terraform" / "modules" / "secrets" / "contract.tf"
CHART_VALUES = ROOT / "infra" / "k8s" / "montaj" / "values.yaml"

# `notify` is drained by the scheduler, a singleton that must not autoscale:
# retention sweeps and the dunning ladder cannot run twice.
QUEUES_WITHOUT_KEDA = {"notify": "consumed by the scheduler singleton (no autoscaling by design)"}

_failed = False


def fail(message: str, path: pathlib.Path | None = None) -> None:
    global _failed
    _failed = True
    location = f" file={path.relative_to(ROOT).as_posix()}::" if path else "::"
    print(f"::error{location}{message}")


def section(name: str, heading: str) -> str:
    """Return the body of a `## <heading>` section of CONTRACTS.md."""
    text = CONTRACTS.read_text(encoding="utf-8")
    pattern = re.compile(rf"^## {re.escape(heading)}.*?$(.*?)(?=^## |\Z)", re.MULTILINE | re.DOTALL)
    match = pattern.search(text)
    if not match:
        fail(f"could not find CONTRACTS section for {name!r}", CONTRACTS)
        return ""
    return match.group(1)


def contract_env_vars() -> set[str]:
    body = section("environment variables", "1. Environment variables")
    return set(re.findall(r"`([A-Z][A-Z0-9_]+)`", body))


def contract_queues() -> set[str]:
    body = section("queue contracts", "3. Queue contracts")
    line = next((ln for ln in body.splitlines() if ln.startswith("Queue names:")), "")
    if not line:
        fail("could not find the 'Queue names:' line in CONTRACTS section 3", CONTRACTS)
        return set()
    # `notify` has no dot, so the pattern cannot require one.
    return set(re.findall(r"`([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)?)`", line))


def terraform_ssm_vars() -> set[str]:
    """Keys of the `contract_parameters` map in the secrets module."""
    text = SECRETS_TF.read_text(encoding="utf-8")
    start = text.find("contract_parameters = {")
    if start == -1:
        fail("no contract_parameters map found", SECRETS_TF)
        return set()
    return set(re.findall(r"^    ([A-Z][A-Z0-9_]+) = \{", text[start:], re.MULTILINE))


def chart_values() -> dict:
    return yaml.safe_load(CHART_VALUES.read_text(encoding="utf-8"))


def chart_secret_vars(values: dict) -> set[str]:
    return set(values.get("externalSecrets", {}).get("variables", []))


def chart_keda_queues(values: dict) -> set[str]:
    queues: set[str] = set()
    for spec in values.get("components", {}).values():
        keda = spec.get("keda") or {}
        for trigger in keda.get("queues", []) or []:
            queues.add(trigger["name"])
    return queues


def compare(label: str, expected: set[str], actual: set[str], path: pathlib.Path) -> None:
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing:
        fail(f"{label}: missing {', '.join(missing)}", path)
    if extra:
        fail(f"{label}: not in CONTRACTS: {', '.join(extra)}", path)
    if not missing and not extra:
        print(f"OK  {label}: {len(expected)} entries, exact match")


def main() -> int:
    env_vars = contract_env_vars()
    if not env_vars:
        return 1
    print(f"CONTRACTS section 1: {len(env_vars)} environment variables")

    compare("terraform SSM parameters", env_vars, terraform_ssm_vars(), SECRETS_TF)

    values = chart_values()
    compare("chart externalSecrets.variables", env_vars, chart_secret_vars(values), CHART_VALUES)

    queues = contract_queues()
    if queues:
        print(f"CONTRACTS section 3: {len(queues)} queues")
        scaled = chart_keda_queues(values)
        unowned = sorted(q for q in queues - scaled if q not in QUEUES_WITHOUT_KEDA)
        if unowned:
            fail(f"queues with no KEDA trigger and no documented owner: {', '.join(unowned)}", CHART_VALUES)
        stray = sorted(scaled - queues)
        if stray:
            fail(f"KEDA triggers on queues that are not in CONTRACTS section 3: {', '.join(stray)}", CHART_VALUES)
        if not unowned and not stray:
            for queue, reason in QUEUES_WITHOUT_KEDA.items():
                if queue in queues:
                    print(f"OK  queue {queue}: {reason}")
            print(f"OK  chart KEDA triggers: {len(scaled)} of {len(queues)} queues autoscaled")

    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
