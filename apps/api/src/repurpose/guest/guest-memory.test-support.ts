/* eslint-disable security/detect-object-injection -- a test fake indexing its own rows by field name */
import type { Env } from "@montaj/config";

import { GuestLinksService } from "./guest-links.service.js";
import { GuestPageService } from "./guest-page.service.js";
import { ClipApprovalGate } from "../review/clip-approval.gate.js";
import { ClipReviewService } from "../review/clip-review.service.js";
import {
  IDS,
  ReviewMemory,
  recorders,
  renderClip,
  seedClip,
  seedWorkspace,
  type Recorders,
  type Row,
  type Shape,
} from "../review/review-memory.test-support.js";
import { ReviewNotifier } from "../review/review-notifier.js";

import type { RateLimitService } from "../../common/guards/index.js";
import type { ObjectStore } from "../../common/storage/index.js";
import type { NotifyService } from "../../notify/notify.service.js";
import type { EntitlementService } from "../../workspaces/entitlement.service.js";

/**
 * Guest pages (2026-10-05) wired over the review module's in-memory database
 * (`review-memory.test-support.ts`), with the review module's own services
 * underneath, as `RepurposeGuestModule` wires them. Not a test file; only ever
 * imported by the guest tests.
 */

export { IDS, renderClip, seedClip, type Row, type Shape };

const ASPECT: Readonly<Record<Shape, string>> = {
  "9:16": "r9x16",
  "4:5": "r4x5",
  "1:1": "r1x1",
  "16:9": "r16x9",
};

export interface GuestHarness extends Recorders {
  readonly db: ReviewMemory;
  readonly reviews: ClipReviewService;
  readonly links: GuestLinksService;
  readonly pages: GuestPageService;
  /** Every presign asked for: key, lifetime and download name. */
  readonly signed: { key: string; ttl: number; filename: string | undefined }[];
  /** Tokens left in the per-link download bucket; set to 0 to see a refusal. */
  linkBucket: number;
  setNow(at: number): void;
}

export function guestHarness(
  options: {
    readonly flags?: Record<string, boolean>;
    readonly publicShares?: boolean;
    readonly settings?: Row;
    readonly now?: number;
  } = {},
): GuestHarness {
  let now = options.now ?? Date.parse("2026-10-05T06:00:00Z");
  const db = new ReviewMemory();
  db.now = () => now;
  seedWorkspace(db, options.settings === undefined ? {} : { settings: options.settings });
  const rec = recorders(db);
  const flags = { repurpose_flow: true, ...options.flags };
  const entitlements = {
    forWorkspace: async () => ({ entitlements: { flags } }),
  } as unknown as EntitlementService;
  const env = {
    FEATURE_FLAGS_JSON: { "shares.public": options.publicShares ?? true },
    WEB_ORIGIN: "https://aksharo.test",
  } as unknown as Env;
  const signed: GuestHarness["signed"] = [];
  const derived = {
    presignGet: async (key: string, ttl: number, opts?: { downloadFilename?: string }) => {
      signed.push({ key, ttl, filename: opts?.downloadFilename });
      const download =
        opts?.downloadFilename === undefined
          ? ""
          : `&response-content-disposition=${encodeURIComponent(opts.downloadFilename)}`;
      return `https://media.test/${key}?X-Amz-Expires=${String(ttl)}${download}`;
    },
  } as unknown as ObjectStore;
  const notifier = new ReviewNotifier(db.prisma, rec.notify as unknown as NotifyService, env);
  const gate = new ClipApprovalGate(db.prisma);
  const reviews = new ClipReviewService(
    db.prisma,
    rec.audit,
    notifier,
    gate,
    entitlements,
    env,
    derived,
  );
  reviews.now = () => now;
  const links = new GuestLinksService(db.prisma, rec.audit, reviews, env);
  links.now = () => now;
  const harness: GuestHarness = {
    ...rec,
    db,
    reviews,
    links,
    pages: undefined as unknown as GuestPageService,
    signed,
    linkBucket: 1_000,
    setNow(at: number) {
      now = at;
    },
  };
  const limiter = {
    consume: async () => {
      harness.linkBucket -= 1;
      return harness.linkBucket >= 0
        ? { allowed: true, remaining: harness.linkBucket, retryAfterSec: 0 }
        : { allowed: false, remaining: 0, retryAfterSec: 60 };
    },
  } as unknown as RateLimitService;
  const pages = new GuestPageService(db.prisma, reviews, gate, rec.audit, limiter, derived);
  pages.now = () => now;
  (harness as { pages: GuestPageService }).pages = pages;
  return harness;
}

