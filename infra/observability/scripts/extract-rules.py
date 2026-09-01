#!/usr/bin/env python3
"""Extract the plain Prometheus rule file from a PrometheusRule custom resource.

`promtool check rules` validates a bare `groups:` document; a PrometheusRule
wraps that document under `spec`. This unwraps it so CI can run promtool over
what Prometheus will actually evaluate.

    python infra/observability/scripts/extract-rules.py \
        infra/observability/alerts/montaj-alerts.yaml > /tmp/rules.yaml
    promtool check rules /tmp/rules.yaml
"""

from __future__ import annotations

import sys

import yaml


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <prometheusrule.yaml>", file=sys.stderr)
        return 2

    with open(argv[1], encoding="utf-8") as handle:
        docs = [d for d in yaml.safe_load_all(handle) if d]

    groups: list[dict] = []
    for doc in docs:
        if doc.get("kind") != "PrometheusRule":
            continue
        groups.extend(doc.get("spec", {}).get("groups", []))

    if not groups:
        print(f"{argv[1]}: no PrometheusRule groups found", file=sys.stderr)
        return 1

    yaml.safe_dump({"groups": groups}, sys.stdout, sort_keys=False, width=1000)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
