# Runbook — breach, first hour

Suspected compromise or personal-data exposure.

**Read this before fixing the outage.** An outage costs money; a mishandled
breach costs users their data and the company its licence to hold any.

The threat model this responds to is `docs/THREAT-MODEL.md`. Every mitigation
there is a control that may have failed; this runbook is how you find out which.

---

## Minute 0–5: contain, do not investigate

Three actions, in this order. Do them before you understand what happened.

### 1. Say it out loud

Declare an incident and name one **incident lead**. Everything below is that
person's decision to make. A breach handled by consensus is a breach handled
slowly.

### 2. Preserve evidence — do not restart anything

The instinct to `kubectl delete pod` destroys the only record of what happened.

```bash
NS=montaj

# Snapshot state before it changes.
kubectl -n "$NS" get pods -o yaml > /tmp/incident-pods.yaml
kubectl -n "$NS" logs --all-containers --prefix --since=6h \
  -l app.kubernetes.io/instance=montaj > /tmp/incident-logs.txt
kubectl -n "$NS" get events --sort-by=.lastTimestamp > /tmp/incident-events.txt
```

CloudTrail, the EKS audit log and the VPC flow logs are already being written —
`enabled_cluster_log_types` includes `audit` and `authenticator`, and flow logs
are on with 90-day retention in production. Do not let anything expire:

```bash
aws logs put-retention-policy --log-group-name "/aws/eks/montaj-$ENV/cluster" --retention-in-days 3653
aws logs put-retention-policy --log-group-name "/aws/vpc/montaj-$ENV/flow-logs" --retention-in-days 3653
```

### 3. Contain, narrowly

Match the containment to what you actually suspect:

| Suspicion                        | Containment                                                               |
| -------------------------------- | ------------------------------------------------------------------------- |
| A credential leaked              | Revoke that credential now; [rotate-secrets.md](rotate-secrets.md) after. |
| A worker is compromised          | Cordon its node, scale the deployment to zero. Do not delete the pod.     |
| Tokens are being forged          | Revoke every refresh-token family and force re-authentication.            |
| The admin console is compromised | Disable admin access at the ingress and revoke admin sessions.            |
| You do not know                  | Cut egress. §"Cut egress" below.                                          |

```bash
# Isolate a suspect worker without destroying it.
kubectl cordon <node>
kubectl -n "$NS" scale deploy/montaj-worker-ai --replicas=0
kubectl -n "$NS" patch scaledobject montaj-worker-ai --type merge -p '{"spec":{"maxReplicaCount":0}}'
```

**Cut egress** — the strongest containment available, and it stops exfiltration
even if you have not identified the path:

```bash
kubectl -n "$NS" apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: incident-deny-all-egress
spec:
  podSelector: {}
  policyTypes: [Egress]
EOF
```

That takes the platform down. Take it down. The default-deny policy the chart
already installs means egress is narrow to begin with; this closes the remainder.

## Minute 5–20: establish scope

The one question that determines everything after this hour: **was personal data
accessed, and whose?**

```bash
# Who called the AWS API, and as what?
aws cloudtrail lookup-events --start-time "$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --max-results 200 --query 'Events[].{t:EventTime,n:EventName,u:Username,src:SourceIPAddress}' --output table

# Who read the raw media bucket?
BUCKET=$(terraform -chdir=infra/terraform/envs/$ENV output -raw s3_raw_bucket)
aws s3api get-bucket-logging --bucket "$BUCKET"

# Who authenticated to the cluster?
aws logs filter-log-events --log-group-name "/aws/eks/montaj-$ENV/cluster" \
  --log-stream-name-prefix authenticator --start-time "$(( ($(date +%s) - 86400) * 1000 ))" | head -50

# Where did traffic go? Egress to an address outside the allow-list is the tell.
aws logs filter-log-events --log-group-name "/aws/vpc/montaj-$ENV/flow-logs" \
  --start-time "$(( ($(date +%s) - 21600) * 1000 ))" --filter-pattern '[version, account, eni, source, destination, srcport, destport, protocol, packets, bytes, start, end, action=ACCEPT, status]' | head -50
```

Assets ranked by how badly their exposure hurts (`THREAT-MODEL` "Assets"):

1. **User media and transcripts** — personal data, often client footage under
   NDA. This is the one that triggers regulatory obligations.
2. **Credentials and sessions** — bad, but revocable within minutes.
3. **Provider API keys and `INTERNAL_CALLBACK_SECRET`** — money and forged job
   completions.
