// cli.test.ts — read-only SQL guard for the query_d1 MCP tool.
import { describe, it, expect } from "vitest";
import { ensureReadOnlySql } from "./cli.js";

const ok = (sql: string) => expect(ensureReadOnlySql(sql).ok).toBe(true);
const blocked = (sql: string) => expect(ensureReadOnlySql(sql).ok).toBe(false);

describe("ensureReadOnlySql — allows read-only", () => {
    it("plain SELECT", () => ok("SELECT * FROM users"));
    it("WITH ... SELECT (read CTE)", () =>
        ok("WITH recent AS (SELECT * FROM logs WHERE ts > 0) SELECT * FROM recent"));
    it("EXPLAIN SELECT", () => ok("EXPLAIN QUERY PLAN SELECT 1"));
    it("read PRAGMA with function syntax", () => ok("PRAGMA table_info('users')"));
    it("SELECT containing a write word inside a string literal", () =>
        ok("SELECT 'please DELETE this later' AS note FROM t"));
    it("SELECT with a column name that contains a keyword substring", () =>
        ok("SELECT delete_count, created_at FROM stats"));
    it("trailing semicolon and comments", () => ok("SELECT 1; -- done"));
});

describe("ensureReadOnlySql — blocks writes", () => {
    it("bare DELETE", () => blocked("DELETE FROM users"));
    it("bare UPDATE", () => blocked("UPDATE users SET admin = 1"));
    it("WITH-prefixed DELETE (CTE bypass)", () =>
        blocked("WITH x AS (SELECT id FROM users) DELETE FROM users WHERE id IN (SELECT id FROM x)"));
    it("WITH-prefixed INSERT", () =>
        blocked("WITH x AS (SELECT 1 AS v) INSERT INTO audit (v) SELECT v FROM x"));
    it("WITH-prefixed UPDATE", () =>
        blocked("WITH x AS (SELECT id FROM t) UPDATE t SET flag = 1"));
    it("assignment-form PRAGMA (writable)", () => blocked("PRAGMA journal_mode = WAL"));
    it("writable_schema PRAGMA", () => blocked("PRAGMA writable_schema = ON"));
    it("DROP TABLE", () => blocked("DROP TABLE users"));
    it("multi-statement payload", () => blocked("SELECT 1; DELETE FROM users"));
    it("multi-statement hidden after a comment-free split", () =>
        blocked("SELECT 1;UPDATE t SET x=1"));
    it("write keyword hidden in a block comment does not sneak a second statement", () =>
        blocked("SELECT 1; /* x */ DROP TABLE t"));
    it("non-allowed leading keyword", () => blocked("VACUUM"));
});
