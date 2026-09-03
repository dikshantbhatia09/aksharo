/**
 * Sample project seed (A23).
 *
 * Produces one ready-to-open project in the demo workspace `pnpm --filter
 * @montaj/api db:seed` (`seed.ts`) already created: a 90-second Hinglish
 * clip, already transcribed and segmented, with one autocut pass proposal
 * set so Wave 4's review UI has something real to render against once it
 * exists.
 *
 * Unlike `seed.ts`, this is not a pure-Prisma script: a transcript's EDG
 * document is born by `EdgService.initialise`, which the real
 * `POST /projects/{id}/transcribe` completion path calls
 * (`transcripts/transcribe.handler.ts`) — segmentation, budgets and the
 * revision/snapshot bookkeeping all live there, and re-deriving them by hand
 * here would be a second, driftable implementation of that logic. So this
 * script drives the same HTTP surface `apps/web/e2e/editor-fixtures.ts`
 * does: it requires the real API already listening at `API_ORIGIN`
 * (`pnpm --filter @montaj/api start`, or the `api` service in
 * `docker-compose.test.yml`), and only reaches for Prisma directly where
 * that's the documented exception (a probed-media row with no real upload
 * pipeline attached, and the autocut pass — there is no `POST` route for one
 * yet; B18 is still `briefed` per `docs/PLAN.md`).
 *
 * Auth: rather than sign up a throwaway account (this needs to be
 * idempotent and needs no mailbox), it mints an access token for the demo
 * workspace's admin user directly with `TokenService`'s own algorithm
 * (RS256 over `JWT_PRIVATE_KEY`) — the same bytes a real login would hand
 * back, without a password hash existing for that user (`seed.ts`'s note:
 * "no password hash ... a seeded credential would be a shipped secret").
 *
 * Run with: pnpm --filter @montaj/api db:seed:sample
 * (after `db:seed` — it depends on the demo workspace and the free plan).
 */
import { createHmac, createSign } from "node:crypto";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { ulid } from "ulid";

import { loadRepoDotenv } from "../src/config/dotenv.js";

loadRepoDotenv();

const prisma = new PrismaClient();

const DEMO_SLUG = "demo";
const PROJECT_TITLE = "Hinglish sample (A23)";
const SAMPLE_SECONDS = 90;
const SAMPLE_SAMPLE_RATE = 8_000;

