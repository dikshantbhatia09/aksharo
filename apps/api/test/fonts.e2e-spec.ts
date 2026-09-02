/**
 * The whole custom-font path, against real infrastructure.
 *
 * `fonts/init` → **a genuine PUT of a real font to MinIO through the presigned
 * URL** → `complete` with the licence attestation → the sanitised original and
 * the subset WOFF2 in the bucket → the workspace manifest with signed URLs →
 * **downloading those URLs and shaping the bytes that come back**.
 *
 * The upload and the download are not faked, and that is the point. A presigned
 * URL is a signature over a canonical request, and every way of getting one
 * wrong produces a URL that looks fine in a unit test and fails in a browser.
 * Neither is the font: it is a real OFL face out of the bundled pack, so the
 * validator, the subsetter and HarfBuzz all see what they would see in
 * production.
 *
 * It needs Postgres, Redis and an S3-compatible store; without any of them it
 * skips loudly rather than failing.
 */
import { createSign, generateKeyPairSync } from "node:crypto";

import { validateFont } from "@montaj/fonts/node";
import { fakeTtfBytes, packFontBytes, withNoEmbedding } from "@montaj/fonts/testing";
import { type PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { createTestDatabase, isDatabaseAvailable, skipReason } from "./db-harness.js";
import { isStorageAvailable, storageSkipReason } from "./minio-harness.js";
import { isRedisAvailable, redisSkipReason, testRedisUrl } from "./redis-harness.js";
import { PrismaService } from "../src/common/prisma/prisma.service.js";
import { RedisService } from "../src/common/redis/redis.service.js";
import { DERIVED_STORE, RAW_STORE, S3ObjectStore } from "../src/common/storage/index.js";
import { ENV } from "../src/config/config.module.js";
import { FONT_ATTESTATION } from "../src/fonts/fonts.constants.js";
import { EntitlementService } from "../src/workspaces/entitlement.service.js";

import type { TestDatabase } from "./db-harness.js";
import type { ObjectStore } from "../src/common/storage/index.js";
import type { INestApplication } from "@nestjs/common";

const DB_READY = isDatabaseAvailable();
const REDIS_READY = isRedisAvailable();
const STORAGE_READY = isStorageAvailable();
const CAN_RUN = DB_READY && REDIS_READY && STORAGE_READY;

if (!CAN_RUN) {
  console.warn(
    `[fonts.e2e] skipped — ${DB_READY ? "" : `database: ${skipReason}. `}` +
      `${REDIS_READY ? "" : `redis: ${redisSkipReason}. `}` +
      `${STORAGE_READY ? "" : `storage: ${storageSkipReason}.`}`,
  );
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function crockford(value: number, length: number): string {
  let out = "";
  let remaining = value;
  while (remaining > 0) {
    out = `${CROCKFORD[remaining % 32] ?? "0"}${out}`;
    remaining = Math.floor(remaining / 32);
  }
  return out.padStart(length, "0").slice(-length);
}
const RUN = crockford(Date.now(), 10);
const id = (kind: string): string => `01JC${kind}${RUN}`.padEnd(26, "0").slice(0, 26);

const USER = id("US3R");
const WORKSPACE = id("WKSP");
const OTHER_WORKSPACE = id("WKSX");

let db: TestDatabase | null = null;
let prisma: PrismaClient;
let app: INestApplication;
let derivedStore: ObjectStore;
const keysWritten: string[] = [];

function accessToken(workspaceId = WORKSPACE, role = "owner"): string {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: USER,
    ws: workspaceId,
    role,
    kind: "web",
    jti: id("JT1"),
    iat: now,
    exp: now + 900,
    iss: process.env["API_ORIGIN"] ?? "http://localhost:3001",
  };
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signed = `${b64(header)}.${b64(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(privateKey).toString("base64url")}`;
}

function api(token = accessToken()) {
  const agent = request(app.getHttpServer());
  return {
    get: (path: string) => agent.get(path).set("Authorization", `Bearer ${token}`),
    post: (path: string) => agent.post(path).set("Authorization", `Bearer ${token}`),
    delete: (path: string) => agent.delete(path).set("Authorization", `Bearer ${token}`),
  };
}

interface Ticket {
  fontId: string;
  url: string;
  key: string;
  attestation: { version: string; text: string };
  quota: { used: number; limit: number; planKey: string };
}

/** Take a font through init → PUT → (optionally) complete. */
async function upload(
  bytes: Uint8Array,
  options: { filename?: string; scripts?: string[] } = {},
): Promise<Ticket> {
  const response = await api()
    .post(`/workspaces/${WORKSPACE}/fonts/init`)
    .send({
      filename: options.filename ?? "Sample.ttf",
      sizeBytes: bytes.byteLength,
      ...(options.scripts === undefined ? {} : { scripts: options.scripts }),
    })
    .expect(201);
  const ticket = response.body as Ticket;
  keysWritten.push(ticket.key, ticket.key.replace(/\.(ttf|otf)$/, ".woff2"));

  const put = await fetch(ticket.url, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "font/ttf" },
  });
  expect(put.ok, `the presigned PUT failed: ${String(put.status)}`).toBe(true);
  return ticket;
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: USER, email: `a18b+${RUN}@example.test`, name: "A18b test" },
  });
  for (const [workspaceId, slug, membershipId] of [
    [WORKSPACE, `a18b-${RUN}`, id("MBR1")],
    [OTHER_WORKSPACE, `a18b-other-${RUN}`, id("MBR2")],
  ] as const) {
    await prisma.workspace.create({
      data: { id: workspaceId, slug, name: slug, ownerId: USER, billingCountry: "IN" },
    });
    await prisma.membership.create({
      data: { id: membershipId, workspaceId, userId: USER, role: "owner", status: "active" },
    });
  }
  // The entitlement stub reads the FREE plan for every workspace, and Free has
  // no custom fonts at all — so this suite seeds Free with an allowance, which
  // is exactly what B02 will return for a paid plan. `plan_limit_reached` gets
  // its own test by driving the allowance down.
  await prisma.plan.upsert({
    where: { key: "free" },
    update: {},
    create: {
      id: id("PLNF"),
      key: "free",
      name: "Free",
      creditsPerMonthTenths: 300,
      entitlements: { customFonts: 5, maxFileBytes: 500 * 1024 * 1024, retentionDays: 7 },
    },
  });
  await prisma.plan.update({
    where: { key: "free" },
    data: { entitlements: { customFonts: 5, maxFileBytes: 500 * 1024 * 1024, retentionDays: 7 } },
  });
}

