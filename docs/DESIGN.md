# D1 Eloquent MCP Server - Design Document

> **As built:** the implementation is a flat `src/{index,server,discovery,cli}.ts`
> (no `tools/`, `resources/`, or `prompts/` subdirectories, no ERD tool, no
> config loader). The package structure and modules below are the original
> proposal, kept for design context.

## Understanding Summary

- **What:** An MCP server (`@orphnet/d1-eloquent-mcp`) that gives Claude deep, context-aware understanding of d1-eloquent projects
- **Why:** Enable any d1-eloquent user to get accurate AI assistance - correct API usage, project introspection, schema-aware generation, debugging, and CLI execution
- **Who:** Any developer using `@orphnet/d1-eloquent` with any Claude-compatible environment (Claude Code, VS Code, Cursor, Windsurf, JetBrains)
- **Delivery:** Separate npm package with peer dependency on `@orphnet/d1-eloquent`
- **Transport:** stdio (local), with remote option planned for later

## Non-Goals

- Remote/hosted MCP server (future)
- Remote D1 access (future)
- Replacing the existing documentation site

## Assumptions

- Users have `wrangler` installed and configured for local D1 access
- The MCP server runs locally on the user's machine
- `@orphnet/d1-eloquent` is already installed in the target project
- Users start the server pointing at a specific project directory

---

## Architecture

### Package Structure

```
@orphnet/d1-eloquent-mcp/
├── src/
│   ├── index.ts              # MCP server entry point (bin)
│   ├── server.ts             # Server setup & tool/resource/prompt registration
│   ├── discovery.ts          # Auto-discover project structure
│   ├── config.ts             # Load/merge user config overrides
│   ├── tools/
│   │   ├── introspection.ts  # list_models, read_model, inspect_schema, etc.
│   │   ├── generation.ts     # make_model, make_migration, etc.
│   │   ├── execution.ts      # migrate, rollback, fresh, seed
│   │   ├── query.ts          # query_d1 (local)
│   │   ├── validation.ts     # validate_model, check misconfigs
│   │   └── erd.ts            # generate_erd
│   ├── resources/
│   │   └── static.ts         # API reference docs, project summary
│   └── prompts/
│       └── workflows.ts      # Pre-built prompt templates
├── package.json
└── tsconfig.json
```

### Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@orphnet/d1-eloquent` - **peer dependency** (types, shared interfaces)
- `@mermaid-js/mermaid-cli` - **optional peer dependency** (SVG/PNG ERD rendering only)

### Startup Sequence

1. Parse `--project` arg (default: cwd)
2. Run auto-discovery (wrangler.toml, models, migrations, seeders, factories)
3. Load `.d1-eloquent.json` config override if present
4. Register all tools, resources, and prompts
5. Begin listening on stdio

---

## Configuration

### Claude Integration

Per-project (`.claude/mcp.json`):
```json
{
  "mcpServers": {
    "d1-eloquent": {
      "command": "npx",
      "args": ["@orphnet/d1-eloquent-mcp"]
    }
  }
}
```

Global (`~/.claude/mcp.json`):
```json
{
  "mcpServers": {
    "d1-eloquent": {
      "command": "npx",
      "args": ["@orphnet/d1-eloquent-mcp", "--project", "/path/to/project"]
    }
  }
}
```

When `--project` is omitted, defaults to current working directory.

### Project Config (`.d1-eloquent.json`, optional)

```json
{
  "paths": {
    "models": "src/db/models",
    "migrations": "src/db/migrations",
    "seeders": "src/db/seeders",
    "factories": "src/db/factories"
  },
  "db": "MY_DB",
  "permissions": {
    "autoApprove": ["make:*", "status"],
    "requireConfirmation": ["migrate", "rollback", "fresh", "seed"]
  }
}
```

### Project Discovery (Auto)

