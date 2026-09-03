import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Exercises the generator's pure functions directly (`parseModels`,
 * `personalDataTables`, `renderMarkdown`) against small fixtures, rather than
 * spawning the CLI against a fake repo layout — the CLI's own hard-coded
 * paths make that indirection more trouble than it is worth. `--check`
 * against the *real* schema and manifest is exercised by
 * `.github/workflows/ops-dpdp-records.yml` and by running the script by hand
 * (see `docs/compliance/dpdp-records.md`'s own generation).
 */
const mod = await import("./dpdp-records-generate.mjs");

test("flags a personal-data table (User relation)", () => {
  const schema = `
model Widget {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])

  @@map("widgets")
}
`;
  const tables = mod.personalDataTables(mod.parseModels(schema));
  assert.equal(tables.length, 1);
  assert.equal(tables[0].table, "widgets");
  assert.equal(tables[0].touchesUser, true);
});

test("flags a Workspace-relation table too", () => {
  const schema = `
model Gadget {
  id          String    @id
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id])

  @@map("gadgets")
}
`;
  const tables = mod.personalDataTables(mod.parseModels(schema));
  assert.equal(tables.length, 1);
  assert.equal(tables[0].table, "gadgets");
});

test("does not flag a table with neither a User nor a Workspace relation", () => {
  const schema = `
model SystemFlag {
  id  String @id
  key String @unique

  @@map("system_flags")
}
`;
  const tables = mod.personalDataTables(mod.parseModels(schema));
  assert.equal(tables.length, 0);
});

test("ignores a model with no @@map (not a real table)", () => {
  const schema = `
model Embedded {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
`;
  const tables = mod.personalDataTables(mod.parseModels(schema));
  assert.equal(tables.length, 0);
});

test("renderMarkdown includes every table's purpose and retention from the manifest", () => {
  const manifest = {
    version: "test",
    tables: { widgets: { purpose: "service", retention: "Forever." } },
  };
  const tables = [{ name: "Widget", table: "widgets", touchesUser: true, touchesWorkspace: false }];
  const markdown = mod.renderMarkdown(manifest, tables);
  assert.match(markdown, /widgets/);
  assert.match(markdown, /Forever\./);
  assert.match(markdown, /do not hand-edit/);
});
