import type { Env } from "@montaj/config";

import { ChannelDirectory } from "./channel-directory.js";
import { IDS, MemoryPrisma } from "./memory-prisma.test-support.js";
import { postizSetting } from "./postiz/postiz-env.js";
import { FAKE_API_URL, FAKE_KEY, FakePostiz } from "./postiz/postiz-fake.test-support.js";
import { PostizClient } from "./postiz/postiz.client.js";
import { PublishDispatcher } from "./publish-dispatcher.js";
import { PublishingAccess } from "./publishing-access.js";
import { PublishingService } from "./publishing.service.js";

import type { PublishQueue } from "./publish-queue.js";
import type { CommonAuditEvent, CommonAuditService } from "../common/audit/audit.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { EntitlementService } from "../workspaces/entitlement.service.js";

/**
 * The publishing module wired together over fakes: an in-memory database, a
 * pretend Postiz behind `fetch`, a store that streams a few bytes, and a queue
 * and audit that only record. Everything between those edges is the real code.
 */
export interface HarnessOptions {
  /** Rollout flags for the workspace. Default: posting and the run surface on, TikTok off. */
  readonly flags?: Record<string, boolean>;
  /** `POSTIZ_WORKSPACE_IDS`. Default: the test workspace. */
  readonly allowed?: readonly string[];
  /** Set to false for a deployment with no `POSTIZ_API_KEY`. */
  readonly configured?: boolean;
  readonly now?: number;
}

export interface Harness {
  readonly db: MemoryPrisma;
  readonly postiz: FakePostiz;
  readonly client: PostizClient;
  readonly access: PublishingAccess;
  readonly directory: ChannelDirectory;
  readonly dispatcher: PublishDispatcher;
  readonly service: PublishingService;
  readonly dispatched: { targetId: string; attemptNo: number; workspaceId: string }[];
  readonly reconciles: { targetId: string; checkNo: number; workspaceId: string }[];
  readonly audits: CommonAuditEvent[];
  readonly reads: string[];
  /** Move every clock in the harness. */
  setNow(at: number): void;
  now(): number;
}

export const VIDEO_BYTES = "\u0000\u0000\u0000\u0018ftypmp42 clip bytes";

export function publishingHarness(options: HarnessOptions = {}): Harness {
  let now = options.now ?? Date.parse("2026-10-01T06:00:00Z");
  const clock = (): number => now;

  const db = new MemoryPrisma();
  db.now = clock;
  const postiz = new FakePostiz();
  postiz.now = clock;
  const client = new PostizClient({
    setting: postizSetting(
      options.configured === false
        ? {}
        : { POSTIZ_API_KEY: FAKE_KEY, POSTIZ_API_URL: FAKE_API_URL },
    ),
    fetch: postiz.fetch as typeof fetch,
    now: clock,
    sleep: async () => undefined,
  });
  const flags = {
    publishing_postiz: true,
    repurpose_flow: true,
    publishing_tiktok: false,
    ...options.flags,
  };
  const entitlements = {
    forWorkspace: async () => ({ entitlements: { flags } }),
  } as unknown as EntitlementService;
  const env = { FEATURE_FLAGS_JSON: {} } as unknown as Env;
  const access = new PublishingAccess(entitlements, client, env);
  access.environment = { POSTIZ_WORKSPACE_IDS: (options.allowed ?? [IDS.ws]).join(",") };

  const prisma = db as unknown as PrismaService;
  const directory = new ChannelDirectory(prisma, client);
  directory.now = clock;

  const reads: string[] = [];
  const store = {
    openRead: async (key: string) => {
      reads.push(key);
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(VIDEO_BYTES));
            controller.close();
          },
        }),
        sizeBytes: VIDEO_BYTES.length,
      };
    },
  } as unknown as ObjectStore;

  const dispatcher = new PublishDispatcher(prisma, client, directory, access, store);
  dispatcher.now = clock;
  dispatcher.random = () => 0.5;

  const dispatched: Harness["dispatched"] = [];
  const reconciles: Harness["reconciles"] = [];
  const queue = {
    dispatch: async (input: Harness["dispatched"][number]) => {
      dispatched.push(input);
      return true;
    },
    reconcile: async (input: Harness["reconciles"][number]) => {
      reconciles.push(input);
      return true;
    },
  } as unknown as PublishQueue;
  const audits: CommonAuditEvent[] = [];
  const audit = {
    record: async (event: CommonAuditEvent) => {
      audits.push(event);
    },
  } as unknown as CommonAuditService;

  const service = new PublishingService(
    prisma,
    access,
    directory,
    client,
    queue,
    dispatcher,
    audit,
  );
  service.now = clock;

  return {
    db,
    postiz,
    client,
    access,
    directory,
    dispatcher,
    service,
    dispatched,
    reconciles,
    audits,
    reads,
    setNow(at: number) {
      now = at;
    },
    now: clock,
  };
}

/** Postiz channels of every kind Aksharo posts to, plus one it does not. */
export function connectEverything(postiz: FakePostiz): void {
  postiz.integrations = [
    {
      id: "int-ig",
      name: "Crest Mond",
      identifier: "instagram-standalone",
      profile: "crestmond",
      picture: "https://cdn.example.com/ig.jpg",
    },
    { id: "int-fb", name: "Crest Mond Page", identifier: "facebook" },
    { id: "int-yt", name: "Crest Mond TV", identifier: "youtube" },
    { id: "int-li", name: "Crest Mond", identifier: "linkedin-page" },
    {
      id: "int-x",
      name: "crestmond",
      identifier: "x",
      picture: "http://localhost:4007/uploads/x.png",
    },
    { id: "int-tt", name: "crestmond", identifier: "tiktok" },
    { id: "int-th", name: "crestmond", identifier: "threads" },
    { id: "int-pin", name: "Boards", identifier: "pinterest" },
  ];
}

/** Our channel id for a Postiz integration, once the list has been read. */
export function channelIdOf(harness: Harness, integrationId: string): string {
  const row = harness.db.tables.channelConnection.find(
    (entry) => entry["externalIntegrationId"] === integrationId,
  );
  if (row === undefined) throw new Error(`no channel for ${integrationId}`);
  return String(row["id"]);
}