Scans for:
- `wrangler.toml` / `wrangler.jsonc` - D1 binding names and database IDs
- `**/models/**/*.ts` - classes extending `BaseModel`
- `**/migrations/**/*.ts` - migration files
- `**/seeders/**/*.ts` - seeder files
- `**/factories/**/*.ts` - factory files
- `package.json` - confirms `@orphnet/d1-eloquent` dependency

Discovery runs once on server start, cached in memory. Use `refresh_project` tool to re-scan.

---

## Tools

### Introspection (read-only, always safe)

| Tool | Purpose | Input |
|------|---------|-------|
| `list_models` | List all discovered models with table names, key features (soft deletes, revisions, etc.) | none |
| `read_model` | Return full model source + parsed metadata (casts, relationships, accessors, static config) | `{ name }` |
| `list_migrations` | List all migration files with timestamps and names | none |
| `read_migration` | Return migration source code | `{ name }` |
| `migration_status` | Run `status` command - show which migrations have run vs pending | `{ db? }` |
| `inspect_schema` | Query local D1 `sqlite_master` to show actual table definitions | `{ db?, table? }` |
| `query_d1` | Run a read-only SQL query against local D1 | `{ sql, db? }` |
| `list_seeders` | List discovered seeder files | none |
| `list_factories` | List discovered factory files | none |
| `read_file` | Read any project file (seeder, factory, config) | `{ path }` |
| `refresh_project` | Re-run discovery, update cached project state | none |

`query_d1` enforces read-only by rejecting statements starting with INSERT, UPDATE, DELETE, DROP, ALTER, CREATE.

### Validation (read-only, analytical)

| Tool | Purpose | Input |
|------|---------|-------|
| `validate_model` | Check a model for misconfigs - missing casts, wrong relationship setup, missing columns | `{ name }` |
| `validate_all` | Run validation across all models | none |

### Generation (creates files)

| Tool | Purpose | Input |
|------|---------|-------|
| `make_model` | Generate model file | `{ name, softDeletes? }` |
| `make_migration` | Generate migration file | `{ name }` |
| `make_seeder` | Generate seeder file | `{ name }` |
| `make_factory` | Generate factory file | `{ name }` |
| `make_resource` | Generate model + migration + seeder + factory | `{ name, softDeletes? }` |
| `make_pivot` | Generate pivot migration | `{ table }` |

### Execution (modify database state)

| Tool | Purpose | Input |
|------|---------|-------|
| `run_migrate` | Run pending migrations | `{ db? }` |
| `run_rollback` | Rollback last migration batch | `{ db? }` |
| `run_fresh` | Drop all + re-migrate | `{ db? }` |
| `run_seed` | Run seeders | `{ db?, seeder? }` |

### ERD

| Tool | Purpose | Input |
|------|---------|-------|
| `generate_erd` | Generate ERD from discovered models | `{ format?: "mermaid" \| "svg" \| "png", output?: string, models?: string[], detail?: "basic" \| "full" \| "relationships" }` |

**Detail levels:**
- **`basic`** (default) - tables, columns, types, foreign key relationships only
- **`full`** - adds PKs, indexes, nullable markers, soft delete / revision indicators
- **`relationships`** - adds cardinality labels from model relationship definitions (includes everything from `full`)

**Format behavior:**
- `mermaid` (default) - returns diagram text as tool result; optionally writes to file via `output`
- `svg` / `png` - renders via `@mermaid-js/mermaid-cli` (`mmdc`), writes to `output` path (required)

---

## Resources

Static context Claude can pull in as background knowledge.

| Resource URI | Content |
|---|---|
| `d1-eloquent://api/base-model` | BaseModel API reference - static props, instance methods, signatures |
| `d1-eloquent://api/query-builder` | QueryBuilder API - chainable methods, terminal methods, signatures |
| `d1-eloquent://api/relationships` | Relationship helpers - belongsTo, hasMany, hasOne, belongsToMany, eager loading |
| `d1-eloquent://api/schema-builder` | Schema/TableBuilder API for migrations |
| `d1-eloquent://api/revisions` | Revision system - config options, modes, time-travel API |
| `d1-eloquent://api/casting` | Cast types, custom casts, CastManager |
| `d1-eloquent://guide/quick-start` | Quick start guide |
| `d1-eloquent://project/summary` | Dynamic - discovered project state (models, migration count, db bindings) |

