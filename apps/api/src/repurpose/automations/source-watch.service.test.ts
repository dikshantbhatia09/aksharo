import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyTables, memoryPrisma } from "./automations-memory.test-support.js";
import {
  AUTOMATIONS_FLAG,
  AUTOMATION_ERRORS,
  MAX_WATCHES_PER_WORKSPACE,
  SOURCE_WATCH_TASK,
} from "./source-watch.constants.js";
import { createWatchSchema, updateWatchSchema, watchSetupSchema } from "./source-watch.dto.js";
import { SourceWatchService } from "./source-watch.service.js";
import { ChannelLookupError } from "./youtube-channels.js";
import { CHANNEL } from "./youtube-fixtures.test-support.js";
import { AppException } from "../../common/errors/error-codes.js";
import { createRunSchema } from "../repurpose.dto.js";

import type { Row, Tables } from "./automations-memory.test-support.js";
import type { CreateWatchInput } from "./source-watch.dto.js";
import type { ChannelDirectory, ResolvedChannel } from "./youtube-channels.js";

const WS = "01JWS00000000000000000000A";
const USER = "01JUSER0000000000000000000";
const OTHER = "01JUSER0000000000000000002";

const SETUP = watchSetupSchema.parse({
  sourceLanguage: "hi-Latn",
  caption: { styleId: "punch-pop" },
  discovery: { mode: "ai" },
});

function createInput(overrides: Partial<CreateWatchInput> = {}): CreateWatchInput {
  return createWatchSchema.parse({
    url: "https://www.youtube.com/@AksharoTestKitchen",
    setup: SETUP,
    backfill: 1,
    rightsAttested: true,
    ...overrides,
  });
}

