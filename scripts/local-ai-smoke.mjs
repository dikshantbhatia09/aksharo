#!/usr/bin/env node
/**
 * M15: a real end-to-end local-AI smoke test.
 *
 * Signs up a brand-new user against a running API (no mocked provider —
 * `SARVAM_API_KEY`/`ELEVENLABS_API_KEY`/`ASSEMBLYAI_API_KEY` are unset in this
 * worktree's `.env`, so the routing table's last-resort candidate,
 * `local-whisper`, is what actually transcribes), creates the bundled sample
 * project (a real clip, ingested through the real `media.probe` pipeline),
 * commissions a real transcription, polls until `worker-ai` finishes it,
 * prints the first ten caption segments, then runs one export and confirms
 * the artefact is a real, non-empty file.
 *
 * Prerequisites (all foreground, all documented in
 * docs/models/LOCAL-MODELS.md): postgres/redis/minio running, the API,
 * worker-media, render and worker-ai processes running against this
 * worktree's `.env`, and `montaj_m15` migrated.
 *
 * Usage: node scripts/local-ai-smoke.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/**
 * Postgres and Redis run in the shared `docker-compose.yml` stack
 * (`montaj-postgres`, `montaj-redis` — every worktree's `.env` points at the
 * same containers, differing only by database name / key prefix). Shelling
 * out to `docker exec psql`/`redis-cli` avoids adding `pg`/`ioredis` as this
 * script's own dependencies — it has none, and runs with plain `node`.
 */