/** The variant project of one shape of a clip, made if it is not there yet. */
export function variantProject(db: ReviewMemory, clipId: string, shape: Shape): string {
  const code = ASPECT[shape];
  const variantId = `VAR-${clipId}-${code}`;
  const projectId = `PRJ-${clipId}-${code}`;
  if (!db.tables.clipVariant.some((row) => row["id"] === variantId)) {
    db.tables.clipVariant.push({
      id: variantId,
      clipId,
      projectId,
      aspect: code,
      latestExportId: null,
    });
  }
  return projectId;
}

/** A shape's clean cut: its project's primary media, stored. */
export function cleanCut(
  db: ReviewMemory,
  clipId: string,
  shape: Shape,
  options: { readonly status?: string; readonly workspaceId?: string } = {},
): string {
  const projectId = variantProject(db, clipId, shape);
  const key = `ws/${options.workspaceId ?? IDS.ws}/p/${projectId}/media/M-${projectId}/master.mp4`;
  db.tables.mediaAsset.push({
    id: `M-${projectId}`,
    projectId,
    role: "primary",
    status: options.status ?? "ready",
    storageKey: key,
    derivedPurgedAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 1)),
  });
  return key;
}

/** The clip's stored image set, taken from the given exports. */
export function storeImages(
  db: ReviewMemory,
  clipId: string,
  fingerprint: string,
  names: readonly string[] = ["vertical-image-1", "carousel-1", "carousel-2", "thumbnail-1"],
): void {
  const clip = db.tables.repurposeClip.find((row) => row["id"] === clipId);
  if (clip === undefined) throw new Error(`no clip ${clipId}`);
  clip["images"] = {
    fingerprint,
    images: names.map((name) => ({
      name,
      key: `ws/${IDS.ws}/p/${IDS.source}/clips/${clipId}/images/${name}.jpg`,
      width: 1080,
      height: 1920,
    })),
  };
}

let dubs = 0;

/** A dub of a clip into `languages`, each with its shapes' captioned videos and clean pictures. */
export function seedDub(
  db: ReviewMemory,
  clipId: string,
  options: {
    readonly languages?: readonly string[];
    readonly shapes?: readonly Shape[];
    readonly status?: string;
    readonly runId?: string;
    readonly captioned?: boolean;
  } = {},
): string {
  dubs += 1;
  const dubId = `DUB${String(dubs).padStart(4, "0")}`;
  const languages = options.languages ?? ["hi-IN"];
  db.tables.clipDub.push({
    id: dubId,
    runId: options.runId ?? IDS.run,
    clipId,
    workspaceId: IDS.ws,
    languages: [...languages],
    status: options.status ?? "ready",
    createdAt: new Date(Date.UTC(2026, 9, 2, 0, dubs)),
  });
  for (const language of languages) {
    for (const shape of options.shapes ?? ["9:16"]) {
      const code = ASPECT[shape];
      const projectId = `DPRJ-${dubId}-${language}-${code}`;
      db.tables.clipDubVariant.push({
        id: `DVAR-${dubId}-${language}-${code}`,
        dubId,
        language,
        aspect: code,
        projectId,
        latestExportId: null,
      });
      db.tables.mediaAsset.push({
        id: `DM-${projectId}`,
        projectId,
        role: "primary",
        status: "ready",
        storageKey: `ws/${IDS.ws}/p/${projectId}/media/DM/dubbed.mp4`,
        derivedPurgedAt: null,
        createdAt: new Date(Date.UTC(2026, 9, 2)),
      });
      if (options.captioned !== false) {
        db.tables.export.push({
          id: `DEXP-${projectId}`,
          workspaceId: IDS.ws,
          projectId,
          status: "succeeded",
          kind: "mp4",
          storageKey: `ws/${IDS.ws}/p/${projectId}/exports/DEXP.mp4`,
          durationMs: 30_000,
          createdAt: new Date(Date.UTC(2026, 9, 2, 1)),
        });
      }
    }
  }
  return dubId;
}

/** The run's episode text, as the worker stores it on the source project. */
export function storeEpisodePack(db: ReviewMemory, output: Row): void {
  db.tables.llmOutput.push({
    id: `LLM${String(db.tables.llmOutput.length + 1)}`,
    projectId: IDS.source,
    workspaceId: IDS.ws,
    kind: "episode-pack",
    output,
    createdAt: new Date(Date.UTC(2026, 9, 3)),
  });
}

/** The token a created link's address carries. */
export function tokenOf(url: string): string {
  return url.split("/").at(-1) ?? "";
}