async function cleanup(): Promise<void> {
  if (prisma === undefined) return;
  await prisma.font.deleteMany({ where: { workspaceId: { in: [WORKSPACE, OTHER_WORKSPACE] } } });
  await prisma.membership.deleteMany({ where: { userId: USER } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WORKSPACE, OTHER_WORKSPACE] } } });
  await prisma.user.deleteMany({ where: { id: USER } });
  if (keysWritten.length > 0) await derivedStore.deleteMany(keysWritten).catch(() => 0);
}

beforeAll(async () => {
  if (!CAN_RUN) return;

  db = await createTestDatabase();
  if (db === null) throw new Error(`could not start a test database: ${skipReason}`);
  prisma = db.prisma;
  await cleanup();
  await seed();

  process.env["DATABASE_URL"] = db.url;
  process.env["REDIS_URL"] = testRedisUrl();
  process.env["JWT_PUBLIC_KEY"] = PEM_PUBLIC;
  process.env["JWT_PRIVATE_KEY"] = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const { Test } = await import("@nestjs/testing");
  const { AppModule } = await import("../src/app.module.js");
  const { HttpExceptionFilter } = await import("../src/common/errors/http-exception.filter.js");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();

  const env = app.get<Env>(ENV);
  derivedStore = new S3ObjectStore({
    kind: "r2",
    bucket: env.R2_BUCKET_DERIVED,
    endpoint: env.R2_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.R2_ACCESS_KEY,
    secretAccessKey: env.R2_SECRET_KEY,
  });
  // Prove the two stores the app resolved are the ones the suite talks to.
  expect(app.get<ObjectStore>(DERIVED_STORE).bucket).toBe(derivedStore.bucket);
  expect(app.get<ObjectStore>(RAW_STORE).kind).toBe("s3");
  expect(app.get(PrismaService)).toBeDefined();
  expect(app.get(RedisService)).toBeDefined();
}, 180_000);

afterAll(async () => {
  if (!CAN_RUN) return;
  await app?.close();
  await cleanup();
  await db?.stop();
}, 120_000);

