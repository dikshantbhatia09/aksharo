import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import { GuestLinksService } from "./guest-links.service.js";
import { GuestPageService } from "./guest-page.service.js";
import { GUEST_PROVIDERS } from "./guest.module.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { RateLimitService } from "../../common/guards/index.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { DERIVED_STORE } from "../../common/storage/index.js";
import { ENV } from "../../config/config.module.js";
import { NotifyService } from "../../notify/notify.service.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";
import { CLIP_REVIEW_PROVIDERS } from "../review/clip-review.module.js";

/**
 * The module's own provider list, resolved by Nest's injector over the review
 * module's providers (which `RepurposeGuestModule` imports) with the global
 * ones stubbed: a constructor parameter imported with `import type`, or a
 * token nobody provides, fails here rather than at boot.
 */
describe("RepurposeGuestModule providers", () => {
  it("resolve", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...GUEST_PROVIDERS,
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

    expect(moduleRef.get(GuestLinksService)).toBeInstanceOf(GuestLinksService);
    expect(moduleRef.get(GuestPageService)).toBeInstanceOf(GuestPageService);
    await moduleRef.close();
  });
});
