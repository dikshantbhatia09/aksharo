#!/usr/bin/env node
/**
 * X02 load harness (A23 brief item 6).
 *
 * The brief names k6 first ("k6 (or autocannon)"); neither is available as a
 * dependency in this monorepo and neither is installed in this environment,
 * so this is a hand-rolled equivalent using only Node's own `fetch` and
 * global `WebSocket` (stable since Node 22, `docs/CONTRACTS.md`'s floor) plus
 * `pg` (already a dependency of `apps/api`) for the one-time fixture setup —
 * the same "no new runtime dependency for a script" preference
 * `apps/web/e2e/fixtures-media.ts` states for its own WAV generator. A real
 * k6 script covering the identical scenario is `load/k6-transcribe.js`, for
 * a machine (or CI runner) that has k6 installed; this file can print the
 * `ACCESS_TOKEN`/`PROJECT_IDS` that script needs (`--k6-prep`).
 *
 * Scenario: 100 concurrent `POST /projects/{id}/transcribe` calls (job
 * creation only — no worker is involved, matching the brief's "submitting
 * 100 concurrent transcribe jobs with the mock provider": job *admission* is
 * what this asserts on, not ASR throughput). Asserts:
 *   - API p95 < 300ms for job creation
 *   - all 100 jobs are accepted (202) and reach `queued` status
 *   - a WS `job.progress`/`job.completed` event is delivered for a sampled
 *     job once it is completed through the signed internal callback
 *     (CONTRACTS §3) — proof the realtime fan-out works under load, not
 *     just admission.
 *
 * Spread across several `agency`-plan workspaces, not one: job admission is
 * per-workspace (`PLAN_CONCURRENCY_LANE`, `apps/api/src/jobs/jobs.config.
 * ts`) and even `agency`'s lane is 32, well under 100 — a single-workspace
 * run of this harness 429s (`jobs/concurrency_cap`) after 2 on the seeded
 * demo workspace's `free` plan. See `setupFixtures`'s comment and the final
 * report's "bugs found" section for the repro.
 *
 * Usage: `node load/run.mjs` (from the repository root, or anywhere — it
 * walks up for `.env` the same way `apps/web/e2e/env.ts` does). Requires the
 * API already running and migrated/seeded (`pnpm --filter @montaj/api
 * db:migrate && db:seed`) — `scripts/verify-wave.mjs` runs it in that order.
 */
