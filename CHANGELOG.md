# Changelog

All notable changes to `@orphnet/d1-eloquent-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.2] - 2026-08-17

### Added

- `run_generate` tool - shells to the CLI's schema-diff `generate` command
  to write the migration that closes the gap between your models and the
  live D1 schema. 24 tools, 6 resources total.
- `d1-eloquent://docs/api/transactions` resource - `db.transaction()`
  batch transactions, including `tx.increment` / `tx.decrement`.

### Changed

- Doc resources realigned with the `@orphnet/d1-eloquent` public beta surface:
  increment/decrement, whereRelation/firstWhere, replicate, constrained
  eager loading, enumCast + onInvalidRead, withMin/withMax/withExists,
  intersect/except, date-part wheres, global scopes, hasManyThrough /
  hasOneThrough, prepared queries (prepare()/placeholder()).
- CLI shell-outs resolve the d1-eloquent binary bun-first (bunx, then
  npx as fallback) instead of npx-only.
- Server version is single-sourced from package.json instead of a
  hardcoded string.
- peerDependency floor set to the public npm release: `@orphnet/d1-eloquent` >= 0.1.0-beta.1.

### Removed

- `db` parameters that were accepted but silently ignored, dropped from
  five tool schemas (the CLI resolves the D1 binding from wrangler.jsonc).

## [0.1.0-beta.1] - 2026-05-30

No functional changes - promotes 0.1.0-alpha.2 to beta. Version bump
only (package.json and the reported server version).

## [0.1.0-alpha.2] - 2026-05-30

### Security

- Closed a read-only SQL guard bypass in `query_d1` (#1, `55a4582`).
  `ensureReadOnlySql` only checked the first keyword, so
  `WITH cte AS (...) DELETE FROM ...` passed the gate (a CTE can legally
  prefix DML in SQLite) and mutated the local D1; assignment-form PRAGMAs
  (`PRAGMA journal_mode = ...`) also slipped through. The guard now strips
  string literals and comments (handling SQLite `''` escaping), then
  rejects any write/DDL keyword anywhere outside a string/comment, plus
  assignment-form PRAGMA. Read PRAGMAs, `WITH ... SELECT`, `EXPLAIN`, and
  SELECTs that merely mention a keyword inside a string or column name
  remain allowed. Multi-statement detection now ignores trailing comments.

### Added

- First test suite: `src/cli.test.ts` (19 cases) plus a vitest config,
  so `bun run test` no longer exits non-zero with "no tests".

## [0.1.0-alpha.1] - 2026-05-17

### Added

- `validate_model` tool - compares a single model's declared shape
  (table, casts, softDeletes, timestamps, revisions, primary key)
  against the actual local D1 schema and returns drift as a list
  of severity-tagged issues.
- `validate_all` tool - runs `validate_model` across every discovered
  model and returns per-model reports plus a summary count
  (`{ ok, warn, fail, total }`).

Both tools use `PRAGMA table_info(<table>)` via the existing wrangler
shell helper. They report `schemaPresent: false` cleanly when the
table doesn't exist yet (e.g. migrations haven't run) rather than
throwing.

## [0.1.0-alpha.0] - 2026-05-17

### Added

Initial release.

- **21 tools** across introspection / generation / execution
- **5 resources** - project summary + 4 static API references
- **2 prompts** - `create-model`, `audit-schema`
- stdio transport
- Static project discovery (no user-code imports)
- Generation + execution shell out to the existing
  `@orphnet/d1-eloquent` CLI
- `query_d1` enforces read-only (SELECT / WITH / EXPLAIN / PRAGMA only)
- `read_file` refuses path traversal
- All shell-outs use `spawnSync` arg arrays - no shell injection
