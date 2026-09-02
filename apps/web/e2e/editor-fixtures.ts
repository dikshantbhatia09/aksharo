import { createHmac, randomBytes } from "node:crypto";

import { Client as PgClient } from "pg";

import { loadRepoEnv } from "./env";
import { signIn, waitForToken, type Account } from "./fixtures";

import type { Page } from "@playwright/test";

/**
 * Seeding a real editor project for the e2e suite, without a media pipeline.
 *
 * The brief's "the seeded sample" needs a project with a real EDG document —
 * `packages/edg/fixtures/sample-project.json` is exactly that shape, but
 * turning it into rows the running API will serve means driving the same
 * write path a real transcription does: `POST /transcribe` → the worker's
 * signed completion callback → `TranscribeCompletionHandler` → `EdgService.
 * initialise` (`apps/api/src/transcripts/transcribe.handler.ts`,
 * `apps/api/src/edg/README.md`). A real media upload + ffprobe is A06/A07's
 * pipeline and out of this work package's scope, so the one non-HTTP step
 * here is a single `media_assets` row written directly (`role: primary,
 * status: ready`) to satisfy `TranscriptsService`'s "is the media probed?"
 * check — everything else, including the transcription completion itself,
 * goes through the real, signed endpoints exactly as production does.
 */

const env = loadRepoEnv();
export const API_ORIGIN = env["API_ORIGIN"] ?? "http://127.0.0.1:3915";
const INTERNAL_CALLBACK_SECRET = env["INTERNAL_CALLBACK_SECRET"] ?? "";
const DATABASE_URL = env["DATABASE_URL"] ?? "";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A syntactically valid ULID: not cryptographically monotonic, but unique enough for one test run. */
export function testUlid(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (const byte of bytes) out += CROCKFORD[byte % 32];
  return `01${out}`.slice(0, 26).padEnd(26, "0");
}

interface AccessToken {
  accessToken: string;
  workspaceId: string | null;
}

/**
 * After `signIn`, the browser holds the httpOnly session cookie; this
 * exchanges it for a bearer token.
 *
 * Run as `page.evaluate(fetch(...))`, not `page.request.post(...)`:
 * `/api/session/refresh` refuses a cross-site request (`isSameOrigin`,
 * `lib/session/cookie.ts`) by checking `Sec-Fetch-Site`/`Origin`, and
 * Playwright's `APIRequestContext` is a Node-side HTTP client that does not
 * set either the way a real page's own `fetch` does — it answered `403`
 * every time. A `fetch` issued from inside the loaded page is a genuine
 * same-origin request and carries both headers correctly.
 */
async function accessTokenFor(page: Page): Promise<AccessToken> {
  const body = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    if (!response.ok)
      throw new Error(`could not obtain an access token: ${String(response.status)}`);
    return (await response.json()) as { accessToken: string; workspaceId: string | null };
  });
  return body;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

/** CONTRACTS §3's worker → API callback signature. */
function signedHeaders(body: string, attemptId: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = createHmac("sha256", INTERNAL_CALLBACK_SECRET);
  hmac.update(`${String(timestamp)}.`);
  hmac.update(body);
  return {
    "content-type": "application/json",
    "x-montaj-attempt": attemptId,
    "x-montaj-timestamp": String(timestamp),
    "x-montaj-signature": hmac.digest("hex"),
  };
}

export interface FixtureWord {
  wid: string;
  s: number;
  e: number;
  t: string;
  c?: number;
  sp?: string;
  scripts?: { roman?: string; native?: string; en?: string };
  filler?: boolean;
}

export interface FixtureChunk {
  chunkIdx: number;
  startMs: number;
  endMs: number;
  words: FixtureWord[];
}

/**
 * A short Hinglish-flavoured transcript: two speakers, a low-confidence word
 * (for the amber-underline assertion), a filler word (for "hide fillers"),
 * and enough words that a split lands on a real mid-segment word.
 */
