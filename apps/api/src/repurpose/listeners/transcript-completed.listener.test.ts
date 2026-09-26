import { describe, expect, it, vi } from "vitest";

import { RepurposeTranscriptCompletedListener } from "./transcript-completed.listener.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { RepurposeService } from "../repurpose.service.js";

const RUN = "01JCRN0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const TRANSCRIPT = "01JCTRANSCR1PT000000000000";

function harness(run: Record<string, unknown> | null) {
  const findFirst = vi.fn(async () => run);
  const repurpose = {
    startHighlightDiscovery: vi.fn(async () => ({ outcome: "deferred" as const })),
    reconcileRun: vi.fn(async () => undefined),
  };
  const listener = new RepurposeTranscriptCompletedListener(
    { repurposeRun: { findFirst } } as unknown as PrismaService,
    repurpose as unknown as RepurposeService,
  );
  return { listener, repurpose, findFirst };
}

const payload = { projectId: PROJECT, transcriptId: TRANSCRIPT } as never;

describe("RepurposeTranscriptCompletedListener", () => {
  it("starts discovery for the run the transcript belongs to, then reconciles it", async () => {
    // A refused start used to be logged and dropped here, and nothing ever
    // started discovery again: the run said "Finding promising moments" for good.
    const h = harness({ id: RUN, status: "transcribing" });
    await h.listener.onTranscriptCompleted(payload);

    expect(h.repurpose.startHighlightDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      TRANSCRIPT,
    );
    expect(h.repurpose.reconcileRun).toHaveBeenCalledWith(RUN);
  });

  it("only looks at runs still waiting for their moments", async () => {
    const h = harness(null);
    await h.listener.onTranscriptCompleted(payload);

    const where = (
      h.findFirst.mock.calls[0] as unknown as [{ where: { status: { in: string[] } } }]
    )[0].where;
    expect(where.status.in).toEqual([
      "draft",
      "acquiring",
      "preparing_media",
      "transcribing",
      "analyzing",
    ]);
    expect(h.repurpose.startHighlightDiscovery).not.toHaveBeenCalled();
  });

  it("never throws into the emitter", async () => {
    const h = harness({ id: RUN, status: "draft" });
    h.repurpose.startHighlightDiscovery.mockRejectedValueOnce(new Error("database went away"));
    await expect(h.listener.onTranscriptCompleted(payload)).resolves.toBeUndefined();
  });
});