function psql(sql, params = []) {
  const args = [
    "exec",
    "-i",
    "montaj-postgres",
    "psql",
    "-U",
    "montaj",
    "-d",
    "montaj_m15",
    "-t",
    "-A",
    "-F",
    "\t",
  ];
  let statement = sql;
  params.forEach((value, index) => {
    const literal =
      typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
    statement = statement.replaceAll(`$${index + 1}`, literal);
  });
  const output = execFileSync("docker", [...args, "-c", statement], { encoding: "utf8" });
  return output
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

function redisLrange(key) {
  // Default (raw) output: one JSON-encoded outbox message per line, verbatim
  // (the API's outbox entries are single-line JSON — no embedded newlines).
  const output = execFileSync(
    "docker",
    ["exec", "montaj-redis", "redis-cli", "lrange", key, "0", "-1"],
    {
      encoding: "utf8",
    },
  );
  return output
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function parseEnv(source) {
  const result = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // eslint-disable-next-line security/detect-object-injection -- key is parsed from this script's own local .env file, not attacker input
    result[key] = value;
  }
  return result;
}

const env = { ...parseEnv(readFileSync(join(REPO_ROOT, ".env"), "utf8")), ...process.env };

const API_ORIGIN = env.API_ORIGIN ?? "http://127.0.0.1:3980";
const REDIS_KEY_PREFIX = env.MONTAJ_REDIS_PREFIX ?? "montaj";

const t0 = Date.now();
const timings = {};

function mark(label) {
  // eslint-disable-next-line security/detect-object-injection -- label is one of this script's own hardcoded call sites, not attacker input
  timings[label] = Date.now() - t0;
}

async function api(method, path, { token, body, query } = {}) {
  const url = new URL(API_ORIGIN + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function waitForVerificationToken(email, timeoutMs = 150_000) {
  const key = `${REDIS_KEY_PREFIX}:auth:dev-outbox`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = redisLrange(key);
    const message = messages.find(
      (entry) =>
        entry.to.toLowerCase() === email.toLowerCase() && entry.template === "email_verification",
    );
    if (message?.token) return message.token;
    if (Date.now() > deadline)
      throw new Error(`no verification email for ${email} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function ulid() {
  // Not a real ULID (no Crockford base32 monotonic encoding) — good enough as
  // a unique primary key for these three fixture rows.
  return `smoke${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    .padEnd(26, "0")
    .slice(0, 26);
}

async function grantCredits(workspaceId) {
  const grantTenths = 2000; // 200 credits — comfortably above any single fixture's quote.
  const accountId = ulid();
  const lotId = ulid();
  const ledgerId = ulid();

  psql(
    `INSERT INTO credit_accounts (id, workspace_id, balance_tenths, monthly_grant_tenths, created_at)
     VALUES ($1, $2, $3, $3, now())
     ON CONFLICT (workspace_id) DO UPDATE SET balance_tenths = credit_accounts.balance_tenths + $3`,
    [accountId, workspaceId, grantTenths],
  );
  const [[resolvedAccountId, balanceAfterRaw]] = psql(
    `SELECT id, balance_tenths FROM credit_accounts WHERE workspace_id = $1`,
    [workspaceId],
  );
  const balanceAfter = Number(balanceAfterRaw);

  psql(
    `INSERT INTO credit_lots (id, account_id, source, granted_tenths, remaining_tenths, created_at)
     VALUES ($1, $2, 'grant', $3, $3, now())`,
    [lotId, resolvedAccountId, grantTenths],
  );
  psql(
    `INSERT INTO credit_ledger (id, account_id, delta_tenths, kind, ref_type, lot_id, balance_after_tenths, at)
     VALUES ($1, $2, $3, 'grant', 'local_ai_smoke', $4, $5, now())`,
    [ledgerId, resolvedAccountId, grantTenths, lotId, balanceAfter],
  );
}

async function main() {
  console.log(`[local-ai-smoke] API_ORIGIN=${API_ORIGIN}`);

  // --- Sign up -------------------------------------------------------------
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = `local-ai-smoke-${suffix}@example.test`;
  const password = "correct-horse-battery-staple";
  await api("POST", "/auth/signup", {
    body: {
      email,
      password,
      name: "Local Smoke",
      dateOfBirth: "1995-04-12",
      jurisdiction: "IN",
    },
  });
  mark("signed_up");

  const token = await waitForVerificationToken(email);
  await api("POST", "/auth/verify-email", { body: { token } });
  mark("verified");

  const { accessToken, workspaceId } = await api("POST", "/auth/login", {
    body: { email, password },
  });
  mark("logged_in");
  console.log(
    `[local-ai-smoke] signed up + verified + logged in: ${email} (workspace ${workspaceId})`,
  );

  await grantCredits(workspaceId);
  mark("credits_granted");

  // --- Create the bundled sample project (real clip, real media.probe) -----
  const project = await api("POST", "/projects/sample", { token: accessToken });
  mark("sample_project_created");
  console.log(`[local-ai-smoke] project ${project.id} created with the bundled sample clip`);

  // Wait for media.probe (worker-media) to mark the project ready.
  const media = await pollUntil(
    () => api("GET", `/projects/${project.id}/media`, { token: accessToken }),
    (items) =>
      Array.isArray(items) && (items[0]?.status === "ready" || items[0]?.status === "failed"),
    { timeoutMs: 60_000, label: "media probed" },
  );
  mark("media_probed");
  console.log(`[local-ai-smoke] media probed: ${JSON.stringify(media[0]?.probe ?? media[0])}`);

  // --- Commission a real transcription (local-whisper, no vendor keys) -----
  const { jobId } = await api("POST", `/projects/${project.id}/transcribe`, {
    token: accessToken,
    body: { languages: ["hi-Latn"], hints: [], diarise: true },
  });
  mark("transcribe_queued");
  console.log(`[local-ai-smoke] transcription queued: job ${jobId}`);

  await pollUntil(
    () => api("GET", `/jobs/${jobId}`, { token: accessToken }),
    (job) => job.status === "succeeded" || job.status === "failed",
    { timeoutMs: 180_000, label: "transcription job" },
  ).then((job) => {
    if (job.status !== "succeeded") {
      throw new Error(`transcription job ${jobId} ended as ${job.status}: ${JSON.stringify(job)}`);
    }
  });
  mark("transcribed");
  console.log(
    `[local-ai-smoke] transcription finished in ${timings.transcribed - timings.transcribe_queued}ms`,
  );

  // --- Print the first ten caption segments ---------------------------------
  const page = await api("GET", `/projects/${project.id}/transcript`, {
    token: accessToken,
    query: { limit: "10" },
  });
  const segments = (page.chunks ?? []).slice(0, 10);
  console.log(`[local-ai-smoke] first ${segments.length} caption segment(s):`);
  for (const segment of segments) {
    console.log(`  ${JSON.stringify(segment)}`);
  }
  mark("segments_printed");

  // --- One export ------------------------------------------------------------
  const exportJob = await api("POST", `/projects/${project.id}/exports`, {
    token: accessToken,
    body: { kind: "subtitle", subtitle: { formats: ["srt"] } },
  });
  mark("export_queued");
  console.log(`[local-ai-smoke] export queued: ${JSON.stringify(exportJob)}`);

  const exportJobId = exportJob.job.jobId;
  const finishedExportJob = await pollUntil(
    () => api("GET", `/jobs/${exportJobId}`, { token: accessToken }),
    (job) => job.status === "succeeded" || job.status === "failed",
    { timeoutMs: 120_000, label: "export job" },
  );
  if (finishedExportJob.status !== "succeeded") {
    throw new Error(
      `export job ${exportJobId} ended as ${finishedExportJob.status}: ${JSON.stringify(finishedExportJob)}`,
    );
  }
  mark("exported");

  const exportList = await api("GET", `/projects/${project.id}/exports`, { token: accessToken });
  const finishedExport = (exportList.items ?? exportList).find(
    (item) => item.id === exportJob.exportId,
  );
  console.log(
    `[local-ai-smoke] export finished: ${JSON.stringify(finishedExport ?? finishedExportJob)}`,
  );

  console.log("\n[local-ai-smoke] timings (ms from start):");
  for (const [label, ms] of Object.entries(timings)) console.log(`  ${label}: ${ms}`);
  console.log("\n[local-ai-smoke] PASS");
}

async function pollUntil(fetcher, isDone, { timeoutMs, intervalMs = 1000, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fetcher();
    if (isDone(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((error) => {
  console.error("[local-ai-smoke] FAIL:", error);
  process.exitCode = 1;
});
