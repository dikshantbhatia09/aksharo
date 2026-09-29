import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "./query-keys.js";
import {
  COMPILATIONS_POLL_MS,
  COMPILATIONS_URL_REFRESH_MS,
  cacheCompilation,
  compilationsPollDelay,
  compilationsQueryKey,
  isRepurposeCompilation,
  seriesQueryKey,
  type RepurposeCompilation,
} from "./repurpose-compilations.js";

const WS = "01JCWS0000000000000000000A";
const RUN = "01JCRN0000000000000000000A";

function compilation(overrides: Partial<RepurposeCompilation> = {}): RepurposeCompilation {
  return {
    id: "01JCC0MP11AT10N00000000000",
    runId: RUN,
    shape: "9:16",
    title: null,
    clipIds: [],
    status: "ready",
    failureCode: null,
    durationMs: 60_000,
    progress: null,
    playUrl: null,
    downloadUrl: null,
    expiresAt: null,
    stale: false,
    canRetry: false,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("compilations (2026-10-03)", () => {
  it("keeps its queries under the run, so the run's invalidation reaches them", () => {
    const run = queryKeys.repurposeRun(WS, RUN);
    expect(compilationsQueryKey(WS, RUN).slice(0, run.length)).toEqual([...run]);
    expect(seriesQueryKey(WS, RUN).slice(0, run.length)).toEqual([...run]);
  });

  it("polls while one is waiting or being made, and refreshes signed files slowly", () => {
    expect(compilationsPollDelay([compilation({ status: "rendering" })])).toBe(
      COMPILATIONS_POLL_MS,
    );
    expect(compilationsPollDelay([compilation({ status: "waiting" })])).toBe(COMPILATIONS_POLL_MS);
    expect(compilationsPollDelay([compilation({ playUrl: "https://x" })])).toBe(
      COMPILATIONS_URL_REFRESH_MS,
    );
    expect(compilationsPollDelay([compilation({ status: "failed" })])).toBe(false);
    expect(compilationsPollDelay(undefined)).toBe(false);
  });

  it("puts a made or remade compilation first in the cached list, once", () => {
    const client = new QueryClient();
    const older = compilation({ id: "01JCC0MP11AT10N0000000000A" });
    cacheCompilation(client, WS, older);
    const made = compilation({ status: "rendering" });
    cacheCompilation(client, WS, made);
    cacheCompilation(client, WS, { ...made, status: "ready" });
    const cached = client.getQueryData<{ compilations: RepurposeCompilation[] }>(
      compilationsQueryKey(WS, RUN),
    );
    expect(cached?.compilations.map((entry) => [entry.id, entry.status])).toEqual([
      [made.id, "ready"],
      [older.id, "ready"],
    ]);
  });

  it("trusts the list with a compilation only", () => {
    expect(isRepurposeCompilation(compilation())).toBe(true);
    expect(isRepurposeCompilation({ runId: RUN, compilations: [] })).toBe(false);
    expect(isRepurposeCompilation(null)).toBe(false);
    expect(isRepurposeCompilation({ ...compilation(), clipIds: "x" })).toBe(false);
  });
});
