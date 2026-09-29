import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BulkRunsService } from "./bulk-runs.service.js";
import { AUTOMATION_ERRORS, BULK_MAX_LINKS } from "./source-watch.constants.js";
import { bulkRunsSchema } from "./source-watch.dto.js";
import { AppException } from "../../common/errors/error-codes.js";
import { REPURPOSE_ERRORS, REPURPOSE_RATE_LIMITS } from "../repurpose.constants.js";

import type { BulkRunsInput } from "./source-watch.dto.js";

const WS = "01JWS00000000000000000000A";
const USER = "01JUSER0000000000000000000";

const SETUP = {
  sourceLanguage: "auto",
  caption: { styleId: "punch-pop" },
  discovery: { mode: "ai" },
  automation: "auto",
};

function body(links: string[]): BulkRunsInput {
  return bulkRunsSchema.parse({ links, setup: SETUP, rightsAttested: true });
}

const url = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

let create: ReturnType<typeof vi.fn>;
let consume: ReturnType<typeof vi.fn>;
let available: ReturnType<typeof vi.fn>;
let audit: { record: ReturnType<typeof vi.fn> };
let service: BulkRunsService;

beforeEach(() => {
  let n = 0;
  create = vi.fn(async () => {
    n += 1;
    return { run: { id: `01JRUN${String(n).padStart(20, "0")}` } };
  });
  consume = vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterSec: 0 }));
  available = vi.fn(async () => undefined);
  audit = { record: vi.fn(async () => undefined) };
  service = new BulkRunsService(
    { create } as never,
    { assertAvailable: available } as never,
    { consume } as never,
    audit as never,
  );
});

