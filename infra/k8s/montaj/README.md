# chart: montaj

The Aksharo platform on Kubernetes. Seven components from one chart, driven by a
`components` map in `values.yaml` so adding one is a values change rather than a
new template.

| Component      | Kind   | Scales on                                      | Notes                                                                                                    |
| -------------- | ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `api`          | web    | HPA, CPU + memory                              | NestJS modular monolith. The only component with broad HTTPS egress (Razorpay, Google).                  |
| `web`          | web    | HPA, CPU                                       | Next.js studio and marketing site.                                                                       |
| `realtime`     | web    | HPA, CPU                                       | The `api` image in gateway mode. Shares the API hostname under `/ws` (CONTRACTS §7).                     |
| `worker-media` | worker | KEDA, `media.probe` + `media.proxy` depth      | ffmpeg. Needs scratch space.                                                                             |
| `worker-ai`    | worker | KEDA, the nine `ai.*` queues                   | CPU variant: VAD, routing, vendor ASR calls. GPU inference is on the serverless provider (decision D15). |
| `render`       | worker | KEDA, `render.video` + `render.subtitle` depth | Skia + x264. The most CPU-hungry workload here.                                                          |
| `scheduler`    | cron   | not autoscaled                                 | Singleton: retention sweeps, the daily COGS rollup, the dunning ladder. Running two would double-charge. |

## Install

```bash
helm upgrade --install montaj infra/k8s/montaj \
  -n montaj --create-namespace \
  -f infra/k8s/montaj/values-staging.yaml \
  --set image.tag="$TAG" --set image.registry="$REGISTRY" \
  --atomic --timeout 15m
```

Full procedure, including the one-time steps: [`docs/runbooks/deploy.md`](../../../docs/runbooks/deploy.md).

## Prerequisites

The chart uses four CRD groups and will not install without them:
`external-secrets.io`, `keda.sh`, `networking.k8s.io/Ingress` with an ingress
controller, and — only when `networkPolicy.fqdn.mode` is `audit` or `enforce` —
`cilium.io`. `infra/README.md` step 5 lists the add-ons and the order.

## Values you must set per environment

Three have no sensible default, and two of them fail quietly rather than loudly:

| Value                   | Source                                                     | If you leave it empty                                                                                                                          |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.registry`        | the account's ECR registry                                 | Pods fail to pull. Loud.                                                                                                                       |
| `redis.address`         | `terraform output redis_url`, host:port without the scheme | **Every KEDA scaler reads nothing and reports zero depth, which is indistinguishable from an empty queue.** The chart's NOTES warn about this. |
| `networkPolicy.vpcCidr` | `terraform output vpc_cidr_block`                          | Workers cannot reach Postgres or Redis. Loud, but confusing.                                                                                   |

## Autoscaling: why two mechanisms

**HPA on CPU** for `api`, `web` and `realtime`. They serve requests; CPU is a
reasonable proxy for load, and the metric is already there.

**KEDA on queue depth** for the workers and the render service. CPU is a lagging
signal for a queue: by the time the workers are hot, the queue is already long
and the user has been watching a spinner for a minute. BullMQ keeps waiting jobs
in a Redis list at `bull:{queue}:wait`, so the scaler reads the true backlog.

Every worker has `minReplicaCount: 0` in staging, so an idle staging cluster
costs nothing beyond its baseline. Production keeps one warm `worker-media` and
one warm `worker-ai` — probe and proxy sit on the critical path from upload to
editor, and a cold start there is visible to the user — but lets `render` scale
to zero, because the export dialog already shows an ETA.

KEDA reads the Redis address from `KEDA_REDIS_ADDRESS` in the scale target's
environment (set from the chart's ConfigMap), because its scaler wants
`host:port` while `REDIS_URL` (CONTRACTS §1) carries the `rediss://` form.

## Secrets

One `ExternalSecret` projects all 31 `CONTRACTS §1` variables from SSM into a
single Kubernetes Secret, which every component mounts with `envFrom`.

Variables are listed **explicitly** in `externalSecrets.variables`, not pulled
with a wildcard `find`. Two reasons: adding a variable to the contract without
adding it here becomes a visible diff and a CI failure (`infra-validate`), and a
stray parameter under the same path can never leak into a pod's environment.

Nothing in this chart holds a credential. The controller assumes the IRSA role
from `terraform output external_secrets_role_arn`.

## Network policy

Default deny, then named allowances. A compromised worker starts with no route
anywhere — not to the internet, not to the API, not to another worker's pod.

Two honest limits, both stated in the template and worth repeating:

1. **A NetworkPolicy matches IP ranges, never hostnames.** With the stock AWS VPC
   CNI, `networkPolicy.providerAllowlist` documents intent but cannot enforce it;
   `worker-ai` gets TCP 443 to any public address (with RFC1918, loopback,
   link-local and the IMDS address excluded, so it cannot become an SSRF path
   back into the VPC — THREAT-MODEL T6), and the real allow-list lives at the
   egress proxy.
2. **On Cilium it becomes real, in two steps.** `networkPolicy.fqdn.mode: audit`
   renders the same `CiliumNetworkPolicy` with `toFQDNs`, but with a
   `policy.cilium.io/audit-mode: "true"` annotation: a denial is logged (Hubble,
   `cilium monitor`), never dropped, and the broad rule stays up underneath it.
   `mode: enforce` drops the broad rule and lets Cilium reject anything outside
   the allow-list, so a worker may open 443 to `api.elevenlabs.io` and nothing
   else. `enforce` is the intended end state; `audit` is the staged-rollout step
   in between (`docs/runbooks/egress-policy.md`), and CI renders and validates
   all three modes.

`infra/scripts/check-network-policy.py` asserts both properties against the
rendered manifest on every push, for every mode.

## Egress inventory

`infra/policies/egress-inventory.json` lists every external hostname the `api`,
`worker-ai`, `worker-media` and `render` code reaches (plus `model-server`,
which runs outside this chart on the serverless GPU provider), with an owner
and a purpose for each. `node infra/scripts/generate-egress-inventory.mjs`
regenerates it from a source scan; `--check` fails if the committed file is
stale or if a hostname was added to a provider adapter without also adding it
(owner + purpose) to `VENDOR_METADATA` in `infra/scripts/egress-hosts.mjs` —
the mechanism that keeps a new outbound path from shipping undocumented.

## Pod security

Every pod: `runAsNonRoot`, `readOnlyRootFilesystem`, all capabilities dropped,
`seccompProfile: RuntimeDefault`, and no service-account token mounted (no montaj
workload calls the Kubernetes API; IRSA still works because the EKS pod identity
webhook injects its own projected token).

A read-only root filesystem means anything that writes needs a volume, so every
pod gets an `emptyDir` at `/tmp` and the media, AI and render workers get a larger
`scratch` volume with `TMPDIR` pointed at it.

## Ingress

Two hosts: the studio and the API. `realtime` shares the API host under `/ws`, so
a browser needs one origin and one certificate. Paths are emitted specific-first,
because ingress-nginx matches in order and `/` would otherwise swallow `/ws`.

TLS comes from cert-manager through the `ClusterIssuer` named in
`ingress.annotations`. The chart holds no key.
