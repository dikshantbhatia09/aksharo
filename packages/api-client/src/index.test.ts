import { describe, expect, it } from "vitest";

import { API_OPERATIONS, API_VERSION, findOperation, PACKAGE_INFO } from "./index.js";

describe("@montaj/api-client", () => {
  it("declares its identity and its owning work packages", () => {
    expect(PACKAGE_INFO.name).toBe("@montaj/api-client");
    expect(PACKAGE_INFO.implementedBy).toBe(
      "A03 (spec), A04 (generator), A13 (fetch layer + hooks)",
    );
  });

  it("is implemented now that the fetch layer and the hooks have landed (A13)", () => {
    expect(PACKAGE_INFO.implemented).toBe(true);
  });
});

describe("the generated operation index", () => {
  it("carries the API version it was generated from", () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has a unique id, a method and a path for every operation", () => {
    expect(API_OPERATIONS.length).toBeGreaterThan(0);
    const ids = API_OPERATIONS.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const operation of API_OPERATIONS) {
      expect(operation.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(operation.path.startsWith("/")).toBe(true);
    }
  });

  it("covers the auth surface the rest of the product signs in through", () => {
    const routes = API_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`);
    for (const route of [
      "POST /auth/signup",
      "POST /auth/login",
      "POST /auth/refresh",
      "POST /auth/logout",
      "POST /auth/token/exchange",
      "GET /auth/sessions",
      "DELETE /auth/sessions/{sessionId}",
      "POST /auth/device/code",
      "POST /auth/device/token",
      "POST /auth/device/approve",
      "GET /auth/oauth/google/start",
      "POST /auth/oauth/complete",
    ]) {
      expect(routes).toContain(route);
    }
  });

  it("looks an operation up by id", () => {
    const first = API_OPERATIONS[0];
    expect(first).toBeDefined();
    expect(findOperation(first?.operationId ?? "GET /")).toEqual(first);
  });
});