export function smallFixtureChunks(): FixtureChunk[] {
  const words: FixtureWord[] = [
    {
      wid: "0:0",
      s: 0,
      e: 400,
      t: "namaste",
      sp: "sp1",
      scripts: { roman: "namaste", native: "नमस्ते" },
      c: 0.95,
    },
    {
      wid: "0:1",
      s: 400,
      e: 800,
      t: "dosto",
      sp: "sp1",
      scripts: { roman: "dosto", native: "दोस्तों" },
      c: 0.92,
    },
    {
      wid: "0:2",
      s: 800,
      e: 1100,
      t: "matlab",
      sp: "sp1",
      scripts: { roman: "matlab" },
      filler: true,
      c: 0.4,
    },
    {
      wid: "0:3",
      s: 1100,
      e: 1500,
      t: "aaj",
      sp: "sp1",
      scripts: { roman: "aaj", native: "आज" },
      c: 0.3,
    },
    {
      wid: "0:4",
      s: 1500,
      e: 1900,
      t: "hum",
      sp: "sp1",
      scripts: { roman: "hum", native: "हम" },
      c: 0.9,
    },
    { wid: "0:5", s: 1900, e: 2300, t: "editor", sp: "sp1", scripts: { roman: "editor" }, c: 0.9 },
    {
      wid: "0:6",
      s: 2300,
      e: 2700,
      t: "dekhenge",
      sp: "sp1",
      scripts: { roman: "dekhenge", native: "देखेंगे" },
      c: 0.9,
    },
    {
      wid: "0:7",
      s: 4000,
      e: 4400,
      t: "bilkul",
      sp: "sp2",
      scripts: { roman: "bilkul", native: "बिल्कुल" },
      c: 0.9,
    },
    {
      wid: "0:8",
      s: 4400,
      e: 4800,
      t: "sahi",
      sp: "sp2",
      scripts: { roman: "sahi", native: "सही" },
      c: 0.9,
    },
    {
      wid: "0:9",
      s: 4800,
      e: 5200,
      t: "hai",
      sp: "sp2",
      scripts: { roman: "hai", native: "है" },
      c: 0.9,
    },
  ];
  return [{ chunkIdx: 0, startMs: 0, endMs: 6000, words }];
}

/** A 3-hour, 18-chunk, ~54,000-word transcript for the scroll-performance test. */
export function largeFixtureChunks(totalWords = 54_000): FixtureChunk[] {
  const chunkDurationMs = 10 * 60 * 1000; // 10 minutes
  const chunkCount = 18; // 3 hours
  const wordsPerChunk = Math.ceil(totalWords / chunkCount);
  const wordDurationMs = Math.floor(chunkDurationMs / wordsPerChunk);
  const pool = [
    "hum",
    "aaj",
    "editor",
    "dekhenge",
    "bilkul",
    "sahi",
    "hai",
    "namaste",
    "dosto",
    "matlab",
  ];
  const chunks: FixtureChunk[] = [];
  for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx += 1) {
    const words: FixtureWord[] = [];
    const chunkStart = chunkIdx * chunkDurationMs;
    for (let n = 0; n < wordsPerChunk; n += 1) {
      const s = n * wordDurationMs;
      words.push({
        wid: `${String(chunkIdx)}:${String(n)}`,
        s,
        e: s + Math.max(1, wordDurationMs - 20),
        t: pool[n % pool.length] ?? "hum",
        sp: n % 40 < 20 ? "sp1" : "sp2",
      });
    }
    chunks.push({ chunkIdx, startMs: chunkStart, endMs: chunkStart + chunkDurationMs, words });
  }
  return chunks;
}

export interface SeededProject {
  readonly projectId: string;
  readonly transcriptId: string;
}

export interface SeedOptions {
  readonly title?: string;
  readonly chunks?: FixtureChunk[];
}

/**
 * Signs up (or reuses `account`), creates a project, marks its media
 * "probed" and drives a real transcription completion so the editor has a
 * real EDG document to open.
 */