async function refusal(
  run: Promise<unknown>,
): Promise<{ code: string; status: number; details: unknown }> {
  try {
    await run;
  } catch (error) {
    if (error instanceof AppException) {
      return { code: error.code, status: error.httpStatus, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

let tables: Tables;
let flags: Record<string, boolean>;
let resolve: ReturnType<typeof vi.fn>;
let audit: { record: ReturnType<typeof vi.fn> };
let scheduled: string[];
let service: SourceWatchService;

beforeEach(() => {
  tables = emptyTables();
  tables.membership.push({
    id: "m1",
    workspaceId: WS,
    userId: USER,
    role: "editor",
    status: "active",
  });
  flags = {
    [AUTOMATIONS_FLAG]: true,
    repurpose_flow: true,
    source_youtube_acquire: true,
  };
  resolve = vi.fn(async (): Promise<ResolvedChannel> => ({
    channelId: CHANNEL,
    title: "Aksharo Test Kitchen",
    handle: "AksharoTestKitchen",
  }));
  audit = { record: vi.fn(async () => undefined) };
  scheduled = [];
  const directory: ChannelDirectory = { resolve, uploads: vi.fn() };
  service = new SourceWatchService(
    memoryPrisma(tables) as never,
    {
      // eslint-disable-next-line security/detect-object-injection -- a flag name the service passes, read from this test's own table
      flagEnabled: vi.fn(async (_ws: string, flag: string) => flags[flag] === true),
    } as never,
    {
      list: vi.fn(async () => [{ id: "punch-pop" }, { id: "01JPRESET00000000000000000" }]),
    } as never,
    audit as never,
    {
      get scheduled() {
        return scheduled;
      },
    } as never,
    directory,
  );
});

describe("SourceWatchService: availability", () => {
  it("answers 404 unless all three flags are on - a missing flag row reads as off", async () => {
    for (const off of [AUTOMATIONS_FLAG, "repurpose_flow", "source_youtube_acquire"]) {
      flags = { [AUTOMATIONS_FLAG]: true, repurpose_flow: true, source_youtube_acquire: true };
      // eslint-disable-next-line security/detect-object-injection -- a literal flag name from the list above
      delete flags[off];
      expect(await refusal(service.list(WS)), off).toMatchObject({
        code: AUTOMATION_ERRORS.disabled,
        status: HttpStatus.NOT_FOUND,
      });
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("SourceWatchService: connecting a channel", () => {
  it("resolves a link for the preview, and says when the channel is already followed", async () => {
    await expect(
      service.resolve(WS, "https://www.youtube.com/@AksharoTestKitchen"),
    ).resolves.toEqual({
      channelId: CHANNEL,
      title: "Aksharo Test Kitchen",
      handle: "AksharoTestKitchen",
      channelUrl: `https://www.youtube.com/channel/${CHANNEL}`,
      watchId: null,
    });
    const watch = await service.create(WS, USER, createInput());
    expect((await service.resolve(WS, "https://youtube.com/@AksharoTestKitchen")).watchId).toBe(
      watch.id,
    );
  });

  it("refuses a link that is not a channel before asking YouTube anything", async () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://evil.test/@x",
      "javascript:alert(1)",
    ]) {
      expect(await refusal(service.resolve(WS, url)), url).toMatchObject({
        code: AUTOMATION_ERRORS.channelUrlInvalid,
        status: HttpStatus.BAD_REQUEST,
      });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("says what YouTube said, in the person's words", async () => {
    resolve.mockRejectedValueOnce(new ChannelLookupError("not_found", "404"));
    expect(await refusal(service.resolve(WS, "https://www.youtube.com/@Nobody"))).toMatchObject({
      code: AUTOMATION_ERRORS.channelNotFound,
      status: HttpStatus.UNPROCESSABLE_ENTITY,
    });
    resolve.mockRejectedValueOnce(new ChannelLookupError("busy", "gate"));
    expect(await refusal(service.resolve(WS, "https://www.youtube.com/@Nobody"))).toMatchObject({
      code: AUTOMATION_ERRORS.youtubeBusy,
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
    resolve.mockRejectedValueOnce(new ChannelLookupError("unreadable", "?"));
    expect(await refusal(service.resolve(WS, "https://www.youtube.com/@Nobody"))).toMatchObject({
      code: AUTOMATION_ERRORS.channelUnreadable,
      status: HttpStatus.BAD_GATEWAY,
    });
  });

  it("saves the setup as a start-form setup on Autopilot, attested by the person, due at once", async () => {
    const view = await service.create(WS, USER, createInput());
    const row = tables.sourceWatch[0] as Row;
    expect(row).toMatchObject({
      workspaceId: WS,
      channelId: CHANNEL,
      title: "Aksharo Test Kitchen",
      handle: "AksharoTestKitchen",
      backfillCount: 1,
      state: "active",
      createdBy: USER,
      rightsAttestedBy: USER,
    });
    expect(row["nextCheckAt"]).toEqual(row["rightsAttestedAt"]);
    // The stored setup is exactly what a run's request carries.
    expect(createRunSchema.shape.setup.parse(row["setup"])).toMatchObject({
      sourceLanguage: "hi-Latn",
      automation: "auto",
    });
    expect(view).toMatchObject({
      id: row["id"],
      state: "active",
      stateReason: null,
      message: null,
      runsStarted: 0,
      videos: [],
      channelUrl: `https://www.youtube.com/channel/${CHANNEL}`,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "repurpose.watch.created",
        actorId: USER,
        workspaceId: WS,
      }),
    );
  });

  it("follows a channel once per workspace", async () => {
    const first = await service.create(WS, USER, createInput());
    expect(await refusal(service.create(WS, USER, createInput()))).toMatchObject({
      code: AUTOMATION_ERRORS.watchExists,
      status: HttpStatus.CONFLICT,
      details: { watchId: first.id },
    });
  });

  it("caps a workspace's automations", async () => {
    for (let i = 0; i < MAX_WATCHES_PER_WORKSPACE; i += 1) {
      tables.sourceWatch.push({
        id: `w${String(i)}`,
        workspaceId: WS,
        channelId: `UC${String(i)}`,
      });
    }
    expect(await refusal(service.create(WS, USER, createInput()))).toMatchObject({
      code: AUTOMATION_ERRORS.watchLimit,
    });
  });

  it("checks the caption look against the workspace's catalogue", async () => {
    const input = createInput({
      setup: { ...SETUP, caption: { ...SETUP.caption, styleId: "gone" } },
    });
    expect(await refusal(service.create(WS, USER, input))).toMatchObject({
      code: "repurpose/style_unknown",
    });
    expect(tables.sourceWatch).toHaveLength(0);
  });
});

describe("the setup a watch accepts", () => {
  it("is the start form's own, and refuses a picked start, manual moments and manual automation", () => {
    expect(watchSetupSchema.safeParse(SETUP).success).toBe(true);
    for (const bad of [
      { ...SETUP, window: { startMs: 60_000 } },
      { ...SETUP, discovery: { ...SETUP.discovery, mode: "manual", requestedCandidates: 0 } },
      { ...SETUP, automation: "manual" },
      { ...SETUP, sourceLanguage: "" },
      { ...SETUP, caption: { styleId: "" } },
      // 2026-10-04: a cover is for an audio file; a channel's videos have pictures.
      { ...SETUP, audiogram: { coverAssetId: "01JC0VER000000000000000000" } },
    ]) {
      expect(watchSetupSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // A window POLICY is fine: which part of each long episode to take.
    expect(watchSetupSchema.safeParse({ ...SETUP, window: { policy: "first" } }).success).toBe(
      true,
    );
    // The start form's own schema is untouched by the watch's extra rules.
    expect(
      createRunSchema.shape.setup.safeParse({
        ...SETUP,
        discovery: { ...SETUP.discovery, mode: "manual", requestedCandidates: 0 },
      }).success,
    ).toBe(true);
    expect(
      createRunSchema.shape.setup.safeParse({
        ...SETUP,
        audiogram: { coverAssetId: "01JC0VER000000000000000000" },
      }).success,
    ).toBe(true);
  });

  it("needs the rights box ticked and a backfill of 0-3", () => {
    const base = { url: "https://www.youtube.com/@x_y", setup: SETUP };
    expect(createWatchSchema.safeParse({ ...base, rightsAttested: true }).data?.backfill).toBe(0);
    expect(createWatchSchema.safeParse({ ...base }).success).toBe(false);
    expect(createWatchSchema.safeParse({ ...base, rightsAttested: false }).success).toBe(false);
    expect(
      createWatchSchema.safeParse({ ...base, rightsAttested: true, backfill: 4 }).success,
    ).toBe(false);
    expect(updateWatchSchema.safeParse({ setup: SETUP }).success).toBe(true);
  });
});

describe("SourceWatchService: the list and one watch", () => {
  it("lists watches with their recent videos, runs started, and whether this server reads feeds", async () => {
    const watch = await service.create(WS, USER, createInput());
    tables.repurposeRun.push({ id: "01JRUN0000000000000000000A", status: "review_ready" });
    tables.sourceWatchVideo.push(
      {
        id: "v1",
        watchId: watch.id,
        videoId: "vid00000001",
        title: "Episode 1",
        publishedAt: new Date("2026-10-01T00:00:00Z"),
        state: "started",
        reason: null,
        backfill: true,
        runId: "01JRUN0000000000000000000A",
      },
      {
        id: "v2",
        watchId: watch.id,
        videoId: "vid00000002",
        title: "A Short",
        publishedAt: new Date("2026-10-02T00:00:00Z"),
        state: "skipped",
        reason: "short",
        backfill: false,
        runId: null,
      },
    );
    let list = await service.list(WS);
    expect(list.checksEnabled).toBe(false);
    expect(list.maxWatches).toBe(MAX_WATCHES_PER_WORKSPACE);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ runsStarted: 1 });
    expect(list.items[0]?.videos).toEqual([
      expect.objectContaining({
        videoId: "vid00000002",
        state: "skipped",
        reason: "short",
        runStatus: null,
      }),
      expect.objectContaining({
        videoId: "vid00000001",
        state: "started",
        runId: "01JRUN0000000000000000000A",
        runStatus: "review_ready",
        backfill: true,
      }),
    ]);

    scheduled = [SOURCE_WATCH_TASK];
    list = await service.list(WS);
    expect(list.checksEnabled).toBe(true);
  });

  it("reads one watch by workspace and id, never across workspaces", async () => {
    const watch = await service.create(WS, USER, createInput());
    await expect(service.get(WS, watch.id)).resolves.toMatchObject({ id: watch.id });
    expect(await refusal(service.get("01JOTHERWORKSPACE000000000", watch.id))).toMatchObject({
      code: AUTOMATION_ERRORS.notFound,
      status: HttpStatus.NOT_FOUND,
    });
  });
});

describe("SourceWatchService: changing a watch", () => {
  it("changes the setup its next runs start with", async () => {
    const watch = await service.create(WS, USER, createInput());
    const view = await service.update(WS, OTHER, watch.id, {
      setup: { ...SETUP, sourceLanguage: "en" },
    });
    expect(view.setup.sourceLanguage).toBe("en");
    expect(view.setup.automation).toBe("auto");
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "repurpose.watch.updated", actorId: OTHER }),
    );
  });

  it("pauses and resumes, and a resume reads it at the next tick", async () => {
    const watch = await service.create(WS, USER, createInput());
    const paused = await service.pause(WS, USER, watch.id);
    expect(paused).toMatchObject({ state: "paused", stateReason: "person", nextCheckAt: null });
    expect(paused.message).toMatch(/Paused/);
    // Pausing again changes nothing and audits nothing.
    const audits = audit.record.mock.calls.length;
    await service.pause(WS, USER, watch.id);
    expect(audit.record.mock.calls.length).toBe(audits);

    Object.assign(tables.sourceWatch[0] as Row, {
      checkFailures: 2,
      lastErrorCode: "channel_unreadable",
    });
    const resumed = await service.resume(WS, USER, watch.id);
    expect(resumed).toMatchObject({ state: "active", stateReason: null, lastErrorCode: null });
    expect(tables.sourceWatch[0]).toMatchObject({ checkFailures: 0 });
    expect(Date.parse(resumed.nextCheckAt ?? "")).toBeLessThanOrEqual(Date.now());
  });

  it("resumes a watch paused for credits with its person's words about why", async () => {
    const watch = await service.create(WS, USER, createInput());
    Object.assign(tables.sourceWatch[0] as Row, { state: "paused", stateReason: "no_credits" });
    const view = await service.get(WS, watch.id);
    expect(view.stateReason).toBe("no_credits");
    expect(view.message).toMatch(/credits/);
    await expect(service.resume(WS, OTHER, watch.id)).resolves.toMatchObject({ state: "active" });
  });

  it("will not resume as someone who has left: their attestation does not pass on", async () => {
    const watch = await service.create(WS, USER, createInput());
    Object.assign(tables.sourceWatch[0] as Row, { state: "paused", stateReason: "creator_left" });
    tables.membership = [];
    expect(await refusal(service.resume(WS, OTHER, watch.id))).toMatchObject({
      code: AUTOMATION_ERRORS.creatorGone,
      status: HttpStatus.CONFLICT,
    });
    expect(tables.sourceWatch[0]?.["state"]).toBe("paused");
  });

  it("removes a watch and its records, keeping the runs", async () => {
    const watch = await service.create(WS, USER, createInput());
    tables.repurposeRun.push({ id: "01JRUN0000000000000000000A", status: "review_ready" });
    tables.sourceWatchVideo.push({
      id: "v1",
      watchId: watch.id,
      videoId: "vid00000001",
      runId: "01JRUN0000000000000000000A",
    });
    await expect(service.remove(WS, USER, watch.id)).resolves.toEqual({ id: watch.id });
    expect(tables.sourceWatch).toHaveLength(0);
    expect(tables.sourceWatchVideo).toHaveLength(0);
    expect(tables.repurposeRun).toHaveLength(1);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "repurpose.watch.deleted" }),
    );
  });

  it("starts runs only as an active editor or above", async () => {
    tables.membership = [
      { workspaceId: WS, userId: "viewer", role: "viewer", status: "active" },
      { workspaceId: WS, userId: "invited", role: "editor", status: "invited" },
      { workspaceId: WS, userId: "admin", role: "admin", status: "active" },
    ];
    expect(await service.canStartAs(WS, "viewer")).toBe(false);
    expect(await service.canStartAs(WS, "invited")).toBe(false);
    expect(await service.canStartAs(WS, "admin")).toBe(true);
    expect(await service.canStartAs(WS, "nobody")).toBe(false);
  });
});
