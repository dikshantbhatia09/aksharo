import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../version.js";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("reports ok and the deployed version", () => {
    expect(new HealthController().getHealth()).toEqual({ status: "ok", version: APP_VERSION });
  });
});
