import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  InternalMediaController,
  MediaPatchDto,
  assertOwnKeys,
} from "./internal-media.controller.js";
import { AppException } from "../common/errors/error-codes.js";
import { mediaPrefix } from "../common/storage/storage.keys.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const PREFIX = mediaPrefix(WS, PROJECT, MEDIA);

/** The allow-list is a Zod schema on the DTO; this is how a request reaches it. */
function parse(body: unknown): Record<string, unknown> {
  return MediaPatchDto.zodSchema.parse(body) as Record<string, unknown>;
}

function controller(asset: Record<string, unknown> | null = defaultAsset()): {
  controller: InternalMediaController;
  updateMany: ReturnType<typeof vi.fn>;
} {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    mediaAsset: {
      findUnique: vi.fn(async () => asset),
      updateMany,
      findUniqueOrThrow: vi.fn(async () => ({ status: "ready" })),
    },
  } as unknown as PrismaService;
  return { controller: new InternalMediaController(prisma), updateMany };
}

function defaultAsset(): Record<string, unknown> {
  return { id: MEDIA, projectId: PROJECT, project: { workspaceId: WS } };
}

describe("MediaPatchSchema — the worker's allow-list", () => {
  it("accepts everything media.probe measures", () => {
    expect(
      parse({
        durationMs: 10_000,
        width: 1080,
        height: 1920,
        fps: 29.97,
        codec: "h264",
        hasAudio: true,
        hdr: false,
        audioChannels: 2,
        mime: "video/mp4",
        status: "probing",
      }),
    ).toMatchObject({ codec: "h264", hasAudio: true, hdr: false });
  });

  it("accepts everything media.proxy writes, thumbnails included", () => {
    const patch = parse({
      status: "ready",
      proxyKey: `${PREFIX}/proxy540.mp4`,
      audio16kKey: `${PREFIX}/audio16k.wav`,
      audio48kKey: `${PREFIX}/audio48k.wav`,
      waveformKey: `${PREFIX}/waveform.json`,
      thumbKeys: [`${PREFIX}/thumb-0.jpg`, `${PREFIX}/thumb-1.jpg`],
    });
    expect(patch["thumbKeys"]).toHaveLength(2);
  });

  it("refuses the fields ownership and retention depend on (T5)", () => {
    // A compromised worker must not be able to repoint an asset at another
    // tenant's object, or extend its own retention.
    for (const field of [
      "projectId",
      "storageKey",
      "bucket",
      "rawPurgeAt",
      "derivedPurgeAt",
      "rawPurgedAt",
      "derivedPurgedAt",
      "role",
      "needsRealign",
    ]) {
      const patch = parse({ durationMs: 1, [field]: "anything" });
      expect(Object.keys(patch), `should strip ${field}`).not.toContain(field);
    }
  });

  it("refuses a failure reason that is not one of the closed set", () => {
    // `failure_reason` is rendered to the user; an open string would be a
    // worker-controlled sentence on somebody's screen.
    expect(() => parse({ failureReason: "media/too_long" })).not.toThrow();
    expect(() => parse({ failureReason: "your file is rubbish" })).toThrow();
    expect(() => parse({ failureReason: "media/whatever" })).toThrow();
  });

  it("refuses a status outside the four a worker may set", () => {
    expect(() => parse({ status: "purged" })).toThrow();
    expect(() => parse({ status: "pending" })).toThrow();
  });

  it("refuses an empty patch and an over-long key list", () => {
    expect(() => parse({})).toThrow();
    expect(() =>
      parse({
        thumbKeys: Array.from({ length: 33 }, (_u, i) => `${PREFIX}/thumb-${String(i)}.jpg`),
      }),
    ).toThrow();
  });
});

describe("assertOwnKeys", () => {
  it("accepts keys under the asset's own prefix", () => {
    expect(() =>
      assertOwnKeys(
        {
          proxyKey: `${PREFIX}/proxy540.mp4`,
          thumbKeys: [`${PREFIX}/thumb-0.jpg`],
        },
        PREFIX,
      ),
    ).not.toThrow();
  });

  it("refuses a key pointing at another tenant's object (T5)", () => {
    // Being on the allow-list only says a worker may SET proxyKey; this is what
    // says it may only set it to something of its own.
    const other = mediaPrefix(
      "01JCWS0000000000000000000B",
      "01JCPR0JECT00000000000000B",
      "01JCMED1A0000000000000000B",
    );
    const error = (() => {
      try {
        assertOwnKeys({ proxyKey: `${other}/proxy540.mp4` }, PREFIX);
        return null;
      } catch (caught) {
        return caught as AppException;
      }
    })();
    expect(error).toBeInstanceOf(AppException);
    expect(error?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it("refuses traversal that would climb back out of the prefix", () => {
    expect(() => assertOwnKeys({ waveformKey: `${PREFIX}/../../x/waveform.json` }, PREFIX)).toThrow(
      AppException,
    );
  });

  it("refuses a thumbnail list where only one entry is foreign", () => {
    expect(() =>
      assertOwnKeys(
        { thumbKeys: [`${PREFIX}/thumb-0.jpg`, "ws/other/p/x/media/y/thumb-1.jpg"] },
        PREFIX,
      ),
    ).toThrow(AppException);
  });

  it("names the offending fields and nothing else", () => {
    const error = (() => {
      try {
        assertOwnKeys(
          { proxyKey: "elsewhere/proxy540.mp4", audio16kKey: `${PREFIX}/a.wav` },
          PREFIX,
        );
        return null;
      } catch (caught) {
        return caught as AppException;
      }
    })();
    // The offending key itself is not echoed back.
    expect(JSON.stringify(error)).not.toContain("elsewhere/proxy540.mp4");
  });
});

describe("PATCH /internal/media/{id}", () => {
  it("writes the allow-listed fields and answers the new status", async () => {
    const { controller: subject, updateMany } = controller();
    const ack = await subject.patch(MEDIA, parse({ durationMs: 10_000, hasAudio: true }) as never);
    expect(ack).toEqual({ mediaId: MEDIA, status: "ready" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: MEDIA },
      data: { durationMs: 10_000, hasAudio: true },
    });
  });

  it("turns sizeBytes into the BigInt the column wants", async () => {
    const { controller: subject, updateMany } = controller();
    await subject.patch(MEDIA, parse({ sizeBytes: 4_096 }) as never);
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { sizeBytes: BigInt(4_096) },
    });
  });

  it("answers 404 for a media asset that does not exist", async () => {
    const { controller: subject } = controller(null);
    await expect(subject.patch(MEDIA, parse({ durationMs: 1 }) as never)).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it("refuses a foreign key before it writes anything", async () => {
    const { controller: subject, updateMany } = controller();
    await expect(
      subject.patch(MEDIA, parse({ proxyKey: "ws/other/p/x/media/y/proxy540.mp4" }) as never),
    ).rejects.toBeInstanceOf(AppException);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