Resources 1–7 are static (bundled from existing docs). Resource 8 is dynamic (generated from discovery).

---

## Prompts

Pre-built prompt templates for common multi-step workflows.

| Prompt | Purpose | Arguments |
|---|---|---|
| `create-model` | Guide through creating a new model with migration, seeder, factory | `{ name, description? }` |
| `debug-model` | Investigate a model - read source, validate config, check schema alignment | `{ name }` |
| `write-migration` | Describe a schema change in plain English, get a correct migration | `{ description }` |
| `audit-schema` | Compare all models against actual D1 schema, report drift | none |
| `explain-feature` | Explain how a d1-eloquent feature works with examples from the user's project | `{ feature }` |

---

## Technical Details

### Model Parsing

Static parsing (regex/AST) of model files - no importing user modules. Extracts:
- Class name, `extends BaseModel<...>`
- Static properties: `table`, `primaryKey`, `casts`, `softDeletes`, `revisions`, `timestamps`, `hidden`, `appends`
- Relationship methods
- Accessor/mutator definitions

### D1 Querying

Uses `wrangler d1 execute <DB_NAME> --local --json --command "<SQL>"` via child process:
- Parses JSON output for structured results
- 10-second timeout
- Read-only enforcement at tool level

### CLI Execution

Shells out to existing CLI: `npx @orphnet/d1-eloquent <command> --db <DB_NAME> --local`
- Working directory set to user's project path
- Stdout/stderr captured and returned as tool results

### Error Handling

All tools return structured results:
```typescript
{ success: true, data: ... }
{ success: false, error: { code: string, message: string } }
```

### Permissions

Configurable via `.d1-eloquent.json`. Defaults:
- **Auto-approve:** introspection, validation, generation (`make:*`), `status`, `generate_erd`
- **Require confirmation:** `migrate`, `rollback`, `fresh`, `seed`

---

## Decision Log

| # | Decision | Alternatives Considered | Rationale |
|---|----------|------------------------|-----------|
| 1 | MCP server (not skill) | Claude Code skill | MCP works across all Claude interfaces |
| 2 | Separate package `@orphnet/d1-eloquent-mcp` | Built into main package | Avoids duplicate copies across 20-50 projects |
| 3 | Tool-heavy approach with supplementary prompts/resources | Resource-heavy, prompt-heavy | Most flexible and composable; works across all clients |
| 4 | Auto-discovery + config override | Convention-only, config-only | Zero-setup for standard layouts, escape hatch for custom structures |
| 5 | Configurable CLI permissions | Full auto-approve, always confirm | Users control risk tolerance; safe defaults |
| 6 | Local D1 first, remote later | Both from start, static-only | Safe development; remote adds auth complexity |
| 7 | Static model parsing (regex/AST) | Import user modules | Avoids needing user's build chain |
| 8 | Shell out to existing CLI | Reimplement CLI logic | Reuses tested commands; no duplication |
| 9 | Shell out to `wrangler d1 execute` | Link D1 runtime directly | Works with user's existing wrangler setup |
| 10 | stdio transport | SSE, HTTP | Standard for local MCP; universal client support |
| 11 | `@modelcontextprotocol/sdk` as only runtime dep | Custom protocol implementation | Official SDK, maintained |
| 12 | Peer dependency on main package | Bundle it, hard dep | User already has it installed; avoids version conflicts |
| 13 | Three ERD detail levels, basic as default | Always full detail | Keeps ERDs readable for large schemas; opt into complexity |
| 14 | Mermaid text + mmdc for images | Direct SVG generation, Graphviz | Mermaid readable as text + renderable; mmdc handles image pipeline |
| 15 | mmdc as optional peer dep | Bundle it, hard dep | ~100MB package; only needed for image output |
