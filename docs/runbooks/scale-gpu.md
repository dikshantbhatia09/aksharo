# Runbook — scale GPU

Transcripts are queueing, or GPU spend is out of line.

Decision **D15**: launch capacity is per-second serverless GPU with a warm floor
of one instance per region. Reserved capacity is a later decision driven by duty
cycle, not by list price. Cost model: `infra/gpu/COST.md`.

---

## 1. Which problem do you actually have?

Open **Montaj / Cost and GPU** and **Montaj / Service health**, and read them in
this order:

| Symptom                                                                       | Meaning                                                                          | Go to |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----- |
| `montaj_queue_depth{queue="ai.transcribe"}` high **and** GPU utilisation high | Genuinely out of capacity                                                        | §2    |
| Queue depth high **and** GPU utilisation low                                  | Not a GPU problem — the CPU worker is the bottleneck, or the provider is failing | §3    |
| Cold starts per minute climbing                                               | Warm floor too low for this traffic shape                                        | §4    |
| COGS per credit above 58 paise                                                | Spend problem, not a capacity problem                                            | §5    |
| Provider errors climbing, queue stalled                                       | Provider outage                                                                  | §6    |

Getting this wrong is expensive in both directions: scaling GPU to fix a CPU
bottleneck doubles the bill and fixes nothing.

## 2. Out of capacity

Raise the ceiling, in this order, checking after each step.

**a. The Kubernetes CPU workers first.** They call the GPU; if they are pinned,
the GPU is idle regardless of its ceiling.

```bash
NS=montaj
kubectl -n "$NS" get scaledobject montaj-worker-ai -o yaml | grep -E 'minReplicaCount|maxReplicaCount'
kubectl -n "$NS" top pods -l app.kubernetes.io/component=worker-ai
```

If the workers are at their ceiling, raise it. Edit `values-$ENV.yaml` and
deploy, or for an emergency:

```bash
kubectl -n "$NS" patch scaledobject montaj-worker-ai --type merge \
  -p '{"spec":{"maxReplicaCount":60}}'
```

An in-cluster patch is reverted by the next Helm release. Follow it with a
values change, or it will be undone by someone else's deploy.

**b. The GPU endpoint ceiling.** `workersMax` in `infra/gpu/runpod/endpoint.json`
is 20. Raise it in the RunPod console for an emergency, then in the file.

**Before raising it, check that the credit admission control is working**
(THREAT-MODEL T23). Without a per-workspace enqueued-credit cap, raising
`workersMax` converts a queue into a bill:

```bash
kubectl -n "$NS" exec deploy/montaj-api -- node dist/scripts/queue-top-workspaces.js --limit 10
```

If one workspace is most of the queue, throttle that workspace instead of scaling
for it.

**c. The last resort: shed load to the vendor path.** ASR routing weights are
adjustable in the admin console. Moving traffic from the self-hosted GPU path
(₹0.09–0.13/min) to ElevenLabs Scribe (₹0.35/min) costs about three times as
much per minute but needs no capacity from us at all. For a queue that is hours
deep, that trade is usually right — and it is exactly what `05 §12` calls the
first overflow.

## 3. Queue high, GPU idle

The GPU is not the bottleneck. Check, in order:

```bash
# Are the CPU workers even running? KEDA may have scaled to zero and stuck.
kubectl -n "$NS" get deploy montaj-worker-ai
kubectl -n "$NS" describe scaledobject montaj-worker-ai | tail -30

# Can KEDA read the queue at all? An empty KEDA_REDIS_ADDRESS is the classic
# cause: every trigger silently reads nothing and nothing ever scales up.
kubectl -n "$NS" get cm montaj-config -o jsonpath='{.data.KEDA_REDIS_ADDRESS}{"\n"}'

# Is the worker crash-looping on a provider credential?
kubectl -n "$NS" logs deploy/montaj-worker-ai --tail=100
```

