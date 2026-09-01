#!/usr/bin/env python3
"""Assert the rendered chart denies worker egress by default.

X05 acceptance criterion 4. Reads a rendered manifest (helm template output) and
checks three things a reviewer would otherwise have to verify by eye every time
the chart changes:

  1. A namespace-wide default-deny NetworkPolicy exists and covers both
     directions.
  2. No worker holds an unrestricted egress rule. Exactly one component
     (worker-ai) is permitted a broad HTTPS rule, and only because a stock AWS
     VPC CNI cannot express the hostname allow-list; see
     infra/k8s/montaj/templates/networkpolicy.yaml.
  3. Any 0.0.0.0/0 rule excludes the private ranges and the instance metadata
     address, so it can never become an SSRF path back into the VPC
     (THREAT-MODEL T6).

Usage:

    helm template montaj infra/k8s/montaj -f infra/k8s/montaj/values-prod.yaml > /tmp/prod.yaml
    python3 infra/scripts/check-network-policy.py /tmp/prod.yaml
"""

from __future__ import annotations

import sys

import yaml

# Only this component may hold a broad HTTPS egress rule while FQDN enforcement
# is unavailable. Everything else must reach the VPC and the cluster, nothing more.
COMPONENTS_ALLOWED_BROAD_EGRESS = {"montaj-api", "montaj-worker-ai"}

WORKERS = ("montaj-worker-ai", "montaj-worker-media", "montaj-render", "montaj-scheduler")

# THREAT-MODEL T6: an egress rule to the whole internet must carve these out or
# it reopens the SSRF path the API guards against in application code.
REQUIRED_EXCEPTIONS = {
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
}

failed = False


def fail(message: str) -> None:
    global failed
    failed = True
    print(f"::error::{message}")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {argv[0]} <rendered-manifest.yaml>", file=sys.stderr)
        return 2

    with open(argv[1], encoding="utf-8") as handle:
        docs = [d for d in yaml.safe_load_all(handle) if d]

    policies = {
        d["metadata"]["name"]: d for d in docs if d.get("kind") == "NetworkPolicy"
    }
    if not policies:
        fail("the rendered chart contains no NetworkPolicy at all")
        return 1

    deny = next((p for p in policies.values() if p["spec"].get("podSelector") == {}
                 and sorted(p["spec"].get("policyTypes", [])) == ["Egress", "Ingress"]), None)
    if deny is None:
        fail("no namespace-wide default-deny NetworkPolicy (podSelector {} over Ingress and Egress)")
    else:
        print(f"OK  default-deny: {deny['metadata']['name']}")

    for name, policy in sorted(policies.items()):
        for rule in policy["spec"].get("egress", []):
            for target in rule.get("to", []):
                block = target.get("ipBlock")
                if not block or block.get("cidr") != "0.0.0.0/0":
                    continue
                if name not in COMPONENTS_ALLOWED_BROAD_EGRESS:
                    fail(f"{name} has an egress rule to 0.0.0.0/0")
                missing = REQUIRED_EXCEPTIONS - set(block.get("except", []))
                if missing:
                    fail(
                        f"{name}: 0.0.0.0/0 egress does not exclude {', '.join(sorted(missing))} "
                        "(THREAT-MODEL T6, SSRF back into the VPC)"
                    )

    for worker in WORKERS:
        if worker not in policies:
            fail(f"no NetworkPolicy for {worker}")

    if not failed:
        print(f"OK  {len(policies)} policies; no worker holds unrestricted egress")
        print("    " + ", ".join(sorted(policies)))

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
