import { describe, expect, it } from "vitest";

import { findApiGroup, loadApiGroups, snippetsFor } from "./openapi";

/**
 * Determinism (brief §4: "generator unit tests (deterministic output ...)").
 * `openapi.json` is not touched by this WP, so these tests lock in the shape
 * this generator derives from it rather than the document's own content.
 */
describe("loadApiGroups", () => {
  it("only includes /v1/* paths", () => {
    for (const group of loadApiGroups()) {
      for (const endpoint of group.endpoints) {
        expect(endpoint.path.startsWith("/v1/")).toBe(true);
      }
    }
  });

  it("is deterministic across repeated calls", () => {
    expect(loadApiGroups()).toEqual(loadApiGroups());
  });

  it("groups are sorted by tag and endpoints by path then method", () => {
    const groups = loadApiGroups();
    const tags = groups.map((group) => group.tag);
    expect(tags).toEqual([...tags].sort((a, b) => a.localeCompare(b)));
    for (const group of groups) {
      const keys = group.endpoints.map((endpoint) => `${endpoint.path}:${endpoint.method}`);
      expect(keys).toEqual(
        [...keys].sort((a, b) => {
          const [pathA, methodA] = a.split(":");
          const [pathB, methodB] = b.split(":");
          return pathA!.localeCompare(pathB!) || methodA!.localeCompare(methodB!);
        }),
      );
    }
  });

  it("has at least a projects, exports and jobs group", () => {
    const tags = loadApiGroups().map((group) => group.tag);
    expect(tags).toEqual(expect.arrayContaining(["projects", "exports", "jobs"]));
  });

  it("every endpoint has a non-empty summary and operationId", () => {
    for (const group of loadApiGroups()) {
      for (const endpoint of group.endpoints) {
        expect(endpoint.summary.length).toBeGreaterThan(0);
        expect(endpoint.operationId.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("findApiGroup", () => {
  it("finds a known group by tag", () => {
    expect(findApiGroup("projects")).toBeDefined();
  });

  it("returns undefined for an unknown tag", () => {
    expect(findApiGroup("not-a-real-group")).toBeUndefined();
  });
});

describe("snippetsFor", () => {
  it("templates path parameters as <name> placeholders in every language", () => {
    const group = findApiGroup("projects")!;
    const endpoint = group.endpoints.find((e) => e.path.includes("{id}"))!;
    const snippets = snippetsFor(endpoint);
    expect(snippets.curl).toContain("<id>");
    expect(snippets.node).toContain("<id>");
    expect(snippets.python).toContain("<id>");
  });

  it("includes a JSON body placeholder only when the endpoint has a request body", () => {
    const group = findApiGroup("projects")!;
    const withBody = group.endpoints.find((e) => e.hasRequestBody)!;
    const withoutBody = group.endpoints.find((e) => !e.hasRequestBody)!;
    expect(snippetsFor(withBody).curl).toContain("-d '{}'");
    expect(snippetsFor(withoutBody).curl).not.toContain("-d '{}'");
  });

  it("uses the X-Api-Key header in curl and node", () => {
    const group = findApiGroup("jobs")!;
    const endpoint = group.endpoints[0]!;
    const snippets = snippetsFor(endpoint);
    expect(snippets.curl).toContain("X-Api-Key");
    expect(snippets.node).toContain("X-Api-Key");
    expect(snippets.python).toContain("X-Api-Key");
  });
});