export async function seedEditorProject(
  page: Page,
  account: Account,
  options: SeedOptions = {},
): Promise<SeededProject> {
  await signIn(page, account, "/studio");
  const { accessToken, workspaceId } = await accessTokenFor(page);
  const headers = authHeaders(accessToken);

  const projectResponse = await page.request.post(`${API_ORIGIN}/projects`, {
    headers,
    data: { title: options.title ?? "A15 e2e project" },
  });
  if (!projectResponse.ok()) {
    throw new Error(
      `createProject failed: ${String(projectResponse.status())} ${await projectResponse.text()}`,
    );
  }
  const project = (await projectResponse.json()) as { id: string };

  await insertProbedMedia(project.id);
  if (workspaceId) {
    // A fresh signup's workspace starts with 0 credits (B01's billing
    // ledger), but /transcribe quotes ~1.5 credits (15 tenths) for this
    // fixture's 90s media and 402s with credits/insufficient otherwise.
    // Grant a generous balance directly, mirroring the three-table pattern
    // (account + lot + ledger) apps/api/prisma/seed.ts uses for the demo
    // workspace, so the seeded state keeps invariant 1 (balance = Σ lot
    // remainders = Σ ledger deltas).
    await grantCredits(workspaceId);
  }

  const transcribeResponse = await page.request.post(
    `${API_ORIGIN}/projects/${project.id}/transcribe`,
    {
      headers,
      data: {
        languages: ["hi-Latn"],
        hints: [],
        diarise: true,
        // Explicit, generous captions preferences (apps/api/src/edg/init/
        // transcript-init.ts, CAPTION_BOUNDS): dropFillers false (the
        // hide-fillers test needs the filler word IN a segment to hide), and
        // a wide maxChars/maxMs so each speaker turn lands as exactly one
        // caption instead of the segmenter forcing extra breaks to keep
        // reading speed under the 20 CPS ceiling against this fixture's
        // deliberately fast, constant per-word timing (a real transcript's
        // timing would not hit that ceiling nearly this often). The
        // split/merge test relies on this being deterministic.
        captions: { dropFillers: false, maxChars: 60, maxLines: 1, minMs: 200, maxMs: 8000 },
      },
    },
  );
  if (!transcribeResponse.ok()) {
    throw new Error(
      `transcribe failed: ${String(transcribeResponse.status())} ${await transcribeResponse.text()}`,
    );
  }
  const { jobId, transcriptId } = (await transcribeResponse.json()) as {
    jobId: string;
    transcriptId: string;
  };

  const jobResponse = await page.request.get(`${API_ORIGIN}/jobs/${jobId}`, { headers });
  const job = (await jobResponse.json()) as { attemptId: string | null };
  const attemptId = job.attemptId ?? "";

  const chunks = options.chunks ?? smallFixtureChunks();
  const body = JSON.stringify({
    status: "succeeded",
    result: {
      transcriptId,
      language: "hi-Latn",
      chunks,
      providerSubmissions: [],
    },
  });

  const completeResponse = await page.request.post(
    `${API_ORIGIN}/internal/jobs/${jobId}/complete`,
    {
      headers: signedHeaders(body, attemptId),
      data: body,
    },
  );
  if (!completeResponse.ok()) {
    throw new Error(
      `completion callback failed: ${String(completeResponse.status())} ${await completeResponse.text()}`,
    );
  }

  return { projectId: project.id, transcriptId };
}

/** One `media_assets` row, `role: primary`, `status: ready` — the one piece not reachable over HTTP without a real upload. */
async function insertProbedMedia(projectId: string): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO media_assets
         (id, project_id, role, bucket, storage_key, mime, duration_ms, fps, width, height, has_audio, status, uploaded_at, created_at)
       VALUES ($1, $2, 'primary', 's3', $3, 'video/mp4', $4, 30, 1080, 1920, true, 'ready', now(), now())`,
      [testUlid(), projectId, `ws/e2e/p/${projectId}/media/${testUlid()}/raw.mp4`, 90_000],
    );
  } finally {
    await client.end();
  }
}

/**
 * Grants a fresh workspace enough credits to pass `/transcribe`'s balance
 * check. Writes all three tables `apps/api/prisma/seed.ts` writes for the
 * demo workspace's grant (account, lot, ledger) so invariant 1 (balance =
 * Σ lot remainders = Σ ledger deltas) holds for the seeded rows.
 */
async function grantCredits(workspaceId: string): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const grantTenths = 2000; // 200 credits — comfortably above any single fixture's quote.
    const accountId = testUlid();
    const lotId = testUlid();
    const ledgerId = testUlid();

    await client.query(
      `INSERT INTO credit_accounts (id, workspace_id, balance_tenths, monthly_grant_tenths, created_at)
       VALUES ($1, $2, $3, $3, now())
       ON CONFLICT (workspace_id) DO UPDATE SET balance_tenths = credit_accounts.balance_tenths + $3`,
      [accountId, workspaceId, grantTenths],
    );
    const account = await client.query<{ id: string; balance_tenths: number }>(
      `SELECT id, balance_tenths FROM credit_accounts WHERE workspace_id = $1`,
      [workspaceId],
    );
    const resolvedAccountId = account.rows[0]?.id ?? accountId;
    const balanceAfter = account.rows[0]?.balance_tenths ?? grantTenths;

    await client.query(
      `INSERT INTO credit_lots (id, account_id, source, granted_tenths, remaining_tenths, created_at)
       VALUES ($1, $2, 'grant', $3, $3, now())`,
      [lotId, resolvedAccountId, grantTenths],
    );
    await client.query(
      `INSERT INTO credit_ledger (id, account_id, delta_tenths, kind, ref_type, lot_id, balance_after_tenths, at)
       VALUES ($1, $2, $3, 'grant', 'e2e_fixture', $4, $5, now())`,
      [ledgerId, resolvedAccountId, grantTenths, lotId, balanceAfter],
    );
  } finally {
    await client.end();
  }
}

/** A fresh signed-up-and-verified account, for tests that need their own (not the shared worker account). */
export async function freshAccount(page: Page, label: string): Promise<Account> {
  const { signUpAndVerify } = await import("./fixtures");
  return signUpAndVerify(page, label);
}

export { waitForToken };