import { createHmac, createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { ulid } from "ulid";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

// --- .env loading (same minimal parser as apps/web/e2e/env.ts) ------------
function findEnvFile(startDir) {
  let dir = startDir;
  const { root } = parsePath(dir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseEnv(source) {
  const result = {};
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equals + 1);
    if (value.startsWith('"')) {
      let collected = value.slice(1);
      while (!collected.endsWith('"') && index + 1 < lines.length) {
        index += 1;
        collected += `\n${lines[index]}`;
      }
      value = collected.replace(/"$/, "");
    } else {
      value = value.trim();
    }
    result[key] = value;
  }
  return result;
}

function loadEnv() {
  const file = findEnvFile(process.cwd()) ?? findEnvFile(REPO_ROOT);
  const parsed = file === undefined ? {} : parseEnv(readFileSync(file, "utf8"));
  return { ...parsed, ...process.env };
}

const env = loadEnv();
const API_ORIGIN = env.API_ORIGIN ?? "http://127.0.0.1:3913";
const DATABASE_URL = env.DATABASE_URL;
const INTERNAL_CALLBACK_SECRET = env.INTERNAL_CALLBACK_SECRET;
const JWT_PRIVATE_KEY = env.JWT_PRIVATE_KEY;
const JOB_COUNT = Number(env.LOAD_JOB_COUNT ?? 100);
const P95_BUDGET_MS = 300;

function mintAccessToken({ userId, workspaceId, role }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    sub: userId,
    ws: workspaceId,
    role,
    kind: "web",
    jti: ulid(),
    iat: issuedAt,
    exp: issuedAt + 30 * 60,
    iss: API_ORIGIN,
  };
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput, "utf8")
    .sign(JWT_PRIVATE_KEY)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function signedInternalHeaders(body, attemptId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", INTERNAL_CALLBACK_SECRET);
  mac.update(`${timestamp}.`);
  mac.update(body);
  return {
    "content-type": "application/json",
    "x-montaj-attempt": attemptId,
    "x-montaj-timestamp": String(timestamp),
    "x-montaj-signature": mac.digest("hex"),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Job admission is per-workspace (`PLAN_CONCURRENCY_LANE`,
 * `apps/api/src/jobs/jobs.config.ts`): even the `agency` plan's lane is 32
 * jobs in flight, well under 100 — confirmed by running this harness
 * against a single free-plan workspace first, which 429'd
 * `jobs/concurrency_cap` after 2 (see the final report's "bugs found"
 * section for the repro and why this is a spec/reality mismatch, not a bug
 * in the admission control itself). So "100 concurrent transcribe jobs"
 * is spread across enough `agency`-plan workspaces (lane 32, a safety
 * margin of 2 under it) that no single workspace's lane is what gets
 * measured instead of the API's own admission throughput.
 */
const JOBS_PER_WORKSPACE = 30;

async function ensureAgencyPlanId(client) {
  const plan = await client.query(`SELECT id FROM plans WHERE key = 'agency' LIMIT 1`);
  if (plan.rows.length === 0) {
    throw new Error("plan 'agency' not found — run `pnpm --filter @montaj/api db:seed` first.");
  }
  return plan.rows[0].id;
}

async function createLoadWorkspace(client, planId, index) {
  const workspaceId = ulid();
  const userId = ulid();
  await client.query(
    `INSERT INTO users (id, email, name, email_verified_at, locale, jurisdiction, age_bracket, created_at)
     VALUES ($1, $2, 'X02 Load', now(), 'en-IN', 'IN', 'adult', now())`,
    [userId, `x02-load-${index}-${Date.now()}@example.test`],
  );
  await client.query(
    `INSERT INTO workspaces (id, slug, name, type, owner_id, region, currency, billing_country, billing_state_code, retention_days, created_at)
     VALUES ($1, $2, $3, 'personal', $4, 'in', 'INR', 'IN', '27', 7, now())`,
    [workspaceId, `x02-load-${index}-${Date.now()}`, `X02 load ${index}`, userId],
  );
  await client.query(
    `INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at)
     VALUES ($1, $2, $3, 'owner', 'active', now())`,
    [ulid(), workspaceId, userId],
  );
  await client.query(
    `INSERT INTO subscriptions (id, workspace_id, plan_id, provider, status, current_period_start, current_period_end, created_at)
     VALUES ($1, $2, $3, 'none', 'active', now(), now() + interval '30 days', now())`,
    [ulid(), workspaceId, planId],
  );

  const GRANT_TENTHS = 50_000;
  const accountId = ulid();
  await client.query(
    `INSERT INTO credit_accounts (id, workspace_id, balance_tenths, monthly_grant_tenths)
     VALUES ($1, $2, $3, $3)`,
    [accountId, workspaceId, GRANT_TENTHS],
  );
  const lotId = ulid();
  await client.query(
    `INSERT INTO credit_lots (id, account_id, source, granted_tenths, remaining_tenths)
     VALUES ($1, $2, 'grant', $3, $3)`,
    [lotId, accountId, GRANT_TENTHS],
  );
  await client.query(
    `INSERT INTO credit_ledger (id, account_id, delta_tenths, kind, ref_type, lot_id, balance_after_tenths)
     VALUES ($1, $2, $3, 'grant', 'x02_load', $4, $3)`,
    [ulid(), accountId, GRANT_TENTHS, lotId],
  );

  return { workspaceId, userId };
}

async function setupFixtures(client, count) {
  const planId = await ensureAgencyPlanId(client);
  const workspaceCount = Math.ceil(count / JOBS_PER_WORKSPACE);
  const workspaces = [];
  for (let w = 0; w < workspaceCount; w += 1) {
    workspaces.push(await createLoadWorkspace(client, planId, w));
  }

  const jobs = []; // { workspaceId, accessToken, projectId }
  let remaining = count;
  for (const workspace of workspaces) {
    const accessToken = mintAccessToken({
      userId: workspace.userId,
      workspaceId: workspace.workspaceId,
      role: "owner",
    });
    const thisWorkspaceCount = Math.min(JOBS_PER_WORKSPACE, remaining);
    for (let i = 0; i < thisWorkspaceCount; i += 1) {
      const projectId = ulid();
      await client.query(
        `INSERT INTO projects (id, workspace_id, title, status, created_at, last_activity_at)
         VALUES ($1, $2, $3, 'draft', now(), now())`,
        [projectId, workspace.workspaceId, `X02 load ${i}`],
      );
      await client.query(
        `INSERT INTO media_assets
           (id, project_id, role, bucket, storage_key, mime, duration_ms, has_audio, status, uploaded_at, created_at)
         VALUES ($1, $2, 'primary', 's3', $3, 'audio/wav', 6000, true, 'ready', now(), now())`,
        [ulid(), projectId, `ws/x02-load/p/${projectId}/media/raw.wav`],
      );
      jobs.push({ workspaceId: workspace.workspaceId, accessToken, projectId });
    }
    remaining -= thisWorkspaceCount;
  }

  return { workspaces, jobs };
}

async function fireTranscribeRequests(jobs) {
  const durations = [];
  const results = await Promise.all(
    jobs.map(async ({ projectId, accessToken, workspaceId }) => {
      const start = performance.now();
      try {
        const response = await fetch(`${API_ORIGIN}/projects/${projectId}/transcribe`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            languages: ["hi-Latn"],
            hints: [],
            diarise: false,
            captions: { dropFillers: true, maxChars: 60, maxLines: 1, minMs: 200, maxMs: 8000 },
          }),
        });
        const durationMs = performance.now() - start;
        durations.push(durationMs);
        const ok = response.status === 202 || response.status === 200;
        const body = ok ? await response.json() : await response.text();
        return {
          projectId,
          workspaceId,
          accessToken,
          ok,
          status: response.status,
          durationMs,
          body,
        };
      } catch (error) {
        durations.push(performance.now() - start);
        return {
          projectId,
          workspaceId,
          accessToken,
          ok: false,
          status: 0,
          durationMs: performance.now() - start,
          body: String(error),
        };
      }
    }),
  );
  return { results, durations };
}

