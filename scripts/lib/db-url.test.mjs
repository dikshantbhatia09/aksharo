import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseDatabaseName } from "./db-url.mjs";

test("parses the database name out of a standard postgresql:// URL", () => {
  assert.equal(
    parseDatabaseName("postgresql://montaj:montaj@localhost:5432/montaj_m19?schema=public"),
    "montaj_m19",
  );
});

test("parses the database name out of a postgres:// URL with no query string", () => {
  assert.equal(parseDatabaseName("postgres://user:pw@127.0.0.1:5432/montaj_m15"), "montaj_m15");
});

test("throws a clear error when DATABASE_URL is unset", () => {
  assert.throws(() => parseDatabaseName(undefined), /DATABASE_URL is not set/);
  assert.throws(() => parseDatabaseName(""), /DATABASE_URL is not set/);
});

test("throws a clear error when DATABASE_URL is not a valid URL", () => {
  assert.throws(() => parseDatabaseName("not-a-url"), /not a valid URL/);
});

test("throws a clear error when DATABASE_URL has no database name", () => {
  assert.throws(
    () => parseDatabaseName("postgresql://montaj:montaj@localhost:5432/"),
    /has no database name/,
  );
});