describe.skipIf(!CAN_RUN)("the bundled catalogue", () => {
  it("serves a manifest a renderer can load", async () => {
    const response = await api().get("/fonts/manifest").expect(200);
    const body = response.body as {
      v: number;
      origin: string;
      fonts: { id: string; file: string; url: string; woff2Url?: string; sha256: string }[];
    };
    expect(body.v).toBe(1);
    expect(body.origin).toBe("bundled");
    expect(body.fonts.length).toBeGreaterThan(20);
    expect(body.fonts[0]?.url).toMatch(/^\/fonts\/pack\//);
  });

  it("serves the bytes without a token, immutably cached", async () => {
    const manifest = (await api().get("/fonts/manifest").expect(200)).body as {
      fonts: { woff2Url?: string }[];
    };
    const url = manifest.fonts[0]?.woff2Url ?? "";
    const response = await request(app.getHttpServer()).get(url).expect(200);
    expect(response.headers["content-type"]).toBe("font/woff2");
    expect(response.headers["cache-control"]).toContain("immutable");
    expect(response.body.subarray(0, 4).toString("ascii")).toBe("wOF2");
  });

  it("refuses to serve anything the manifest does not name", async () => {
    await request(app.getHttpServer()).get("/fonts/pack/fonts.json").expect(404);
  });

  it("offers the picker every script the 22 languages need", async () => {
    const body = (await api().get("/styles/fonts/catalog").expect(200)).body as {
      families: { scripts: string[] }[];
      languages: { script: string }[];
    };
    const offered = new Set(body.families.flatMap((family) => family.scripts));
    for (const language of body.languages) expect(offered.has(language.script)).toBe(true);
  });

  it("needs a session for the product surface", async () => {
    await request(app.getHttpServer()).get("/fonts/manifest").expect(401);
    await request(app.getHttpServer()).get("/styles/fonts/catalog").expect(401);
  });
});

describe.skipIf(!CAN_RUN)("upload, attestation, manifest, download", () => {
  it("takes a real font from init to a signed, shapeable download", async () => {
    const bytes = packFontBytes("noto-sans-devanagari-400");
    const ticket = await upload(bytes, { filename: "Devanagari.ttf", scripts: ["Deva"] });
    expect(ticket.attestation.version).toBe(FONT_ATTESTATION.version);
    expect(ticket.quota.limit).toBe(5);

    // Without the warranty, nothing is processed.
    const refused = await api()
      .post(`/fonts/${ticket.fontId}/complete`)
      .send({ licenceAttested: false })
      .expect(422);
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      "fonts/attestation_required",
    );

    const completed = await api()
      .post(`/fonts/${ticket.fontId}/complete`)
      .send({ licenceAttested: true, licenceNote: "Bought from the foundry" })
      .expect(201);
    const font = completed.body as {
      id: string;
      family: string;
      status: string;
      sanitised: boolean;
      scripts: string[];
      licenceAttestedBy: string;
      attestedAt: string;
      attestationVersion: string;
      licenceNote: string;
    };
    expect(font.status).toBe("ready");
    expect(font.sanitised).toBe(true);
    expect(font.family).toBe("Noto Sans Devanagari");
    expect(font.scripts).toEqual(["Deva"]);
    expect(font.licenceAttestedBy).toBe(USER);
    expect(Date.parse(font.attestedAt)).toBeLessThanOrEqual(Date.now());
    expect(font.attestationVersion).toBe(FONT_ATTESTATION.version);
    expect(font.licenceNote).toBe("Bought from the foundry");

    // The warranty is on the row, which is what D67 asks for.
    const row = await prisma.font.findUniqueOrThrow({ where: { id: ticket.fontId } });
    expect(row.licenceAttestedBy).toBe(USER);
    expect(row.attestedAt).not.toBeNull();
    expect(row.servedOnlyToWorkspace).toBe(true);
    expect(row.subsetKey).toBe(`ws/${WORKSPACE}/fonts/${ticket.fontId}.woff2`);

    // The manifest carries signed URLs for both objects.
    const manifest = (await api().get(`/workspaces/${WORKSPACE}/fonts/manifest`).expect(200))
      .body as {
      v: number;
      origin: string;
      fonts: { id: string; url: string; woff2Url: string; scripts: string[] }[];
    };
    expect(manifest.origin).toBe("workspace");
    const face = manifest.fonts.find((entry) => entry.id === ticket.fontId);
    expect(face?.scripts).toEqual(["devanagari"]);

    // Download the signed URLs and shape what comes back: this is the only
    // assertion that proves the bytes in the bucket are a usable font.
    const sfnt = new Uint8Array(await (await fetch(face?.url ?? "")).arrayBuffer());
    const woff2 = new Uint8Array(await (await fetch(face?.woff2Url ?? "")).arrayBuffer());
    expect(String.fromCharCode(...woff2.subarray(0, 4))).toBe("wOF2");

    // The bytes that came back are a real, sanitised, Devanagari-covering face:
    // the same validator the pipeline used, run on what a renderer would fetch.
    const downloaded = validateFont(sfnt);
    expect(downloaded.family).toBe("Noto Sans Devanagari");
    expect(downloaded.scripts).toContain("Deva");
    expect(downloaded.variable).toBe(false);
    expect(validateFont(woff2).scripts).toContain("Deva");
  }, 120_000);

  it("signs one font's URLs on demand, and never another workspace's", async () => {
    const list = (await api().get(`/workspaces/${WORKSPACE}/fonts`).expect(200)).body as {
      id: string;
    }[];
    const fontId = list[0]?.id ?? "";
    const urls = (await api().get(`/workspaces/${WORKSPACE}/fonts/${fontId}/url`).expect(200))
      .body as { url: string; woff2Url: string };
    expect((await fetch(urls.url)).ok).toBe(true);

    // The same font id, asked for with a token for the other workspace: 404,
    // because the lookup joins through `workspace_id` (THREAT-MODEL T5).
    await api(accessToken(OTHER_WORKSPACE))
      .get(`/workspaces/${OTHER_WORKSPACE}/fonts/${fontId}/url`)
      .expect(404);
    // And the guard refuses a path that names a workspace the token does not.
    await api().get(`/workspaces/${OTHER_WORKSPACE}/fonts`).expect(403);
  });

  it("refuses a fake TTF and leaves nothing behind", async () => {
    const ticket = await upload(fakeTtfBytes(), { filename: "Fake.ttf" });
    const response = await api()
      .post(`/fonts/${ticket.fontId}/complete`)
      .send({ licenceAttested: true })
      .expect(422);
    expect((response.body as { error: { code: string } }).error.code).toBe("fonts/unparsable");
    expect(await prisma.font.findUnique({ where: { id: ticket.fontId } })).toBeNull();
    expect(await derivedStore.head(ticket.key)).toBeNull();
  }, 60_000);

  it("refuses a font whose fsType forbids embedding", async () => {
    const ticket = await upload(withNoEmbedding(packFontBytes("noto-sans-400")), {
      filename: "Restricted.ttf",
    });
    const response = await api()
      .post(`/fonts/${ticket.fontId}/complete`)
      .send({ licenceAttested: true })
      .expect(422);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "fonts/embedding_restricted",
    );
  }, 60_000);

  it("refuses a script the font does not cover", async () => {
    const ticket = await upload(packFontBytes("noto-sans-400"), {
      filename: "Latin.ttf",
      scripts: ["Taml"],
    });
    const response = await api()
      .post(`/fonts/${ticket.fontId}/complete`)
      .send({ licenceAttested: true })
      .expect(422);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "fonts/script_not_covered",
    );
  }, 60_000);

  it("refuses a declared size past the cap", async () => {
    const response = await api()
      .post(`/workspaces/${WORKSPACE}/fonts/init`)
      .send({ filename: "Huge.ttf", sizeBytes: 64 * 1024 * 1024 })
      .expect(400);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "common/validation_failed",
    );
  });

  it("refuses to complete a font whose bytes were never uploaded", async () => {
    const ticket = (
      await api()
        .post(`/workspaces/${WORKSPACE}/fonts/init`)
        .send({ filename: "Ghost.ttf", sizeBytes: 1_024 })
        .expect(201)
    ).body as Ticket;
    keysWritten.push(ticket.key);
    const response = await api()
      .post(`/fonts/${ticket.fontId}/complete`)
      .send({ licenceAttested: true })
      .expect(409);
    expect((response.body as { error: { code: string } }).error.code).toBe("fonts/upload_missing");
    await api().delete(`/workspaces/${WORKSPACE}/fonts/${ticket.fontId}`).expect(200);
  });

  it("enforces the plan's custom-font allowance", async () => {
    await prisma.plan.update({
      where: { key: "free" },
      data: { entitlements: { customFonts: 0, maxFileBytes: 500 * 1024 * 1024, retentionDays: 7 } },
    });
    // The entitlement is cached for 60 s, so the suite clears it the way the
    // service does rather than waiting out the TTL.
    await app.get(EntitlementService).invalidate(WORKSPACE);
    const response = await api()
      .post(`/workspaces/${WORKSPACE}/fonts/init`)
      .send({ filename: "Nope.ttf", sizeBytes: 1_024 })
      .expect(403);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "fonts/plan_limit_reached",
    );
  });

  it("deletes a font and both of its objects", async () => {
    await prisma.plan.update({
      where: { key: "free" },
      data: { entitlements: { customFonts: 5, maxFileBytes: 500 * 1024 * 1024, retentionDays: 7 } },
    });
    await app.get(EntitlementService).invalidate(WORKSPACE);

    const ticket = await upload(packFontBytes("noto-sans-tamil-400"), { filename: "Tamil.ttf" });
    await api()
      .post(`/fonts/${ticket.fontId}/complete`)
      .send({ licenceAttested: true })
      .expect(201);
    const woff2Key = `ws/${WORKSPACE}/fonts/${ticket.fontId}.woff2`;
    expect(await derivedStore.head(woff2Key)).not.toBeNull();

    await api().delete(`/workspaces/${WORKSPACE}/fonts/${ticket.fontId}`).expect(200);
    expect(await prisma.font.findUnique({ where: { id: ticket.fontId } })).toBeNull();
    expect(await derivedStore.head(ticket.key)).toBeNull();
    expect(await derivedStore.head(woff2Key)).toBeNull();
  }, 120_000);
});
