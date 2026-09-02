# Runbook — deploy

Ship a release of the application to `staging` or `prod`. For infrastructure
changes (Terraform), see the "Infrastructure changes" section at the end.

**Prerequisites:** the release is green on CI, and you have said out loud which
environment you are deploying to.

---

## 1. Decide what you are shipping

```bash
ENV=staging                      # or prod
TAG=$(git rev-parse --short HEAD)
NS=montaj
```

Confirm the image for every component exists in the registry. A partial push is
the most common cause of a deploy that half-works:

```bash
aws ecr describe-images --repository-name montaj/api    --image-ids imageTag="$TAG" >/dev/null
aws ecr describe-images --repository-name montaj/web    --image-ids imageTag="$TAG" >/dev/null
aws ecr describe-images --repository-name montaj/worker-media --image-ids imageTag="$TAG" >/dev/null
aws ecr describe-images --repository-name montaj/worker-ai    --image-ids imageTag="$TAG" >/dev/null
aws ecr describe-images --repository-name montaj/render  --image-ids imageTag="$TAG" >/dev/null
```

`realtime` and `scheduler` run the `montaj/api` image with a different
`--role` argument, so there is no separate image for them.

## 2. Point kubectl at the right cluster

```bash
aws eks update-kubeconfig --name "montaj-$ENV" --region ap-south-1
kubectl config current-context          # read it back before continuing
```

## 3. Database migrations first, and separately

Migrations run **before** the new pods, as their own step, and they must be
backward compatible with the running release — otherwise a rollback becomes a
data problem instead of a deploy problem.

```bash
kubectl -n "$NS" delete job montaj-migrate --ignore-not-found
kubectl -n "$NS" create job montaj-migrate \
  --image "$REGISTRY/montaj/api:$TAG" \
  -- node dist/scripts/migrate.js
kubectl -n "$NS" wait --for=condition=complete job/montaj-migrate --timeout=10m
kubectl -n "$NS" logs job/montaj-migrate | tail -40
```

If the migration fails, **stop**. Do not deploy the application on top of a
half-applied schema.

## 4. Deploy

```bash
helm upgrade --install montaj infra/k8s/montaj \
  --namespace "$NS" --create-namespace \
  -f "infra/k8s/montaj/values-$ENV.yaml" \
  --set image.tag="$TAG" \
  --set image.registry="$REGISTRY" \
  --atomic --timeout 15m
```

`--atomic` rolls the release back automatically if it does not become healthy
inside the timeout. That is a feature: an unhealthy release that stays up is
worse than one that reverts.

## 5. Verify, in this order

```bash
# 1. Rollouts finished
for c in api web realtime worker-media worker-ai render scheduler; do
  kubectl -n "$NS" rollout status "deploy/montaj-$c" --timeout=5m
done

# 2. The environment secret is current
kubectl -n "$NS" get externalsecret montaj-env \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}{"\n"}'   # expect True

# 3. Health endpoints
kubectl -n "$NS" run curl-check --rm -i --restart=Never --image=curlimages/curl:8.10.1 -- \
  -sS -o /dev/null -w '%{http_code}\n' http://montaj-api:3001/health

# 4. Queues are being consumed, not just accepted
kubectl -n "$NS" get scaledobject
```

Then, from outside the cluster:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://$( [ "$ENV" = prod ] && echo api.aksharo.ai || echo staging-api.aksharo.ai )/health"
```

## 6. Watch for fifteen minutes

Open **Montaj / Service health** and confirm:

- API p95 has not moved above 300 ms (`05 §10`).
- 5xx rate is flat.
- Job success rate per queue is unchanged.
- `montaj_job_callback_rejected_total{reason="bad_signature"}` is zero — a spike
  here after a deploy means `INTERNAL_CALLBACK_SECRET` differs between the API
  and the workers.

If any of these move the wrong way, go to [rollback.md](rollback.md). Fifteen
minutes of patience is cheaper than an hour of diagnosis under load.

---

## First deploy of an environment

Extra steps that only apply once, in order. Several are **[H]**.

1. **[H]** Every SSM parameter still holding `REPLACE_ME_SEE_infra_README_H_ITEMS`
   is filled in. `terraform output human_supplied_parameters` lists them; see
   `infra/README.md`.
2. Cluster add-ons are installed: `external-secrets`, `keda`, `ingress-nginx`,
   `cert-manager`, `kube-prometheus-stack`, the OTel collector. The chart depends
   on their CRDs and will fail to install without them.
3. The `external-secrets` service account is annotated with the IRSA role:
   ```bash
   kubectl -n external-secrets annotate serviceaccount external-secrets \
     "eks.amazonaws.com/role-arn=$(terraform -chdir=infra/terraform/envs/$ENV output -raw external_secrets_role_arn)" --overwrite
   ```
4. `values-$ENV.yaml` has `redis.address`, `networkPolicy.vpcCidr` and
   `image.registry` filled in from `terraform output`. The chart's NOTES warn
   about an empty `redis.address`; heed it, or every ScaledObject silently fails
   to read its queue depth.
5. **[H]** Repoint DNS. Until this step `app.` and `api.` resolve to TEST-NET-1
   (`terraform output dns_targets_are_placeholders` is `true`):
   ```bash
   kubectl -n ingress-nginx get svc ingress-nginx-controller \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{"\n"}'
   ```
   Put that hostname into `ingress_target` in the environment's tfvars and apply
   the `dns` module.
6. Apply the observability layer:
   ```bash
   kubectl -n observability apply -f infra/observability/alerts/montaj-alerts.yaml
   # Import both dashboards from infra/observability/dashboards/ into Grafana.
   ```

## Egress restrictions and the provider allow-list

The chart's network policies deny worker egress by default. With the stock AWS
VPC CNI, hostname-level rules cannot be enforced in-cluster, so `worker-ai` is
allowed TCP 443 to any public address and the real allow-list lives at the egress
proxy. Two consequences:

- Adding a provider means editing `networkPolicy.providerAllowlist` in
  `values.yaml` **and** the egress proxy configuration. The first is
  documentation until the second is done.
- On a Cilium cluster, set `networkPolicy.fqdn.mode=audit (then enforce; see egress-policy.md)` and the allow-list
  becomes enforcement. That is the intended end state.

## Infrastructure changes (Terraform)

```bash
cd infra/terraform/envs/$ENV
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
# Read the plan. Every line. With a second person for prod.
terraform apply tfplan
```

Rules that are not negotiable:

- **Never** `terraform apply` without reviewing a saved plan.
- A plan that proposes to **replace** `aws_db_instance`, `aws_elasticache_replication_group`
  or `aws_s3_bucket` is a data-loss plan. Stop and work out why.
- `terraform destroy` is not a runbook step in any environment that has served a
  real user.

## Email (SES) setup — manual steps (added 2026-09-02 after A25)

1. Verify the sending domain and `MAIL_FROM` identity in SES (ap-south-1); request production access (out of sandbox) before launch.
2. Create the SNS topic for bounces/complaints/deliveries and subscribe `https://<API_ORIGIN>/internal/mail/events` (HTTPS). The API verifies the SNS signature but **does not auto-confirm** subscriptions: read the `SubscriptionConfirmation` log line and confirm the subscription from the AWS console (or curl the `SubscribeURL` from an operator machine).
3. Set `MAIL_SNS_TOPIC_ARN` to that topic's ARN so notifications from any other topic are rejected.
4. Confirm the pod's IRSA role has `ses:SendEmail` on the identity; `MAIL_PROVIDER=ses`, `MAIL_FROM` set; `dev` is refused in production.
