import { describe, expect, it } from "vitest";

import { sortProjects } from "./project-toolbar";

const ROWS = [
  { title: "Banana clip", createdAt: "2026-09-01T00:00:00.000Z" },
  { title: "apple clip", createdAt: "2026-09-03T00:00:00.000Z" },
  { title: "Cherry clip", createdAt: "2026-09-02T00:00:00.000Z" },
];

describe("sortProjects", () => {
  it("newest first by createdAt", () => {
    expect(sortProjects(ROWS, "newest").map((r) => r.title)).toEqual([
      "apple clip",
      "Cherry clip",
      "Banana clip",
    ]);
  });

  it("oldest first by createdAt", () => {
    expect(sortProjects(ROWS, "oldest").map((r) => r.title)).toEqual([
      "Banana clip",
      "Cherry clip",
      "apple clip",
    ]);
  });

  it("title A-Z, case-insensitively", () => {
    expect(sortProjects(ROWS, "title").map((r) => r.title)).toEqual([
      "apple clip",
      "Banana clip",
      "Cherry clip",
    ]);
  });

  it("does not mutate the input array", () => {
    const original = [...ROWS];
    sortProjects(ROWS, "title");
    expect(ROWS).toEqual(original);
  });
});