4. **Credits, ledger, mandates, payouts** — money, and reconcilable.
5. **Signed render manifests** — revenue enforcement (T10); a residual risk we
   already accepted.

Write down, as facts and not guesses: **what** was accessed, **whose** data,
**when**, **how**, and **whether it is still happening**.

## Minute 20–40: eradicate

Only once you know the path in.

```bash
# Revoke every session (T2).
kubectl -n "$NS" exec deploy/montaj-api -- node dist/scripts/auth-revoke-all-families.js --confirm

# Rotate every credential the compromised component could read.
# rotate-secrets.md, but skip the two-key windows: swap immediately.
```

Rotate in this order — signing keys before provider keys, because a forged token
grants more than a leaked API key:

1. `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`
2. `INTERNAL_CALLBACK_SECRET`
3. `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
4. Provider API keys (`SARVAM_*`, `ELEVENLABS_*`, `ASSEMBLYAI_*`, `ANTHROPIC_*`, `OPENAI_*`)
5. `R2_ACCESS_KEY` / `R2_SECRET_KEY`, and any static S3 key
6. Database master password
7. The GitHub OIDC deploy role's trust policy, if CI is implicated

Rebuild rather than clean: replace compromised nodes and re-deploy from a known
good image digest. A cleaned host is a host you are guessing about.

## Minute 40–60: the notification clock

**This is the part with a legal deadline, and it is why the hour matters.**

India's DPDP Act requires notification of a personal-data breach to the Data
Protection Board **and to every affected user**, without the materiality
threshold other regimes allow. There is no "it was only a few records" exception.

**[H] Escalate now — this is not an engineering decision:**

- **Dikshant** — owns the accounts and the external relationships.
- **The grievance officer** named in the privacy notice — the statutory contact.
- **Data protection counsel** (A00-09, A00-13) — decides on notification.

Prepare, so counsel is deciding rather than waiting:

| Field       | Content                                               |
| ----------- | ----------------------------------------------------- |
| Nature      | What kind of data, what happened                      |
| Scope       | How many data principals, which categories            |
| Timeline    | First access, detection, containment (UTC)            |
| Cause       | The control that failed, mapped to a THREAT-MODEL row |
| Remediation | Done, and planned                                     |
| User impact | What each affected user needs to do                   |

If data reached a **sub-processor** (an ASR or LLM provider, R2, Sentry,
PostHog), the DPA obligations in `05 §8` and decision D17 apply: the
`provider_submissions` registry (D47) records which provider received which
artefact, and it is the authoritative answer to "what did they get".

```bash
kubectl -n "$NS" exec deploy/montaj-api -- \
  node dist/scripts/provider-submissions-report.js --since "<first-access>" --format csv
```

## After the first hour

- [ ] Containment holds; no ongoing access.
- [ ] Every implicated credential rotated and the old one revoked.
- [ ] Compromised hosts replaced, not cleaned.
- [ ] Evidence preserved, with retention extended.
- [ ] Scope written down as fact.
- [ ] **[H]** Counsel engaged; notification decision recorded with reasoning.
- [ ] Affected users identified.
- [ ] The THREAT-MODEL row that failed identified by number.
- [ ] Timeline reconstructed from logs, not memory.

## Getting the platform back

In this order, and not before the checklist above:

1. Remove `incident-deny-all-egress`.
2. Restore worker scaling: [scale-gpu.md](scale-gpu.md).
3. Re-deploy from a known good digest: [deploy.md](deploy.md).
4. Drain the DLQ that built up: [dlq-replay.md](dlq-replay.md).
5. Release orphaned credit holds — an incident that leaves users' credits
   reserved is an incident plus a support queue.
6. If data was destroyed rather than exposed:
   [restore-from-pitr.md](restore-from-pitr.md), and note that a restore
   **resurrects data that erasure requests had removed**. Replay the tombstones.

## Afterwards

Write the post-incident review within a week, and structure it around the threat
model: which row failed, why the mitigation did not hold, and what changes. If
the answer is "a threat we had not written down", the review's output is a new
row in `docs/THREAT-MODEL.md` — which is an ADR for Fable, not an edit an
engineer makes alone.

`X01` (the security review before Gate C) re-verifies every threat-model row with
tests or manual evidence. An incident is the most expensive way to discover a gap,
and the least excusable one to leave unrecorded.
