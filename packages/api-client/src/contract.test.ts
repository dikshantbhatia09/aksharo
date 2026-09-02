import { describe, expect, it } from "vitest";

import { ALL_ENDPOINTS, endpoints } from "./endpoints.js";
import { API_OPERATIONS } from "./generated/operations.js";

/**
 * The endpoint descriptors are hand-written on top of a generated index, so the
 * only thing keeping them honest is this file. It fails in exactly the two ways
 * that matter: a route the API moved, and a pending route that has since landed.
 */

const byId = new Map(API_OPERATIONS.map((operation) => [operation.operationId, operation]));
const routes = new Set(API_OPERATIONS.map((operation) => `${operation.method} ${operation.path}`));

describe("endpoint descriptors against the generated operation index", () => {
  it("declares every endpoint either generated or pending, never both", () => {
    for (const [name, endpoint] of ALL_ENDPOINTS) {
      const generated = endpoint.operationId !== undefined;
      const pending = endpoint.pending !== undefined;
      expect(generated || pending, `${name} declares neither operationId nor pending`).toBe(true);
      expect(generated && pending, `${name} declares both`).toBe(false);
    }
  });

  it.each(
    ALL_ENDPOINTS.filter(([, endpoint]) => endpoint.operationId !== undefined).map(
      ([name, endpoint]) => [name, endpoint] as const,
    ),
  )("%s matches the method and path the API publishes", (name, endpoint) => {
    const id = endpoint.operationId;
    const operation = id === undefined ? undefined : byId.get(id);
    expect(
      operation,
      `${name}: ${endpoint.operationId ?? ""} is not in openapi.json`,
    ).toBeDefined();
    expect(operation?.method).toBe(endpoint.method);
    expect(operation?.path).toBe(endpoint.path);
  });

  it.each(
    ALL_ENDPOINTS.filter(([, endpoint]) => endpoint.pending !== undefined).map(
      ([name, endpoint]) => [name, endpoint] as const,
    ),
  )(
    "%s is still absent from the API — when it lands, move it out of pendingEndpoints",
    (_name, endpoint) => {
      expect(routes.has(`${endpoint.method} ${endpoint.path}`)).toBe(false);
    },
  );

  it("covers the auth flows the shell drives", () => {
    expect(endpoints.auth.signUp.path).toBe("/auth/signup");
    expect(endpoints.auth.exchangeWorkspace.auth).toBe("bearer");
    expect(endpoints.auth.refresh.auth).toBe("public");
    // The approval screen is behind a session on purpose (THREAT-MODEL T3).
    expect(endpoints.device.describe.auth).toBe("bearer");
    expect(endpoints.device.decide.auth).toBe("bearer");
  });

  it("never sends a workspace anywhere but the token (THREAT-MODEL T4)", () => {
    for (const [name, endpoint] of ALL_ENDPOINTS) {
      expect(endpoint.path.toLowerCase(), name).not.toContain("workspace-id");
      expect(endpoint.path.toLowerCase(), name).not.toContain("x-workspace");
    }
  });
});
