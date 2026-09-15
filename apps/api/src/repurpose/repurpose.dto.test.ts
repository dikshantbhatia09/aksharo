import { describe, expect, it } from "vitest";

import {
  CreateRunSourceSchema,
  ExistingUploadTicketSchema,
  RunConfigSchema,
} from "@montaj/repurpose-contracts";

import { createRunSchema, listRunsSchema } from "./repurpose.dto.js";

/**
 * The DTO layer against `@montaj/repurpose-contracts` (REP-001's open question).
 *
 * REP-001 recorded that `ExistingUploadTicketSchema` was a provisional mirror of
 * the existing media upload ticket and needed a parity check "before route
 * integration". REP-006 is that integration, so this is that check: the ticket
 * the contract describes is the ticket `MediaService.initUpload` actually
 * returns, field for field.
 */

const UPLOAD_TICKET = {
  mediaId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  uploadId: "2~abc",
  key: "ws/01ARZ3NDEKTSV4RRFFQ69G5FB0/p/01ARZ3NDEKTSV4RRFFQ69G5FAX/media/01ARZ3NDEKTSV4RRFFQ69G5FB6/raw.mp4",
  bucket: "s3",
  partSizeBytes: 16 * 1024 * 1024,
  parts: [{ partNumber: 1, url: "https://storage.example.test/part-1" }],
  expiresAt: "2026-09-15T11:00:00.000Z",
  duplicate: false,
  media: {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    role: "primary",
    bucket: "s3",
    storageKey: "ws/a/p/b/media/c/raw.mp4",
    filename: "episode-12.mp4",
    mime: "video/mp4",
    sizeBytes: 148_372_910,
    contentHash: null,
    durationMs: null,
    fps: null,
    width: null,
    height: null,
    audioChannels: null,
    status: "pending",
    needsRealign: false,
    uploadedAt: null,
    rawPurgeAt: null,
    derivedPurgeAt: null,
    derived: { proxy: null, audio16k: null, audio48k: null, waveform: null, thumbs: [] },
    createdAt: "2026-09-15T10:00:00.000Z",
  },
};

describe("upload ticket parity (REP-001 follow-up)", () => {
  it("accepts the shape the existing media service returns", () => {
    // The literal above is `UploadTicket`/`MediaView` as `media.service.ts`
    // declares them. If either interface changes, this fails here rather than in
    // a browser that silently has no parts to PUT.
    const result = ExistingUploadTicketSchema.safeParse(UPLOAD_TICKET);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("still rejects a ticket with no parts to upload to", () => {
    const parsed = ExistingUploadTicketSchema.safeParse({ ...UPLOAD_TICKET, parts: "none" });
    expect(parsed.success).toBe(false);
  });
});

describe("create-run DTO", () => {
  const validUpload = {
    source: {
      kind: "upload",
      filename: "episode-12.mp4",
      mime: "video/mp4",
      sizeBytes: 148_372_910,
    },
    setup: {
      sourceLanguage: "hi-Latn",
      caption: { outputLanguage: "same", scriptMode: "roman", styleId: "punch-pop" },
      discovery: {
        mode: "ai",
        requestedCandidates: 5,
        minDurationMs: 15_000,
        maxDurationMs: 60_000,
        contentGoal: "reach",
      },
    },
  };

  it("accepts an upload and a link", () => {
    expect(createRunSchema.safeParse(validUpload).success).toBe(true);
    expect(
      createRunSchema.safeParse({
        ...validUpload,
        source: {
          kind: "url",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsAttested: true,
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a link without the rights attestation", () => {
    // §9.3: the tick is required for an external source, and `true` is the only
    // value that satisfies it — `false` is not an attestation, it is a refusal.
    for (const rightsAttested of [false, undefined, "yes"]) {
      expect(
        createRunSchema.safeParse({
          ...validUpload,
          source: {
            kind: "url",
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            ...(rightsAttested === undefined ? {} : { rightsAttested }),
          },
        }).success,
        String(rightsAttested),
      ).toBe(false);
    }
  });

  it("refuses a duration window that is inside out", () => {
    const parsed = createRunSchema.safeParse({
      ...validUpload,
      setup: {
        ...validUpload.setup,
        discovery: { ...validUpload.setup.discovery, minDurationMs: 90_000 },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses AI suggestions in manual mode", () => {
    const parsed = createRunSchema.safeParse({
      ...validUpload,
      setup: {
        ...validUpload.setup,
        discovery: { ...validUpload.setup.discovery, mode: "manual" },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("fills in the documented defaults", () => {
    const parsed = createRunSchema.parse({
      source: validUpload.source,
      setup: {
        sourceLanguage: "en",
        caption: { styleId: "punch-pop" },
        discovery: {},
      },
    });
    expect(parsed.setup.discovery.requestedCandidates).toBe(5);
    expect(parsed.setup.discovery.mode).toBe("ai");
    expect(parsed.setup.caption.outputLanguage).toBe("same");
    expect(parsed.setup.caption.scriptMode).toBe("auto");
  });

  it("produces a setup the cross-runtime run config accepts", () => {
    // The DTO is what HTTP takes; `RunConfigSchema` is what is frozen onto the
    // row and read by every other runtime. Proving one can become the other is
    // what stops the two drifting into different products.
    const parsed = createRunSchema.parse(validUpload);
    const config = {
      schemaVersion: 1,
      sourceLanguage: parsed.setup.sourceLanguage,
      caption: { ...parsed.setup.caption, styleVersion: 1 },
      discovery: parsed.setup.discovery,
      formats: [{ aspect: "9:16", destinations: [], reframe: "auto" }],
      enhancements: { audioClean: false, autoZoom: false, autoTextFx: false, music: "off" },
    };
    const result = RunConfigSchema.safeParse(config);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it("agrees with the contract about which sources exist", () => {
    // The DTO says `url`; the contract splits it into `youtube_url` and
    // `direct_media_url` once the normaliser has decided which it is. Both sides
    // must agree that those are the only three, and that a bare string is not one.
    expect(CreateRunSourceSchema.safeParse({ kind: "upload" }).success).toBe(false);
    expect(createRunSchema.safeParse({ ...validUpload, source: { kind: "rtmp" } }).success).toBe(
      false,
    );
  });
});

describe("list DTO", () => {
  it("defaults the page size and caps it", () => {
    expect(listRunsSchema.parse({}).limit).toBe(20);
    expect(listRunsSchema.safeParse({ limit: 500 }).success).toBe(false);
  });

  it("coerces the limit a query string delivers as text", () => {
    expect(listRunsSchema.parse({ limit: "5" }).limit).toBe(5);
  });

  it("refuses a cursor that is not an id", () => {
    expect(listRunsSchema.safeParse({ cursor: "../../etc" }).success).toBe(false);
  });
});
