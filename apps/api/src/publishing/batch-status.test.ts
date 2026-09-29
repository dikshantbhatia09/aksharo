import { describe, expect, it } from "vitest";

import { batchStatusOf } from "./batch-status.js";

describe("batchStatusOf", () => {
  it("summarises a batch from its posts (master plan §12.7)", () => {
    expect(batchStatusOf(["published", "published"]).status).toBe("published");
    expect(batchStatusOf(["published", "failed_retryable", "processing"])).toEqual({
      status: "partially_published",
      publishedCount: 1,
      failedCount: 1,
    });
    expect(batchStatusOf(["failed_permanent", "cancelled"]).status).toBe("failed");
    expect(batchStatusOf(["cancelled"]).status).toBe("cancelled");
    expect(batchStatusOf(["scheduled", "scheduled"]).status).toBe("pending");
    expect(batchStatusOf(["ready", "submitted"]).status).toBe("publishing");
  });
});