function env(name: string, fallback?: string): string {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set — copy .env.example to .env first.`);
  return value;
}

const API_ORIGIN = env("API_ORIGIN", "http://127.0.0.1:3913");
const INTERNAL_CALLBACK_SECRET = env("INTERNAL_CALLBACK_SECRET");
const JWT_PRIVATE_KEY = env("JWT_PRIVATE_KEY");
const S3_ENDPOINT = env("S3_ENDPOINT", "http://localhost:9000");
const S3_REGION = env("S3_REGION", "ap-south-1");
const S3_BUCKET_RAW = env("S3_BUCKET_RAW", "montaj-raw");
const S3_ACCESS_KEY = env("S3_ACCESS_KEY", "montaj-local");
const S3_SECRET_KEY = env("S3_SECRET_KEY", "montaj-local-secret");

// ---------------------------------------------------------------------------
// A 90-second, real, valid PCM WAV — the same hand-rolled generator
// `apps/web/e2e/fixtures-media.ts` uses (no ffmpeg dependency, so this runs
// on any machine that can run Node), extended to a speech-shaped pattern:
// a tone burst per word-group separated by silence, echoing the transcript's
// own turn timing below closely enough to sound structured on playback. Not
// a real Hinglish recording — captured as a known simplification below.
// ---------------------------------------------------------------------------
function generateSampleWav(): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = SAMPLE_SAMPLE_RATE * blockAlign;
  const numSamples = Math.round(SAMPLE_SECONDS * SAMPLE_SAMPLE_RATE);
  const dataSize = numSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  // 900ms tone / 300ms silence, repeating — one "word" of speech-shaped
  // energy every 1.2s for the full 90s, so the waveform has real structure
  // for the editor's waveform view rather than one continuous drone.
  const periodMs = 1_200;
  const toneMs = 900;
  for (let i = 0; i < numSamples; i += 1) {
    const t = i / SAMPLE_SAMPLE_RATE;
    const phaseMs = (t * 1000) % periodMs;
    const sample =
      phaseMs < toneMs ? Math.sin(2 * Math.PI * 220 * t) * 0.2 * 32767 * (1 - phaseMs / toneMs) : 0;
    buffer.writeInt16LE(Math.round(sample), 44 + i * blockAlign);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// The transcript: a scripted, deterministic Hinglish fixture, so ASR is not
// in the loop and the seed is reproducible byte-for-byte on every run.
// Fifteen short speaker turns spanning the full 90s, two speakers, a couple
// of filler words and two low-confidence words (the amber-underline case).
// ---------------------------------------------------------------------------
interface FixtureWord {
  wid: string;
  s: number;
  e: number;
  t: string;
  c?: number;
  sp?: string;
  scripts?: { roman?: string; native?: string; en?: string };
  filler?: boolean;
}

/** Explicit-throw indexed access — clearer at a seed-script call site than a bare `!`. */
function wordAt(words: readonly FixtureWord[], index: number): FixtureWord {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const word = words[index];
  if (word === undefined) {
    throw new Error(`seed-sample: fixture word index ${String(index)} is out of range.`);
  }
  return word;
}

const TURNS: { sp: "s1" | "s2"; words: { t: string; roman: string; native?: string }[] }[] = [
  {
    sp: "s1",
    words: [
      { t: "namaste", roman: "namaste", native: "नमस्ते" },
      { t: "dosto", roman: "dosto", native: "दोस्तों" },
    ],
  },
  {
    sp: "s1",
    words: [
      { t: "aaj", roman: "aaj", native: "आज" },
      { t: "hum", roman: "hum", native: "हम" },
      { t: "baat", roman: "baat", native: "बात" },
      { t: "karenge", roman: "karenge", native: "करेंगे" },
    ],
  },
  {
    sp: "s2",
    words: [
      { t: "bilkul", roman: "bilkul", native: "बिल्कुल" },
      { t: "sahi", roman: "sahi", native: "सही" },
      { t: "topic", roman: "topic" },
    ],
  },
  {
    sp: "s1",
    words: [
      { t: "matlab", roman: "matlab" },
      { t: "editor", roman: "editor" },
      { t: "kaise", roman: "kaise", native: "कैसे" },
      { t: "kaam", roman: "kaam", native: "काम" },
      { t: "karta", roman: "karta", native: "करता" },
      { t: "hai", roman: "hai", native: "है" },
    ],
  },
  {
    sp: "s2",
    words: [
      { t: "dekho", roman: "dekho", native: "देखो" },
      { t: "sabse", roman: "sabse", native: "सबसे" },
      { t: "pehle", roman: "pehle", native: "पहले" },
      { t: "upload", roman: "upload" },
      { t: "karo", roman: "karo", native: "करो" },
    ],
  },
  {
    sp: "s1",
    words: [
      { t: "phir", roman: "phir", native: "फिर" },
      { t: "transcript", roman: "transcript" },
      { t: "ban", roman: "ban", native: "बन" },
      { t: "jaata", roman: "jaata", native: "जाता" },
      { t: "hai", roman: "hai", native: "है" },
    ],
  },
  {
    sp: "s2",
    words: [
      { t: "wow", roman: "wow" },
      { t: "yeh", roman: "yeh", native: "यह" },
      { t: "toh", roman: "toh", native: "तो" },
      { t: "bahut", roman: "bahut", native: "बहुत" },
      { t: "fast", roman: "fast" },
      { t: "hai", roman: "hai", native: "है" },
    ],
  },
  {
    sp: "s1",
    words: [
      { t: "haan", roman: "haan", native: "हाँ" },
      { t: "aur", roman: "aur", native: "और" },
      { t: "styles", roman: "styles" },
      { t: "bhi", roman: "bhi", native: "भी" },
      { t: "bahut", roman: "bahut", native: "बहुत" },
      { t: "saare", roman: "saare", native: "सारे" },
      { t: "hain", roman: "hain", native: "हैं" },
    ],
  },
  {
    sp: "s2",
    words: [
      { t: "punch", roman: "punch" },
      { t: "pop", roman: "pop" },
      { t: "style", roman: "style" },
      { t: "mujhe", roman: "mujhe", native: "मुझे" },
      { t: "pasand", roman: "pasand", native: "पसंद" },
      { t: "hai", roman: "hai", native: "है" },
    ],
  },
  {
    sp: "s1",
    words: [
      { t: "chaliye", roman: "chaliye", native: "चलिए" },
      { t: "wahi", roman: "wahi", native: "वही" },
      { t: "try", roman: "try" },
      { t: "karte", roman: "karte", native: "करते" },
      { t: "hain", roman: "hain", native: "हैं" },
    ],
  },
  {
    sp: "s2",
    words: [
      { t: "matlab", roman: "matlab" },
      { t: "ek", roman: "ek", native: "एक" },
      { t: "click", roman: "click" },
      { t: "mein", roman: "mein", native: "में" },
      { t: "reflow", roman: "reflow" },
      { t: "ho", roman: "ho", native: "हो" },
      { t: "gaya", roman: "gaya", native: "गया" },
    ],
  },
  {
    sp: "s1",
    words: [
      { t: "ab", roman: "ab", native: "अब" },
      { t: "export", roman: "export" },
      { t: "karte", roman: "karte", native: "करते" },
      { t: "hain", roman: "hain", native: "हैं" },
    ],
  },
  {
    sp: "s2",
    words: [
      { t: "srt", roman: "srt" },
      { t: "aur", roman: "aur", native: "और" },
      { t: "mp4", roman: "mp4" },
      { t: "dono", roman: "dono", native: "दोनों" },
    ],
  },
  {
    sp: "s1",
    words: [
      { t: "cloud", roman: "cloud" },
      { t: "render", roman: "render" },
      { t: "bhi", roman: "bhi", native: "भी" },
      { t: "kaam", roman: "kaam", native: "काम" },
      { t: "karta", roman: "karta", native: "करता" },
      { t: "hai", roman: "hai", native: "है" },
    ],
  },
  {
    sp: "s2",
    words: [
      { t: "shukriya", roman: "shukriya", native: "शुक्रिया" },
      { t: "dosto", roman: "dosto", native: "दोस्तों" },
      { t: "milte", roman: "milte", native: "मिलते" },
      { t: "hain", roman: "hain", native: "हैं" },
      { t: "agli", roman: "agli", native: "अगली" },
      { t: "video", roman: "video" },
      { t: "mein", roman: "mein", native: "में" },
    ],
  },
];

/** Lays the turns out end to end across the 90s, with a filler and a low-confidence word woven in. */
function buildFixtureWords(): FixtureWord[] {
  const words: FixtureWord[] = [];
  const turnGapMs = 800;
  const wordDurationMs = 400;
  let cursor = 0;
  let n = 0;

  for (const turn of TURNS) {
    for (const [index, word] of turn.words.entries()) {
      const s = cursor;
      const e = s + wordDurationMs;
      const wid = `0:${String(n)}`;
      const isFiller = word.t === "matlab" && index === 0;
      const lowConfidence = word.t === "kaise" || word.t === "wow";
      words.push({
        wid,
        s,
        e,
        t: word.t,
        sp: turn.sp,
        scripts: { roman: word.roman, native: word.native },
        c: lowConfidence ? 0.32 : 0.9,
        filler: isFiller ? true : undefined,
      });
      cursor = e;
      n += 1;
    }
    cursor += turnGapMs;
  }

  // Stretch the last word's end to the clip's own length, so the transcript
  // and the media agree on duration exactly (D28 invariant: no word past
  // media end).
  const last = words.at(-1);
  if (last !== undefined) last.e = Math.max(last.e, SAMPLE_SECONDS * 1000 - 200);
  return words;
}

function mintAccessToken(input: {
  userId: string;
  workspaceId: string;
  role: "owner" | "admin" | "editor" | "viewer";
}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    sub: input.userId,
    ws: input.workspaceId,
    role: input.role,
    kind: "web",
    jti: ulid(),
    iat: issuedAt,
    exp: issuedAt + 15 * 60,
    iss: API_ORIGIN,
  };
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput, "utf8")
    .sign(JWT_PRIVATE_KEY)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function signedInternalHeaders(body: string, attemptId: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", INTERNAL_CALLBACK_SECRET);
  mac.update(`${String(timestamp)}.`);
  mac.update(body);
  return {
    "content-type": "application/json",
    "x-montaj-attempt": attemptId,
    "x-montaj-timestamp": String(timestamp),
    "x-montaj-signature": mac.digest("hex"),
  };
}

async function uploadSampleAudio(projectId: string): Promise<{ storageKey: string }> {
  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
  });
  const storageKey = `ws/e2e-sample/p/${projectId}/media/sample/raw.wav`;
  await client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET_RAW,
      Key: storageKey,
      Body: generateSampleWav(),
      ContentType: "audio/wav",
    }),
  );
  return { storageKey };
}

/** Idempotent: only grants once — a second run finds the marker lot and does nothing. */
async function grantSeedCredits(workspaceId: string): Promise<void> {
  const GRANT_TENTHS = 5_000;
  const REF_TYPE = "a23_seed_sample";

  const account = await prisma.creditAccount.upsert({
    where: { workspaceId },
    create: { id: ulid(), workspaceId, balanceTenths: 0, monthlyGrantTenths: 0 },
    update: {},
  });

  const already = await prisma.creditLedger.findFirst({
    where: { accountId: account.id, refType: REF_TYPE },
    select: { id: true },
  });
  if (already !== null) return;

  const lot = await prisma.creditLot.create({
    data: {
      id: ulid(),
      accountId: account.id,
      source: "grant",
      grantedTenths: GRANT_TENTHS,
      remainingTenths: GRANT_TENTHS,
    },
  });
  const updated = await prisma.creditAccount.update({
    where: { id: account.id },
    data: { balanceTenths: { increment: GRANT_TENTHS } },
  });
  await prisma.creditLedger.create({
    data: {
      id: ulid(),
      accountId: account.id,
      deltaTenths: GRANT_TENTHS,
      kind: "grant",
      refType: REF_TYPE,
      lotId: lot.id,
      balanceAfterTenths: updated.balanceTenths,
    },
  });
}

async function main(): Promise<void> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { slug: DEMO_SLUG } });
  const adminMembership = await prisma.membership.findFirstOrThrow({
    where: { workspaceId: workspace.id, role: "owner" },
    select: { userId: true },
  });
  const adminUserId = adminMembership.userId;
  if (adminUserId === null) throw new Error("demo workspace's owner membership has no userId");

  // Idempotent: reuse a previous run's project rather than creating a twin.
  const existing = await prisma.project.findFirst({
    where: { workspaceId: workspace.id, title: PROJECT_TITLE },
    select: { id: true, edgDocument: { select: { id: true } } },
  });
  if (existing !== null && existing.edgDocument !== null) {
    console.warn(`seed-sample: project ${existing.id} already seeded, leaving it as is.`);
    await prisma.$disconnect();
    return;
  }

  const accessToken = mintAccessToken({
    userId: adminUserId,
    workspaceId: workspace.id,
    role: "owner",
  });
  const headers = { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

  // Enough credits that /transcribe's balance check never blocks the seed.
  // Written as account + lot + ledger, mirroring seed.ts's own demo-workspace
  // grant, so invariant 1 (balance = Σ lot remainders = Σ ledger deltas)
  // holds for these rows the way B02's property test expects everywhere else.
  await grantSeedCredits(workspace.id);

  const projectId = existing?.id;
  let project: { id: string };
  if (projectId !== undefined) {
    project = { id: projectId };
  } else {
    const response = await fetch(`${API_ORIGIN}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: PROJECT_TITLE }),
    });
    if (!response.ok)
      throw new Error(`create project failed: ${String(response.status)} ${await response.text()}`);
    project = (await response.json()) as { id: string };
  }

  const { storageKey } = await uploadSampleAudio(project.id);
  await prisma.mediaAsset.create({
    data: {
      id: ulid(),
      projectId: project.id,
      role: "primary",
      bucket: "s3",
      storageKey,
      mime: "audio/wav",
      durationMs: SAMPLE_SECONDS * 1000,
      hasAudio: true,
      status: "ready",
      uploadedAt: new Date(),
    },
  });

  const transcribeResponse = await fetch(`${API_ORIGIN}/projects/${project.id}/transcribe`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      languages: ["hi-Latn"],
      hints: [],
      diarise: true,
      captions: { dropFillers: false, maxChars: 60, maxLines: 1, minMs: 200, maxMs: 8_000 },
    }),
  });
  if (!transcribeResponse.ok) {
    throw new Error(
      `transcribe failed: ${String(transcribeResponse.status)} ${await transcribeResponse.text()}`,
    );
  }
  const { jobId, transcriptId } = (await transcribeResponse.json()) as {
    jobId: string;
    transcriptId: string;
  };

  const jobResponse = await fetch(`${API_ORIGIN}/jobs/${jobId}`, { headers });
  const job = (await jobResponse.json()) as { attemptId: string | null };
  const attemptId = job.attemptId ?? "";

  const words = buildFixtureWords();
  const body = JSON.stringify({
    status: "succeeded",
    result: {
      transcriptId,
      language: "hi-Latn",
      chunks: [{ chunkIdx: 0, startMs: 0, endMs: SAMPLE_SECONDS * 1000, words }],
      providerSubmissions: [],
    },
  });
  const completeResponse = await fetch(`${API_ORIGIN}/internal/jobs/${jobId}/complete`, {
    method: "POST",
    headers: signedInternalHeaders(body, attemptId),
    body,
  });
  if (!completeResponse.ok) {
    throw new Error(
      `completion callback failed: ${String(completeResponse.status)} ${await completeResponse.text()}`,
    );
  }

  // --- One autocut pass proposal set -------------------------------------
  // No `POST` route exists yet for a pass (B18 "briefed", not built): the
  // pass and its items are written directly, in `proposed` state, so Wave
  // 4's review UI (B20) has a real pass to open against this project the
  // day it lands. Two filler-word items (the "matlab" filler and one
  // between-turn silence gap) and one low-confidence-word review item.
  const edg = await prisma.edgDocument.findUniqueOrThrow({ where: { projectId: project.id } });
  const fillerWord = words.find((word) => word.filler === true);
  const passId = ulid();
  await prisma.edgPass.create({
    data: {
      id: passId,
      edgId: edg.id,
      type: "autocut",
      engine: "flash",
      params: { dropFillers: true, dropSilences: true, minSilenceMs: 500 },
      status: "ready",
    },
  });
  const items: { startMs: number; endMs: number; reason: string; confidence: number }[] = [
    // The filler word itself.
    ...(fillerWord === undefined
      ? []
      : [{ startMs: fillerWord.s, endMs: fillerWord.e, reason: "filler_word", confidence: 0.86 }]),
    // Two of the 800ms inter-turn gaps, picked past the first two turns.
    {
      startMs: wordAt(words, 5).e,
      endMs: wordAt(words, 5).e + 800,
      reason: "silence",
      confidence: 0.95,
    },
    {
      startMs: wordAt(words, 12).e,
      endMs: wordAt(words, 12).e + 800,
      reason: "silence",
      confidence: 0.95,
    },
  ];
  for (const item of items) {
    await prisma.edgPassItem.create({
      data: {
        id: ulid(),
        passId,
        edgId: edg.id,
        kind: "cut",
        startMs: item.startMs,
        endMs: item.endMs,
        payload: {},
        confidence: item.confidence,
        reason: item.reason,
        state: "proposed",
      },
    });
  }

  console.warn(
    `seed-sample: project ${project.id} ready (transcript ${transcriptId}, pass ${passId}).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