describe("BulkRunsService", () => {
  it("starts one run per link with the same setup, line by line", async () => {
    const result = await service.startMany(
      WS,
      USER,
      body([url("aaaaaaaaaaa"), "https://youtu.be/bbbbbbbbbbb?si=x"]),
    );
    expect(result.started).toBe(2);
    expect(result.results).toEqual([
      expect.objectContaining({
        index: 0,
        outcome: "started",
        runId: "01JRUN00000000000000000001",
      }),
      expect.objectContaining({
        index: 1,
        outcome: "started",
        runId: "01JRUN00000000000000000002",
      }),
    ]);
    expect(create).toHaveBeenNthCalledWith(1, WS, USER, {
      source: { kind: "url", url: url("aaaaaaaaaaa"), rightsAttested: true },
      setup: expect.objectContaining({ sourceLanguage: "auto", automation: "auto" }),
    });
    // The canonical link is what is fetched, never the pasted one.
    expect(
      (create.mock.calls[1] as [string, string, { source: { url: string } }])[2].source.url,
    ).toBe(url("bbbbbbbbbbb"));
    // One `repurpose:create:user` token per run, the same bucket a single start spends.
    expect(consume).toHaveBeenCalledTimes(2);
    expect(consume).toHaveBeenCalledWith(REPURPOSE_RATE_LIMITS.create, USER);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.runs.bulk_started", actorId: USER }),
    );
  });

  it("refuses bad lines on their own, and starts the good ones around them", async () => {
    const result = await service.startMany(
      WS,
      USER,
      body([
        "not a link",
        "https://example.com/video.mp4",
        url("aaaaaaaaaaa"),
        "https://www.youtube.com/@AksharoTestKitchen",
        "https://www.youtube.com/playlist?list=PL1",
        "",
      ]),
    );
    expect(result.results.map((line) => [line.outcome, line.code])).toEqual([
      ["refused", REPURPOSE_ERRORS.sourceInvalidUrl],
      ["refused", REPURPOSE_ERRORS.sourceUnsupported],
      ["started", null],
      ["refused", REPURPOSE_ERRORS.sourceInvalidUrl],
      ["refused", REPURPOSE_ERRORS.sourceInvalidUrl],
      ["refused", REPURPOSE_ERRORS.sourceInvalidUrl],
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    for (const line of result.results.filter((entry) => entry.outcome === "refused")) {
      expect(line.message?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("starts a video once, however it was pasted", async () => {
    const result = await service.startMany(
      WS,
      USER,
      body([
        url("aaaaaaaaaaa"),
        "https://youtu.be/aaaaaaaaaaa",
        "https://m.youtube.com/shorts/aaaaaaaaaaa",
      ]),
    );
    expect(result.results.map((line) => line.outcome)).toEqual([
      "started",
      "duplicate",
      "duplicate",
    ]);
    expect(result.results[1]?.message).toBe("The same video as line 1.");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("points at the run a video already has", async () => {
    create.mockRejectedValueOnce(
      new AppException(
        REPURPOSE_ERRORS.sourceDuplicate,
        "You are already working on this video.",
        HttpStatus.CONFLICT,
        {
          existingRunId: "01JRUNEXISTING000000000000",
        },
      ),
    );
    const result = await service.startMany(
      WS,
      USER,
      body([url("aaaaaaaaaaa"), url("bbbbbbbbbbb")]),
    );
    expect(result.results[0]).toMatchObject({
      outcome: "already_running",
      runId: "01JRUNEXISTING000000000000",
    });
    expect(result.results[1]?.outcome).toBe("started");
    expect(result.started).toBe(1);
  });

  it("stops asking once the credits are gone, and says so on every later line", async () => {
    create.mockResolvedValueOnce({ run: { id: "01JRUN00000000000000000001" } });
    create.mockRejectedValueOnce(
      new AppException(
        REPURPOSE_ERRORS.noCredits,
        "Add credits to start it.",
        HttpStatus.PAYMENT_REQUIRED,
        {
          creditsLeft: 0.4,
        },
      ),
    );
    const result = await service.startMany(
      WS,
      USER,
      body([url("aaaaaaaaaaa"), url("bbbbbbbbbbb"), url("ccccccccccc"), url("ddddddddddd")]),
    );
    expect(result.results.map((line) => [line.outcome, line.code])).toEqual([
      ["started", null],
      ["refused", REPURPOSE_ERRORS.noCredits],
      ["refused", REPURPOSE_ERRORS.noCredits],
      ["refused", REPURPOSE_ERRORS.noCredits],
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("stops at the hour's ceiling of new runs", async () => {
    consume
      .mockResolvedValueOnce({ allowed: true, remaining: 0, retryAfterSec: 0 })
      .mockResolvedValue({ allowed: false, remaining: 0, retryAfterSec: 180 });
    const result = await service.startMany(
      WS,
      USER,
      body([url("aaaaaaaaaaa"), url("bbbbbbbbbbb"), url("ccccccccccc")]),
    );
    expect(result.results.map((line) => [line.outcome, line.code])).toEqual([
      ["started", null],
      ["refused", "common/rate_limited"],
      ["refused", "common/rate_limited"],
    ]);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("keeps one unexpected failure to its own line", async () => {
    create.mockRejectedValueOnce(new Error("socket hang up"));
    const result = await service.startMany(
      WS,
      USER,
      body([url("aaaaaaaaaaa"), url("bbbbbbbbbbb")]),
    );
    expect(result.results.map((line) => line.outcome)).toEqual(["refused", "started"]);
    expect(result.results[0]?.code).toBe("common/internal");
  });

  it("answers 404 while the feature is off, and refuses a request with no link at all", async () => {
    available.mockRejectedValueOnce(
      new AppException(AUTOMATION_ERRORS.disabled, "off", HttpStatus.NOT_FOUND),
    );
    await expect(service.startMany(WS, USER, body([url("aaaaaaaaaaa")]))).rejects.toMatchObject({
      code: AUTOMATION_ERRORS.disabled,
    });
    await expect(service.startMany(WS, USER, body(["  ", ""]))).rejects.toMatchObject({
      code: AUTOMATION_ERRORS.noLinks,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("takes at most twenty links, the rights box, and no picked start", () => {
    const links = Array.from({ length: BULK_MAX_LINKS + 1 }, (_, i) =>
      url(`v${String(i).padStart(10, "0")}`),
    );
    expect(bulkRunsSchema.safeParse({ links, setup: SETUP, rightsAttested: true }).success).toBe(
      false,
    );
    expect(
      bulkRunsSchema.safeParse({ links: [], setup: SETUP, rightsAttested: true }).success,
    ).toBe(false);
    expect(bulkRunsSchema.safeParse({ links: [url("aaaaaaaaaaa")], setup: SETUP }).success).toBe(
      false,
    );
    expect(
      bulkRunsSchema.safeParse({
        links: [url("aaaaaaaaaaa")],
        setup: { ...SETUP, window: { startMs: 60_000 } },
        rightsAttested: true,
      }).success,
    ).toBe(false);
    // Manual moments are the person's choice here: they are at the page.
    expect(
      bulkRunsSchema.safeParse({
        links: [url("aaaaaaaaaaa")],
        setup: {
          ...SETUP,
          automation: "manual",
          discovery: { mode: "manual", requestedCandidates: 0 },
        },
        rightsAttested: true,
      }).success,
    ).toBe(true);
  });
});