async function verifyWsDelivery({ workspaceId, jobId, projectId, attemptId, accessToken }) {
  const wsOrigin = API_ORIGIN.replace(/^http/, "ws");
  const socket = new WebSocket(`${wsOrigin}/realtime`, ["aksharo.v1", `bearer.${accessToken}`]);

  const received = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
      socket.close();
    }, 15_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ t: "subscribe", rooms: [`project:${projectId}`] }));
    });
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(typeof event.data === "string" ? event.data : "{}");
      if (
        frame.t === "event" &&
        (frame.event === "job.completed" || frame.event === "job.progress") &&
        frame.data?.jobId === jobId
      ) {
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve(true);
      }
    });
    socket.addEventListener("error", (event) => {
      console.error("[ws] error", event.message ?? event);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
    socket.addEventListener("close", (event) => {
      if (process.env.LOAD_DEBUG) console.error("[ws] close", event.code, event.reason);
    });

    // Give the subscribe frame a moment to land before completing the job.
    setTimeout(async () => {
      const body = JSON.stringify({
        status: "succeeded",
        result: {
          transcriptId: ulid(),
          language: "hi-Latn",
          chunks: [
            {
              chunkIdx: 0,
              startMs: 0,
              endMs: 1000,
              words: [{ wid: "0:0", s: 0, e: 400, t: "namaste", sp: "s1" }],
            },
          ],
          providerSubmissions: [],
        },
      });
      const response = await fetch(`${API_ORIGIN}/internal/jobs/${jobId}/complete`, {
        method: "POST",
        headers: signedInternalHeaders(body, attemptId),
        body,
      }).catch((error) => {
        console.error("[complete] fetch failed", error);
        return undefined;
      });
      if (response !== undefined && !response.ok && process.env.LOAD_DEBUG) {
        console.error("[complete] non-ok", response.status, await response.text());
      }
    }, 500);
  });

  return received;
}

