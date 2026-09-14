# Database connection budget

PostgreSQL has a hard `max_connections`. Every process that opens a Prisma pool
spends from it, and a database that runs out refuses **every** connection — the
health probe, the migration job and the operator's `psql` along with the
requests. This is therefore a number to decide in advance, not to discover.

Written for whoever owns the database during a release. Companion to
`apps/api/src/common/prisma/pool.ts`, which enforces the per-process half.

## The rule

```
max_connections − reserved  ≥  Σ over components ( maxReplicas × DATABASE_POOL_SIZE )
```

`reserved` covers what must still be able to connect when the fleet is at its
maximum:

| Reserved for | Connections |
| --- | --- |
| `superuser_reserved_connections` (PostgreSQL's own) | 3 |
| The migration job (`db:migrate` + hand-SQL, runs pre-deploy) | 5 |
| An operator's psql / a support query | 5 |
| RDS Performance Insights and the monitoring role | 5 |
| Headroom for a failover, when old and new connections briefly overlap | 10% of the total |

## Worksheet

Fill this in per environment and keep the result with the release evidence.
**Read the maxima off `infra/k8s/montaj/values-<env>.yaml` rather than trusting
this table**, because they move.

Only the API opens a Prisma pool. `worker-media`, `worker-ai` and `render` carry
`DATABASE_URL` in their environment because it is part of the frozen CONTRACTS §1
list every service validates — none of them connects to PostgreSQL. They reach
the database only through signed callbacks to the API. Verify before trusting
this, because the day a worker starts writing directly is the day the budget
below is wrong:

```bash
grep -rn "PrismaClient\|psycopg\|asyncpg" apps/worker-media/src apps/render/src apps/worker-ai/worker_ai
```

| Component | Max replicas (prod) | Pool per process | Total |
| --- | ---: | ---: | ---: |
| api | 24 | 10 | 240 |
| realtime | 0 (disabled — the API serves `/realtime`) | — | 0 |
| scheduler | 0 (disabled — tasks run on the BullMQ scheduler queue) | — | 0 |
| worker-media / worker-ai / render | any | 0 | 0 |
| Migration job (pre-deploy, transient) | 1 | 5 | 5 |
| **Fleet total at maximum** | | | **245** |

Add the reserved column above (~25) and round up: the production instance needs
`max_connections >= 300`. Check it rather than assuming — RDS derives the default
from instance memory, so a smaller instance class silently gives a smaller
ceiling:

```sql
SHOW max_connections;
```

If it is below the total, take one of these before launch:

1. **Lower `maxReplicas` until the arithmetic fits.** The honest short-term
   answer, and it makes the real throughput ceiling visible before a launch
   rather than during one.
2. **Raise the instance class**, which raises `max_connections` with it.
3. **Put a pooler in front (PgBouncer / RDS Proxy).** The right long-term answer
   and explicitly **not** a launch-window change: Prisma's interactive
   transactions and prepared statements need testing against transaction-mode
   pooling before anything depends on it. `infra/terraform/envs/prod/main.tf`
   already comments that read traffic goes through PgBouncer; no PgBouncer is
   deployed and no code opens a read connection. Treat the read replica as
   unused until both exist.

## Setting it

`DATABASE_POOL_SIZE` is a local process setting (like `API_PORT`), set per
component in the chart's `config` block, not a CONTRACTS §1 variable.

```yaml
# infra/k8s/montaj/values-prod.yaml
components:
  api:
    extraEnv:
      - name: DATABASE_POOL_SIZE
        value: "10"
```

A `connection_limit` already present in `DATABASE_URL` wins over the environment
variable, so a hand-tuned URL is never silently overridden. The effective value
is logged once at boot:

```
database connected {"connectionLimit":10,"poolTimeoutSec":10,"source":"DATABASE_POOL_SIZE"}
```

## Alerting

Alert on utilisation, not on a raw count — the denominator changes with the
instance class.

| Threshold | Severity | Meaning |
| --- | --- | --- |
| 60% | ticket | The budget is wrong, or a component is leaking connections. |
| 75% | page in hours | A failover or the migration job may now fail. |
| 85% | page | Exhaustion is close; every service is about to fail at once. |

`DatabaseConnectionSaturation` in `infra/observability/alerts/` carries these.
The 20% reserved in the worksheet is what those thresholds protect: at 85% there
is still room for the migration job and an operator to get in and fix it.

## Verifying

```sql
-- What the server allows, and what is reserved from it.
SHOW max_connections;
SHOW superuser_reserved_connections;

-- Who is actually holding connections right now.
SELECT usename, application_name, state, count(*)
FROM pg_stat_activity
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

The saturation test in "Capacity and resilience validation" is what turns this
worksheet into evidence: run the fleet at its configured maxima and confirm
`pg_stat_activity` stays under 70% steady and 85% burst.
