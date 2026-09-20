import assert from "node:assert/strict";
import test from "node:test";
import { databaseUrlWithTls, requireDatabaseTls } from "./database-url.mjs";

test("a managed connection string gets sslmode=require", () => {
  assert.equal(
    databaseUrlWithTls("postgresql://refund:pw@dpg-abc123-a/refund"),
    "postgresql://refund:pw@dpg-abc123-a/refund?sslmode=require",
  );
});

test("existing query parameters and credentials survive", () => {
  const normalized = databaseUrlWithTls(
    "postgresql://refund:p%40ss@db.internal:5432/refund?schema=public",
  );
  const parsed = new URL(normalized);
  assert.equal(parsed.searchParams.get("schema"), "public");
  assert.equal(parsed.searchParams.get("sslmode"), "require");
  assert.equal(parsed.password, "p%40ss");
});

test("an explicit sslmode is never overridden", () => {
  for (const mode of ["disable", "verify-full", "prefer"]) {
    const url = `postgresql://refund:pw@db.internal:5432/refund?sslmode=${mode}`;
    assert.equal(databaseUrlWithTls(url), url);
  }
});

test("a local development database is left alone", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const url = `postgresql://refund:pw@${host}:5432/refund?schema=public`;
    assert.equal(databaseUrlWithTls(url), url);
  }
});

test("an unset or malformed URL passes through for Prisma to report", () => {
  assert.equal(databaseUrlWithTls(undefined), undefined);
  assert.equal(databaseUrlWithTls(""), "");
  assert.equal(databaseUrlWithTls("not a url"), "not a url");
});

test("requireDatabaseTls rewrites the environment children inherit", () => {
  const environment = {
    DATABASE_URL: "postgresql://refund:pw@db.internal:5432/refund",
  };
  requireDatabaseTls(environment);
  assert.equal(
    environment.DATABASE_URL,
    "postgresql://refund:pw@db.internal:5432/refund?sslmode=require",
  );
});