A KEDA scaler that cannot reach Redis reports zero depth, which looks exactly
like an empty queue. `montaj_queue_depth` comes from the scheduler, not from
KEDA, which is why the two disagreeing is such a useful signal.

## 4. Cold starts too frequent

`MontajGpuColdStartsFrequent` fires above two per minute.

Two knobs in `infra/gpu/runpod/endpoint.json`:

- **`idleTimeout`** (30 s). How long a worker stays warm after its last request.
  Raising it to 60–120 s bridges the gap between chunks of the same file. Cheap:
  idle time is billed at a reduced rate.
- **`workersMin`** (1). The D15 warm floor. Raising it to 2 removes cold starts
  for concurrent users, and costs roughly another USD 290 a month per region
  (`COST.md §3`).

Prefer raising `idleTimeout` first. It targets the actual pattern — chunks of one
file arriving in a burst — and a warm floor is a subscription you keep paying
when nobody is uploading.

`COST.md §3` puts the break-even for a warm floor at roughly 2,500 media-minutes
a month. Below that, cold starts plus a visible ETA is the honest configuration
and staging runs exactly that way.

## 5. Spend out of line

`MontajCogsPerCreditAboveMarginFloor` (58 paise) or `MontajCogsExceedsRevenue`
(232 paise).

Read the **COGS by component** panel. The usual causes, in order of frequency:

1. **A routing change** sent traffic to an expensive ASR path. Check the routing
   weights in the admin console against the cost table in `05 §12`.
2. **A warm floor running in an idle region.** `montaj_gpu_workers_idle` above 1
   in a region with no traffic is pure waste. Regions are `locations` in
   `endpoint.json`; launch should be AP only.
3. **Retry storms.** `montaj_job_attempts` p50 above 1 means work is being paid
   for twice. Fix the failure, do not scale around it.
4. **Egress on the raw bucket.** `MontajRawBucketEgress` firing means something
   is reading raw media directly from S3 instead of the derived copy on R2
   (decision D35). This is a code bug with a monthly invoice attached.

`05 §11` calls for an admin throttle above 2× revenue. If `MontajCogsExceedsRevenue`
is firing, use it: every credit spent is currently losing money.

## 6. Provider outage

```bash
# Which provider, and how?
kubectl -n "$NS" logs deploy/montaj-worker-ai --tail=200 | grep -iE 'timeout|429|5[0-9][0-9]'
```

Response:

1. Shift routing weight away from the failing provider in the admin console.
   Every ASR path is interchangeable at the transcript level; that is why there
   are four of them.
2. If it is the **GPU provider** that is down, route to the vendor ASR path
   entirely (`GPU_PROVIDER` is a CONTRACTS section 1 variable, so this is an SSM
   change plus a worker restart — see [rotate-secrets.md](rotate-secrets.md) for
   the sync-and-restart mechanics).
3. Failed jobs land in the DLQ. Do **not** replay them until the provider is
   healthy: see [dlq-replay.md](dlq-replay.md).
4. Check that credit holds from failed jobs were released. A provider outage
   that leaves users' credits reserved is an outage plus a support queue.

## 7. The reserved-GPU decision

`MontajGpuDutyCycleHigh` (over 60 % for a day) is informational, and it means
the D15 crossover is worth re-running with real numbers.

Do not migrate on price alone. Reserved capacity is cheaper **only if the card
stays busy** (`COST.md §5`). The inputs to the decision are:

- Measured duty cycle over a fortnight, not a day.
- Measured GPU seconds per media minute (the dashboard panel that compares
  against the 4.5 s estimate in `COST.md §2`).
- Whether the traffic is diurnal. Indian creator traffic peaks in the evening;
  a card that is idle for sixteen hours is not cheaper than serverless whatever
  the hourly rate says.

The migration path already exists: `enable_gpu_node_group = true` in the
environment's Terraform plus a toleration for the `nvidia.com/gpu` taint. It is a
variable flip, not a rebuild — which is precisely why it should wait for
evidence.
