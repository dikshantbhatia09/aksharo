import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import { ClientReviewService } from "./client-review.service.js";
import { ClipApprovalGate } from "./clip-approval.gate.js";
import { CLIP_REVIEW_PROVIDERS } from "./clip-review.module.js";
import { ClipReviewService } from "./clip-review.service.js";
import { ReviewExportListener } from "./review-export.listener.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { RateLimitService } from "../../common/guards/index.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { DERIVED_STORE } from "../../common/storage/index.js";
import { ENV } from "../../config/config.module.js";
import { NotifyService } from "../../notify/notify.service.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";

/**
 * The module's own provider list, resolved by Nest's injector with the global
 * and imported providers stubbed: a constructor parameter imported with
 * `import type`, or a token nobody provides, fails here rather than at boot.
 */
describe("ClipReviewModule providers", () => {
  it("resolve", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...CLIP_REVIEW_PROVIDERS,
        { provide: PrismaService, useValue: {} },
        { provide: CommonAuditService, useValue: {} },
        { provide: NotifyService, useValue: {} },
        { provide: RateLimitService, useValue: {} },
        { provide: EntitlementService, useValue: {} },
        { provide: DERIVED_STORE, useValue: {} },
        { provide: ENV, useValue: { FEATURE_FLAGS_JSON: {}, WEB_ORIGIN: "https://aksharo.test" } },
      ],
    }).compile();

    expect(moduleRef.get(ClipReviewService)).toBeInstanceOf(ClipReviewService);
    expect(moduleRef.get(ClientReviewService)).toBeInstanceOf(ClientReviewService);
    expect(moduleRef.get(ClipApprovalGate)).toBeInstanceOf(ClipApprovalGate);
    expect(moduleRef.get(ReviewExportListener)).toBeInstanceOf(ReviewExportListener);
    await moduleRef.close();
  });
});