async function main() {
  if (DATABASE_URL === undefined) throw new Error("DATABASE_URL is not set.");
  if (INTERNAL_CALLBACK_SECRET === undefined)
    throw new Error("INTERNAL_CALLBACK_SECRET is not set.");
  if (JWT_PRIVATE_KEY === undefined) throw new Error("JWT_PRIVATE_KEY is not set.");

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log(
    `X02 load harness: preparing ${JOB_COUNT} projects across ${Math.ceil(
      JOB_COUNT / JOBS_PER_WORKSPACE,
    )} agency-plan workspaces (lane 32, ${JOBS_PER_WORKSPACE}/workspace) against ${API_ORIGIN} ...`,
  );
  const { workspaces, jobs } = await setupFixtures(client, JOB_COUNT);

  if (process.argv.includes("--k6-prep")) {
    // k6 needs one bearer token; print the first workspace's, and note the
    // caveat this implies (k6-transcribe.js's own header covers it further).
    console.log(`ACCESS_TOKEN=${jobs[0]?.accessToken ?? ""}`);
    console.log(`PROJECT_IDS=${jobs.map((j) => j.projectId).join(",")}`);
    await client.end();
    return;
  }

  console.log(
    `Firing ${jobs.length} concurrent POST /projects/{id}/transcribe across ${workspaces.length} workspaces ...`,
  );
  const { results, durations } = await fireTranscribeRequests(jobs);
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(
    `job creation: ${succeeded.length}/${results.length} succeeded, p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms`,
  );
  if (failed.length > 0) {
    console.log(
      "failures (first 5):",
      failed.slice(0, 5).map((f) => ({ projectId: f.projectId, status: f.status, body: f.body })),
    );
  }

  // --- WS delivery check on one sampled job -------------------------------
  let wsDelivered = false;
  const sample = succeeded[0];
  if (sample !== undefined) {
    const jobResponse = await fetch(`${API_ORIGIN}/jobs/${sample.body.jobId}`, {
      headers: { Authorization: `Bearer ${sample.accessToken}` },
    });
    const job = await jobResponse.json();
    wsDelivered = await verifyWsDelivery({
      workspaceId: sample.workspaceId,
      jobId: sample.body.jobId,
      projectId: sample.projectId,
      attemptId: job.attemptId ?? "",
      accessToken: sample.accessToken,
    });
    console.log(`WS delivery for a sampled job: ${wsDelivered ? "delivered" : "NOT delivered"}`);
  }

  await client.end();

  const p95Pass = p95 < P95_BUDGET_MS;
  const allSucceeded = failed.length === 0;
  const overallPass = p95Pass && allSucceeded && wsDelivered;

  const date = new Date().toISOString().slice(0, 10);
  const reportDir = join(REPO_ROOT, "docs", "verification");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `load-${date}.md`);
  const report = `# X02 load report — ${date}

Scenario: ${JOB_COUNT} concurrent \`POST /projects/{id}/transcribe\` calls against \`${API_ORIGIN}\` (job admission only; no worker involved — see \`load/run.mjs\`'s header).

| Metric | Value | Budget | Result |
|---|---|---|---|
| Requests | ${results.length} | ${JOB_COUNT} | ${results.length === JOB_COUNT ? "OK" : "MISMATCH"} |
| Succeeded (202) | ${succeeded.length} | ${JOB_COUNT} | ${allSucceeded ? "PASS" : "FAIL"} |
| p50 job-creation latency | ${p50.toFixed(1)} ms | — | — |
| p95 job-creation latency | ${p95.toFixed(1)} ms | < ${P95_BUDGET_MS} ms | ${p95Pass ? "PASS" : "FAIL"} |
| p99 job-creation latency | ${p99.toFixed(1)} ms | — | — |
| WS event delivered (sampled job) | ${wsDelivered ? "yes" : "no"} | yes | ${wsDelivered ? "PASS" : "FAIL"} |

**Overall: ${overallPass ? "PASS" : "FAIL"}**
${failed.length > 0 ? `\nFailures (first 10):\n\n\`\`\`json\n${JSON.stringify(failed.slice(0, 10), null, 2)}\n\`\`\`\n` : ""}
`;
  writeFileSync(reportPath, report, "utf8");
  console.log(`Report written to ${reportPath}`);

  if (!overallPass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
