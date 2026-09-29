import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { queryKeys } from "./query-keys.js";
import {
  DUBS_POLL_MS,
  DUBS_URL_REFRESH_MS,
  cacheDub,
  dubCostTenths,
  dubsPollDelay,
  dubsQueryKey,
  isRepurposeDub,
  type RepurposeDub,
  type RepurposeDubList,
} from "./repurpose-dubs.js";

const WS = "01JCWS0000000000000000000A";
const RUN = "01JCRN0000000000000000000A";

function dub(overrides: Partial<RepurposeDub> = {}): RepurposeDub {
  return {
    id: "01JCDVB0000000000000000000",
    runId: RUN,
    clipId: "01JCC11PA00000000000000000",
    status: "ready",
    failureCode: null,
    failureMessage: null,
    sourceLanguage: { code: "en-IN", name: "English" },
    languages: [],
    durationMs: 34_000,
    costTenths: 284,
    progress: null,
    step: null,
    canRetry: false,
    canCancel: false,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function list(dubs: RepurposeDub[]): RepurposeDubList {
  return { runId: RUN, enabled: true, tenthsPerMinute: 250, languages: [], clips: [], dubs };
}

describe("dubs (2026-10-04)", () => {
  it("keeps its query under the run, so the run's invalidation reaches it", () => {
    const run = queryKeys.repurposeRun(WS, RUN);
    expect(dubsQueryKey(WS, RUN).slice(0, run.length)).toEqual([...run]);
  });

  it("polls while a dub is being made, and refreshes signed files slowly", () => {
    for (const status of ["waiting", "dubbing", "making"] as const) {
      expect(dubsPollDelay(list([dub({ status })])), status).toBe(DUBS_POLL_MS);
    }
    const made = dub({
      languages: [
        {
          code: "hi-IN",
          name: "Hindi",
          status: "ready",
          reason: null,
          formats: [
            {
              shape: "9:16",
              status: "ready",
              projectId: "p",
              captioned: { status: "ready", playUrl: "https://x", downloadUrl: "https://y" },
              cleanUrl: "https://z",
            },
          ],
        },
      ],
    });
    expect(dubsPollDelay(list([made]))).toBe(DUBS_URL_REFRESH_MS);
    expect(dubsPollDelay(list([dub({ status: "failed" })]))).toBe(false);
    expect(dubsPollDelay(undefined)).toBe(false);
  });

  it("quotes the same credits the API holds", () => {
    // 34 s in two languages at 25 credits a minute: 28.4 credits.
    expect(dubCostTenths(34_000, 2, 250)).toBe(284);
    expect(dubCostTenths(60_000, 1, 250)).toBe(250);
    expect(dubCostTenths(34_001, 1, 250)).toBe(dubCostTenths(35_000, 1, 250));
    expect(dubCostTenths(0, 1, 250)).toBe(5);
  });

  it("puts a dub into the cached list once, replacing its older copy", () => {
    const client = new QueryClient();
    client.setQueryData(dubsQueryKey(WS, RUN), list([dub({ status: "dubbing" })]));
    cacheDub(client, WS, dub({ status: "making" }));
    const cached = client.getQueryData<RepurposeDubList>(dubsQueryKey(WS, RUN));
    expect(cached?.dubs.map((entry) => entry.status)).toEqual(["making"]);
  });

  it("trusts the list with a dub only", () => {
    expect(isRepurposeDub(dub())).toBe(true);
    expect(isRepurposeDub(list([]))).toBe(false);
    expect(isRepurposeDub(null)).toBe(false);
  });
});
