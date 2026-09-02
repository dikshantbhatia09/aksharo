# Runbook — egress policy

Add a vendor to the worker egress allow-list, read a Cilium DNS-proxy denial,
and move `networkPolicy.fqdn.mode` through its staged rollout. See
[deploy.md § Egress restrictions and the provider allow-list](deploy.md) for
how this fits into a normal deploy, and THREAT-MODEL T6 (SSRF) for why the
coarse rule always excludes RFC1918/loopback/link-local/the IMDS address
regardless of mode.

---

## 1. The three modes

`networkPolicy.fqdn.mode` in `infra/k8s/montaj/values.yaml` (and per
environment in `values-staging.yaml` / `values-prod.yaml`) has three values.
Move through them in this order, never straight to `enforce`:

| Mode      | What's rendered                                                                                   | What happens to a call outside the allow-list                       |
| --------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `off`     | No `CiliumNetworkPolicy`. The coarse rule in `templates/networkpolicy.yaml` is the only control: 443 to anywhere off the private ranges. | Allowed (the coarse rule does not know hostnames).                    |
| `audit`   | `CiliumNetworkPolicy` rendered with `policy.cilium.io/audit-mode: "true"`. The coarse rule stays up underneath it. | Logged (Hubble, `cilium monitor`), not dropped — the coarse rule still lets it through. |
| `enforce` | `CiliumNetworkPolicy` rendered without the audit annotation. The coarse rule is no longer rendered for that component. | Dropped at the DNS proxy / Cilium agent.                               |

`off` and `enforce` are decision D73's two named states; `audit` is the
staged-rollout step X08 adds between them, specifically so that turning on
enforcement is never the first time anyone finds out what a worker actually
calls.

`audit` and `enforce` require Cilium as the CNI (`infra/README.md` step 2's
add-on list, plus the CNI itself). On the stock AWS VPC CNI, setting either
still renders the `CiliumNetworkPolicy` object, but nothing applies it — there
is no controller watching `cilium.io/v2` CRDs — so it is inert rather than
broken. Do not set anything but `off` on a cluster you have not confirmed runs
Cilium.

## 2. Roll a mode change out

```bash
ENV=staging                      # never start on prod
NS=montaj

helm upgrade --install montaj infra/k8s/montaj \
  --namespace "$NS" \
  -f "infra/k8s/montaj/values-$ENV.yaml" \
  --set networkPolicy.fqdn.mode=audit \
  --reuse-values --atomic --timeout 15m
```

Watch for at least the queue-processing window that environment's slowest
vendor call takes (Sarvam's batch ASR, `09 §1`, can run several minutes) before
reading the audit log in step 3. Nothing this command does can interrupt
traffic: `audit` never drops.

Move to `enforce` only after step 3 shows zero unexpected denials for that
component over a full day of real traffic (staging) or a full business day
(prod). Same command, `--set networkPolicy.fqdn.mode=enforce`.

## 3. Read a DNS-proxy denial

In `audit` mode, a call outside the allow-list is logged, not blocked. In
`enforce` mode, it is dropped — the caller sees a connection timeout or reset,
not an HTTP error, because the packet never reaches a socket that could return
one.

```bash
# Hubble: every Cilium install in this chart's supported add-on set ships it.
hubble observe --namespace "$NS" --verdict DENIED --protocol tcp -f

# Or straight from the agent on the node running the pod in question:
kubectl -n kube-system exec ds/cilium -- cilium monitor --type drop
```

A denial names the pod, the destination IP and, for a `toFQDNs` policy, the
DNS query that resolved it — read the query name, not just the IP, since the
same IP can serve several hostnames behind a CDN. Cross-reference that
hostname against `infra/policies/egress-inventory.json` (§4 below) before
concluding it needs adding: a denial for a hostname already in the allow-list
under a *different* component is a routing bug, not a missing entry.

## 4. Add a vendor

1. Add the hostname to `networkPolicy.providerAllowlist` (exact host) or
   `networkPolicy.providerAllowlistSuffixes` (a domain and everything under
   it — used for multi-tenant endpoints like R2 or Sentry's per-project
   ingest hosts) in `infra/k8s/montaj/values.yaml`, with a `reason` a reviewer
   can check against `docs/CONTRACTS.md` section 1 or a redesign decision.
2. Set `network.allowProviderEgress: true` on the component in `values.yaml`
   if it does not already egress to providers (most workers do not — see the
   table in `infra/k8s/montaj/README.md`).
3. Add the hostname's owner and purpose to `VENDOR_METADATA` in
   `infra/scripts/egress-hosts.mjs`, then regenerate the inventory:
   ```bash
   node infra/scripts/generate-egress-inventory.mjs
   ```
   Skipping this step is not optional: `generate-egress-inventory.mjs --check`
   runs in CI (`.github/workflows/infra.yml`) and fails the build the moment a
   provider adapter dials a hostname with no metadata entry — that is the
   point of the check, not an obstacle to route around.
4. `helm lint infra/k8s/montaj` and `helm template ... | kubeconform` locally
   if Helm is installed; otherwise `node infra/scripts/validate-chart-local.mjs`
   catches the same class of structural mistake (an allow-list entry missing
   its `reason`, a component missing its `network` block) without Helm. See
   `infra/scripts/validate-chart-local.mjs`'s own docstring for exactly what it
   does and does not check — it is not a substitute for the real
   `helm lint`/`helm template`/`kubeconform` pipeline CI runs on every push,
   only a faster local approximation of it.
5. If the workload is already in `enforce` mode, deploy through `audit` again
   first (§2) rather than adding the host and going straight back to
   `enforce` — the new destination has never been observed under this policy.

## 5. Rollback

An enforcement change is a values change, so it rolls back exactly like any
other release (`rollback.md`):

```bash
helm -n montaj rollback montaj --wait --timeout 10m
```

For a faster, targeted revert that does not touch anything else the release
carried, set the mode back directly:

```bash
helm upgrade montaj infra/k8s/montaj \
  --namespace montaj -f infra/k8s/montaj/values-$ENV.yaml \
  --set networkPolicy.fqdn.mode=audit \
  --reuse-values --atomic --timeout 15m
```

`audit` is always a safe rollback target from `enforce`: it cannot introduce a
new outage, only stop preventing one, and it keeps the DNS-proxy log running
so the investigation has data to work from.

## 6. The egress inventory

`infra/policies/egress-inventory.json` is the generated record of every
external hostname `api`, `worker-ai`, `worker-media`, `render` and
`model-server` reach, each with an owner and a purpose:

```bash
node infra/scripts/generate-egress-inventory.mjs          # regenerate
node infra/scripts/generate-egress-inventory.mjs --check  # CI: fail on drift or on an unrecognised host
```

Two kinds of entry:

- **`"source": "code"`** — a literal `..._BASE_URL`/`..._ENDPOINT` constant the
  generator's scan found, with the file and line it found it at
  (`discoveredIn`).
- **`"source": "declared"`** — reached only through an env-configured SDK
  (`R2_ENDPOINT`, `SENTRY_DSN`, the AWS SDK's SES/SNS regional endpoint built
  from `AWS_REGION`), so no literal hostname exists in code for a scan to find.
  These are documented directly in `VENDOR_METADATA`
  (`infra/scripts/egress-hosts.mjs`) instead.

A hostname the scan finds with no `VENDOR_METADATA` entry fails the generator
outright (exit 1, nothing written) — see §4 step 3. That failure is the
control this runbook exists to make usable rather than mysterious: the fix is
always to add the owner and purpose, never to bypass the check.
