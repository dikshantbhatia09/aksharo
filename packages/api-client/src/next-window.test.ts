import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { cacheNextWindow, requestNextWindow } from "./hooks.js";
import { queryKeys } from "./query-keys.js";

import type { EndpointSpec } from "./http.js";
import type { RepurposeRunView } from "./types.js";

/**
 * `useNextWindow` (clips on long videos, 2026-09-27): "process the next 20
 * minutes" is a POST that answers with a NEW run. The hook is these two steps;
 * each is checked here without a React renderer.
 */

const WS = "01JCWS0000000000000000000A";
const RUN = "01JCRN0000000000000000000A";
const NEXT = "01JCRN0000000000000000000B";

function run(id: string): RepurposeRunView {
  return {
    id,
    workspaceId: WS,
    sourceProjectId: "01JCPR0JECT000000000000000",
    sourceKind: "youtube_url",
    sourceDisplay: "youtube.com · dQw4w9WgXcQ",
    mode: "ai",
    status: "draft",
    currentStage: "getting_video",
    progress: 0,
    stages: [],
    message: "Getting your video.",
    failureCode: null,
    canCancel: true,
    canRetry: false,
    candidateCount: 0,
    clipCount: 0,
    variantCount: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    sourceTitle: "A talk",
    window: null,
    failureDetail: null,
    nextWindowAvailable: false,
  };
}

describe("requestNextWindow", () => {
  it("POSTs to the run's next-window route and answers with the NEW run", async () => {
    const call = vi.fn(async () => ({ run: run(NEXT) }));
    const answer = await requestNextWindow({ call } as never, RUN);

    expect(answer.id).toBe(NEXT);
    const [spec, options] = call.mock.calls[0] as unknown as [
      EndpointSpec<unknown, unknown>,
      { params: Record<string, string> },
    ];
    expect(spec).toMatchObject({
      method: "POST",
      path: "/repurpose/runs/{runId}/next-window",
      auth: "bearer",
    });
    expect(options.params).toEqual({ runId: RUN });
  });

  it("passes the API's refusal on, for the page to say why", async () => {
    const refusal = Object.assign(new Error("nothing left"), { code: "repurpose/no_next_window" });
    const call = vi.fn(async () => {
      throw refusal;
    });
    await expect(requestNextWindow({ call } as never, RUN)).rejects.toBe(refusal);
  });
});

describe("cacheNextWindow", () => {
  it("makes the new run readable at once and refetches the run lists", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    cacheNextWindow(queryClient, WS, run(NEXT));

    expect(queryClient.getQueryData(queryKeys.repurposeRun(WS, NEXT))).toMatchObject({ id: NEXT });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repurposeRuns(WS) });
  });
});
