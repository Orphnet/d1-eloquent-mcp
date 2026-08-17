# @orphnet/d1-eloquent-mcp

MCP server that gives Claude (and any [Model Context Protocol](https://modelcontextprotocol.io)–compatible client) live, context-aware access to your **[d1-eloquent](https://d1-eloquent.orph.dev)** project - models, migrations, schema, seeders, factories, and the CLI.

```bash
bunx @orphnet/d1-eloquent-mcp
```

## What it gives Claude

24 tools, 6 resources, 2 prompts.

**Introspection (read-only)**
- `list_models` · `read_model` · `list_migrations` · `read_migration` · `migration_status`
- `inspect_schema` - query `sqlite_master` to see what's actually in your D1
- `query_d1` - read-only SQL against the local D1 (SELECT/WITH/EXPLAIN/PRAGMA only)
- `list_seeders` · `list_factories` · `read_file` · `refresh_project`
- `validate_model` · `validate_all` - compare declared model shape against the actual schema, report drift

**Generation** (delegates to the d1-eloquent CLI)
- `make_model` · `make_migration` · `make_seeder` · `make_factory`
- `make_resource` - model + migration + seeder + factory in one go
- `make_pivot`

**Execution** (delegates to the d1-eloquent CLI, local D1 by default)
- `run_migrate` · `run_rollback` · `run_fresh` · `run_seed`
- `run_generate` - schema-diff: write the migration that closes the gap between your models and the live schema

**Resources** - Claude can pull these in as background context
- `d1-eloquent://project/summary` - your project's discovered state
- `d1-eloquent://docs/api/base-model`
- `d1-eloquent://docs/api/query-builder`
- `d1-eloquent://docs/api/relationships`
- `d1-eloquent://docs/api/transactions`
- `d1-eloquent://docs/guide/quick-start`

**Prompts** - pre-built multi-step workflows
- `create-model` - scaffold + migrate + verify in one chat
- `audit-schema` - compare every model against the actual D1 schema, report drift

## Install

### Claude Code

```bash
claude mcp add d1-eloquent -- bunx @orphnet/d1-eloquent-mcp
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "d1-eloquent": {
      "command": "bunx",
      "args": ["@orphnet/d1-eloquent-mcp"]
    }
  }
}
```

### Per-project (Claude Code)

`.claude/mcp.json`:

```json
{
  "mcpServers": {
    "d1-eloquent": {
      "command": "bunx",
      "args": ["@orphnet/d1-eloquent-mcp"]
    }
  }
}
```

To point at a project that isn't the current directory:

```json
{
  "mcpServers": {
    "d1-eloquent": {
      "command": "bunx",
      "args": ["@orphnet/d1-eloquent-mcp", "--project", "/path/to/your/d1-eloquent-project"]
    }
  }
}
```

## Requirements

- Node.js ≥ 22
- `wrangler` installed and authenticated for D1 access (`bun add -D wrangler`)
- An existing `@orphnet/d1-eloquent` project - the server discovers models/migrations/seeders by scanning your file tree

## Safety

- `query_d1` rejects anything other than `SELECT` / `WITH` / `EXPLAIN` / `PRAGMA`, and rejects multi-statement payloads.
- `read_file` refuses paths containing `..` or starting with `/`.
- Generation tools shell out to your existing d1-eloquent CLI - they don't ship their own writers.
- Execution tools (`run_migrate` / `run_rollback` / `run_fresh` / `run_seed`) only operate on the **local** D1 by default. For remote, run via the CLI directly.

## License

MIT
