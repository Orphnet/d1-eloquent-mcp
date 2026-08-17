/**
 * MCP server setup — registers tools, resources, prompts.
 * The full set per DESIGN-MCP.md, organized as:
 *   - Introspection (read-only, always safe)
 *   - Generation (creates files via the existing CLI)
 *   - Execution (modifies DB state via the existing CLI)
 *
 * Uses the stdio transport so it works in Claude Code, Claude Desktop,
 * Cursor, Windsurf, and any other MCP-compatible client.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { discoverProject, type ProjectInfo } from "./discovery.js";
import { runCli, runWranglerD1Query, ensureReadOnlySql } from "./cli.js";

interface ServerContext {
    project: ProjectInfo;
    projectRoot: string;
}

let ctx: ServerContext;

function ok(data: unknown) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, data }, null, 2) }],
    };
}

function err(code: string, message: string) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: { code, message } }, null, 2) }],
        isError: true,
    };
}

const TOOLS = [
    // ── Introspection ───────────────────────────────────────────────
    {
        name: "list_models",
        description:
            "List all discovered BaseModel subclasses in the project, with table names and feature flags (soft deletes, revisions, relationships, casts). Read-only.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "read_model",
        description:
            "Return the full source code of a model file plus parsed metadata (relations, casts, static config). Read-only.",
        inputSchema: {
            type: "object" as const,
            properties: { name: { type: "string", description: "Model class name (e.g. 'User')" } },
            required: ["name"],
        },
    },
    {
        name: "list_migrations",
        description: "List all discovered migration files with timestamps. Read-only.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "read_migration",
        description: "Return the source of a migration file. Read-only.",
        inputSchema: {
            type: "object" as const,
            properties: { name: { type: "string", description: "Migration name (with or without timestamp prefix)" } },
            required: ["name"],
        },
    },
    {
        name: "migration_status",
        description:
            "Run `d1-eloquent status` against the local D1 - shows which migrations have run vs pending. Read-only. The CLI resolves the D1 binding from wrangler config automatically.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "inspect_schema",
        description:
            "Query the local D1 `sqlite_master` to list every table + the column definitions actually applied. Read-only.",
        inputSchema: {
            type: "object" as const,
            properties: {
                db: { type: "string", description: "D1 binding name (default: auto-detect)" },
                table: { type: "string", description: "Optional table to scope to" },
            },
        },
    },
    {
        name: "query_d1",
        description:
            "Run a read-only SQL query (SELECT / WITH / EXPLAIN / PRAGMA only) against the local D1. Multi-statement payloads and writes are rejected.",
        inputSchema: {
            type: "object" as const,
            properties: {
                sql: { type: "string", description: "Read-only SQL statement" },
                db: { type: "string", description: "D1 binding name (default: auto-detect)" },
            },
            required: ["sql"],
        },
    },
    {
        name: "list_seeders",
        description: "List discovered seeder files. Read-only.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "list_factories",
        description: "List discovered factory files. Read-only.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "read_file",
        description: "Read any project file by path (relative to project root). Read-only.",
        inputSchema: {
            type: "object" as const,
            properties: { path: { type: "string", description: "Relative project path" } },
            required: ["path"],
        },
    },
    {
        name: "refresh_project",
        description: "Re-run project discovery, update cached state.",
        inputSchema: { type: "object" as const, properties: {} },
    },

    // ── Validation ──────────────────────────────────────────────────
    {
        name: "validate_model",
        description:
            "Compare a single model's declared shape (table, casts, softDeletes, timestamps, revisions) against the actual local D1 schema and return any drift as a list of issues.",
        inputSchema: {
            type: "object" as const,
            properties: { name: { type: "string", description: "Model class name" } },
            required: ["name"],
        },
    },
    {
        name: "validate_all",
        description:
            "Run validate_model across every discovered model. Returns per-model issues and a summary count of ok / warn / fail.",
        inputSchema: { type: "object" as const, properties: {} },
    },

    // ── Generation ──────────────────────────────────────────────────
    {
        name: "make_model",
        description: "Scaffold a new model file. Delegates to `d1-eloquent make:model`.",
        inputSchema: {
            type: "object" as const,
            properties: {
                name: { type: "string", description: "Model class name (e.g. 'Post')" },
                softDeletes: { type: "boolean", description: "Enable soft deletes" },
            },
            required: ["name"],
        },
    },
    {
        name: "make_migration",
        description: "Scaffold a new migration. Delegates to `d1-eloquent make:migration`.",
        inputSchema: {
            type: "object" as const,
            properties: { name: { type: "string", description: "Migration name (snake_case)" } },
            required: ["name"],
        },
    },
    {
        name: "make_seeder",
        description: "Scaffold a new seeder. Delegates to `d1-eloquent make:seeder`.",
        inputSchema: {
            type: "object" as const,
            properties: { name: { type: "string", description: "Seeder name" } },
            required: ["name"],
        },
    },
    {
        name: "make_factory",
        description: "Scaffold a new factory. Delegates to `d1-eloquent make:factory`.",
        inputSchema: {
            type: "object" as const,
            properties: { name: { type: "string", description: "Factory name" } },
            required: ["name"],
        },
    },
    {
        name: "make_resource",
        description: "Scaffold model + migration + seeder + factory in one go. Delegates to `d1-eloquent make:resource`.",
        inputSchema: {
            type: "object" as const,
            properties: {
                name: { type: "string", description: "Resource name (e.g. 'Post')" },
                softDeletes: { type: "boolean" },
            },
            required: ["name"],
        },
    },
    {
        name: "make_pivot",
        description: "Scaffold a pivot table migration. Delegates to `d1-eloquent make:pivot`.",
        inputSchema: {
            type: "object" as const,
            properties: { table: { type: "string", description: "Pivot table name" } },
            required: ["table"],
        },
    },
    {
        name: "run_generate",
        description:
            "Diff models against the project's migrations (schema diff) and report what a reconciling migration would change. Dry-run by default: prints per-model added/dropped/type-changed columns and writes NOTHING. Pass write=true to emit migration file(s) into the project's migrations directory (review them, then run_migrate). Delegates to `d1-eloquent generate`.",
        inputSchema: {
            type: "object" as const,
            properties: {
                model: { type: "string", description: "Limit the diff to one model (class/file name, e.g. 'User'). Default: every model." },
                write: { type: "boolean", description: "Emit reconciling migration file(s). Default false (dry-run diff only)." },
                name: { type: "string", description: "Custom migration name (used when exactly one file is written)." },
            },
        },
    },

    // ── Execution (modifies DB) ─────────────────────────────────────
    {
        name: "run_migrate",
        description: "Apply pending migrations. Delegates to `d1-eloquent migrate` against local D1.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "run_rollback",
        description: "Roll back the last migration batch. Delegates to `d1-eloquent rollback`.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "run_fresh",
        description: "Drop all tables and re-run every migration. Delegates to `d1-eloquent fresh --force`.",
        inputSchema: { type: "object" as const, properties: {} },
    },
    {
        name: "run_seed",
        description: "Run seeders. Delegates to `d1-eloquent seed`.",
        inputSchema: {
            type: "object" as const,
            properties: {
                seeder: { type: "string", description: "Specific seeder name (optional)" },
            },
        },
    },
];

const RESOURCES = [
    { uri: "d1-eloquent://project/summary",      name: "Project summary",     mimeType: "application/json",
      description: "Discovered project state: models, migrations, seeders, factories, D1 bindings." },
    { uri: "d1-eloquent://docs/api/base-model",  name: "BaseModel API",       mimeType: "text/markdown" },
    { uri: "d1-eloquent://docs/api/query-builder", name: "QueryBuilder API",  mimeType: "text/markdown" },
    { uri: "d1-eloquent://docs/api/relationships", name: "Relationships API", mimeType: "text/markdown" },
    { uri: "d1-eloquent://docs/api/transactions",  name: "Transactions API",  mimeType: "text/markdown" },
    { uri: "d1-eloquent://docs/guide/quick-start", name: "Quick start guide", mimeType: "text/markdown" },
];

const PROMPTS = [
    {
        name: "create-model",
        description: "Multi-step walkthrough to scaffold a new model + its migration + seeder + factory, then verify.",
        arguments: [
            { name: "name", description: "Model class name (e.g. 'Post')", required: true },
            { name: "description", description: "What the model represents", required: false },
        ],
    },
    {
        name: "audit-schema",
        description: "Compare every model in the project against the actual D1 schema and report drift.",
        arguments: [],
    },
];

function dbBinding(explicit?: string): string {
    if (explicit) return explicit;
    return ctx.project.d1Bindings[0]?.binding ?? "DB";
}

interface ValidateIssue {
    severity: "warn" | "fail";
    code: string;
    message: string;
}

interface ValidateReport {
    name: string;
    table?: string;
    severity: "ok" | "warn" | "fail";
    issues: ValidateIssue[];
    schemaPresent: boolean;
}

/**
 * Best-effort drift check between a model's declared shape and the
 * actual local D1 schema. Queries `PRAGMA table_info(<table>)` via the
 * existing wrangler shell helper. If the wrangler call fails (D1 not
 * migrated yet, binding missing, etc.) the model is reported as
 * `schemaPresent: false` with a single fail issue — useful signal
 * rather than a hard error.
 */
function validateOne(meta: import("./discovery.js").ModelInfo): ValidateReport {
    const issues: ValidateIssue[] = [];
    const tableName = meta.table;
    if (!tableName) {
        issues.push({ severity: "fail", code: "no_table", message: `Model '${meta.name}' has no static table = '...' declaration.` });
        return { name: meta.name, severity: "fail", issues, schemaPresent: false };
    }

    const db = dbBinding();
    const sql = `PRAGMA table_info('${tableName.replace(/'/g, "''")}')`;
    const r = runWranglerD1Query(db, sql, ctx.project.root, { remote: false, timeoutMs: 10_000 });

    if (!r.success) {
        issues.push({
            severity: "fail",
            code: "schema_unreachable",
            message: `Could not reach the local D1 for table '${tableName}'. Have you run migrations? wrangler stderr: ${(r.stderr || "").slice(0, 200)}`,
        });
        return { name: meta.name, table: tableName, severity: "fail", issues, schemaPresent: false };
    }

    // wrangler --json output: try to parse the columns out
    const columnNames = new Set<string>();
    try {
        const parsed = JSON.parse(r.stdout) as Array<{ results?: Array<{ name?: string }> }>;
        const rows = parsed.flatMap((p) => p.results ?? []);
        for (const row of rows) {
            if (typeof row.name === "string") columnNames.add(row.name);
        }
    } catch {
        // best-effort fallback: regex over the raw stdout
        for (const m of r.stdout.matchAll(/"name"\s*:\s*"([^"]+)"/g)) columnNames.add(m[1]);
    }

    if (columnNames.size === 0) {
        issues.push({
            severity: "fail",
            code: "table_missing",
            message: `Table '${tableName}' has no columns in the local D1 (table likely not migrated yet).`,
        });
        return { name: meta.name, table: tableName, severity: "fail", issues, schemaPresent: false };
    }

    // Timestamps
    if (meta.timestamps !== false) {
        if (!columnNames.has("created_at")) {
            issues.push({ severity: "warn", code: "missing_created_at", message: `'timestamps' is on but '${tableName}.created_at' is missing.` });
        }
        if (!columnNames.has("updated_at")) {
            issues.push({ severity: "warn", code: "missing_updated_at", message: `'timestamps' is on but '${tableName}.updated_at' is missing.` });
        }
    }

    // Soft deletes
    if (meta.softDeletes && !columnNames.has("deleted_at")) {
        issues.push({ severity: "fail", code: "missing_deleted_at", message: `'softDeletes = true' but '${tableName}.deleted_at' is missing.` });
    }

    // Primary key
    if (meta.primaryKey && !columnNames.has(meta.primaryKey)) {
        issues.push({ severity: "fail", code: "missing_pk", message: `Primary key column '${meta.primaryKey}' is missing from '${tableName}'.` });
    }

    // Cast columns
    for (const col of meta.casts ?? []) {
        if (!columnNames.has(col)) {
            issues.push({ severity: "warn", code: "missing_cast_col", message: `Cast declared for '${col}' but no such column on '${tableName}'.` });
        }
    }

    // Revisions side table — checked only when revisions are enabled.
    // PRAGMA table_info doesn't tell us which OTHER tables exist; check via a
    // second query if revisions=true on this model.
    if (meta.revisions) {
        const revR = runWranglerD1Query(
            db,
            "SELECT name FROM sqlite_master WHERE type='table' AND name='model_revisions'",
            ctx.project.root,
            { remote: false, timeoutMs: 5_000 },
        );
        if (!revR.success || !/model_revisions/.test(revR.stdout)) {
            issues.push({
                severity: "fail",
                code: "missing_revisions_table",
                message: `'revisions.enabled = true' on this model but the shared 'model_revisions' table is missing from D1.`,
            });
        }
    }

    let severity: ValidateReport["severity"] = "ok";
    if (issues.some((i) => i.severity === "fail")) severity = "fail";
    else if (issues.length > 0) severity = "warn";

    return { name: meta.name, table: tableName, severity, issues, schemaPresent: true };
}

function findModelFile(name: string): { abs: string; rel: string } | null {
    const m = ctx.project.models.find((x) => x.name === name);
    if (!m) return null;
    return { abs: join(ctx.project.root, m.file), rel: m.file };
}

function findMigrationFile(name: string): { abs: string; rel: string } | null {
    const norm = name.replace(/\.ts$/, "");
    const m = ctx.project.migrations.find((x) => x.name === norm || x.name.endsWith("_" + norm) || x.name.endsWith("-" + norm));
    if (!m) return null;
    return { abs: join(ctx.project.root, m.file), rel: m.file };
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<ReturnType<typeof ok>> {
    switch (name) {
        // ── Introspection ───────────────────────────────────────────
        case "list_models":
            return ok({ count: ctx.project.models.length, models: ctx.project.models });

        case "read_model": {
            const modelName = String(args.name ?? "");
            const found = findModelFile(modelName);
            if (!found) return err("not_found", `No model named '${modelName}'. Try refresh_project.`);
            const meta = ctx.project.models.find((x) => x.name === modelName);
            return ok({ ...meta, source: readFileSync(found.abs, "utf8") });
        }

        case "list_migrations":
            return ok({ count: ctx.project.migrations.length, migrations: ctx.project.migrations });

        case "read_migration": {
            const migName = String(args.name ?? "");
            const found = findMigrationFile(migName);
            if (!found) return err("not_found", `No migration named '${migName}'.`);
            return ok({ file: found.rel, source: readFileSync(found.abs, "utf8") });
        }

        case "migration_status": {
            const r = runCli(["status"], ctx.project.root, 30_000);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "inspect_schema": {
            const db = dbBinding(args.db as string | undefined);
            const tbl = args.table as string | undefined;
            const sql = tbl
                ? `SELECT type, name, sql FROM sqlite_master WHERE name = '${tbl.replace(/'/g, "''")}'`
                : "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','view') ORDER BY type, name";
            const r = runWranglerD1Query(db, sql, ctx.project.root, { remote: false });
            return ok({ db, raw: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "query_d1": {
            const sql = String(args.sql ?? "");
            const safe = ensureReadOnlySql(sql);
            if (!safe.ok) return err("forbidden", safe.reason);
            const db = dbBinding(args.db as string | undefined);
            const r = runWranglerD1Query(db, sql, ctx.project.root, { remote: false });
            return ok({ db, sql, raw: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "list_seeders":
            return ok({ count: ctx.project.seeders.length, seeders: ctx.project.seeders });

        case "list_factories":
            return ok({ count: ctx.project.factories.length, factories: ctx.project.factories });

        case "read_file": {
            const path = String(args.path ?? "");
            if (!path || path.includes("..") || path.startsWith("/")) {
                return err("forbidden", "Path must be relative to project root and not contain '..'.");
            }
            try {
                return ok({ path, content: readFileSync(join(ctx.project.root, path), "utf8") });
            } catch (e) {
                return err("io", `Cannot read '${path}': ${(e as Error).message}`);
            }
        }

        case "refresh_project":
            ctx.project = discoverProject(ctx.projectRoot);
            return ok({
                refreshed: true,
                counts: {
                    models: ctx.project.models.length,
                    migrations: ctx.project.migrations.length,
                    seeders: ctx.project.seeders.length,
                    factories: ctx.project.factories.length,
                },
            });

        // ── Validation ──────────────────────────────────────────────
        case "validate_model": {
            const modelName = String(args.name ?? "");
            const meta = ctx.project.models.find((x) => x.name === modelName);
            if (!meta) return err("not_found", `No model named '${modelName}'.`);
            const report = validateOne(meta);
            return ok(report);
        }

        case "validate_all": {
            const reports = ctx.project.models.map((m) => validateOne(m));
            const summary = {
                ok: reports.filter((r) => r.severity === "ok").length,
                warn: reports.filter((r) => r.severity === "warn").length,
                fail: reports.filter((r) => r.severity === "fail").length,
                total: reports.length,
            };
            return ok({ summary, reports });
        }

        // ── Generation ──────────────────────────────────────────────
        case "make_model": {
            const modelName = String(args.name ?? "");
            if (!modelName) return err("validation", "name required");
            const cliArgs = ["make:model", modelName];
            if (args.softDeletes) cliArgs.push("--soft-deletes");
            const r = runCli(cliArgs, ctx.project.root);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "make_migration": {
            const migName = String(args.name ?? "");
            if (!migName) return err("validation", "name required");
            const r = runCli(["make:migration", migName], ctx.project.root);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "make_seeder": {
            const seedName = String(args.name ?? "");
            if (!seedName) return err("validation", "name required");
            const r = runCli(["make:seeder", seedName], ctx.project.root);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "make_factory": {
            const facName = String(args.name ?? "");
            if (!facName) return err("validation", "name required");
            const r = runCli(["make:factory", facName], ctx.project.root);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "make_resource": {
            const resName = String(args.name ?? "");
            if (!resName) return err("validation", "name required");
            const cliArgs = ["make:resource", resName];
            if (args.softDeletes) cliArgs.push("--soft-deletes");
            const r = runCli(cliArgs, ctx.project.root);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "make_pivot": {
            const table = String(args.table ?? "");
            if (!table) return err("validation", "table required");
            const r = runCli(["make:pivot", table], ctx.project.root);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "run_generate": {
            const model = args.model as string | undefined;
            const name = args.name as string | undefined;
            const cliArgs = ["generate"];
            if (model) cliArgs.push(model);
            if (args.write) cliArgs.push("--write");
            if (name) cliArgs.push(`--name=${name}`);
            const r = runCli(cliArgs, ctx.project.root, 60_000);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success, wrote: Boolean(args.write) });
        }

        // ── Execution ───────────────────────────────────────────────
        case "run_migrate": {
            const r = runCli(["migrate"], ctx.project.root, 60_000);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "run_rollback": {
            const r = runCli(["rollback"], ctx.project.root, 60_000);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "run_fresh": {
            const r = runCli(["fresh", "--force"], ctx.project.root, 120_000);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }

        case "run_seed": {
            const seeder = args.seeder as string | undefined;
            const cliArgs = ["seed"];
            if (seeder) cliArgs.push(seeder);
            const r = runCli(cliArgs, ctx.project.root, 60_000);
            return ok({ stdout: r.stdout, stderr: r.stderr, success: r.success });
        }
    }
    return err("unknown_tool", `Tool '${name}' not registered.`);
}

const STATIC_DOCS: Record<string, string> = {
    "d1-eloquent://docs/api/base-model": `# BaseModel API

Static config:
- \`static table: string\` - table name
- \`static primaryKey = 'id'\` - TEXT primary key by default
- \`static timestamps = true\` - auto created_at/updated_at
- \`static softDeletes = false\` - set true + add \`t.softDeletes()\` to migration
- \`static fillable: string[]\` OR \`static guarded: string[]\` - mass-assignment policy
- \`static casts = { col: 'json' | 'boolean' | 'integer' | 'real' | 'datetime' | 'date' | 'timestamp' | 'array' | 'blob' | enumCast([...]) }\`
  - \`enumCast(values, { onInvalidRead: 'throw' | 'null' | 'keep' })\` - runtime-validated enum column ('throw' is the default; 'null'/'keep' tolerate legacy rows on read)
- \`static relations\` - declarative \`belongsTo\` / \`hasMany\` / \`hasOne\` / \`belongsToMany\` / \`hasManyThrough\` / \`hasOneThrough\` / \`morphTo\` / \`morphMany\` / \`morphOne\` / \`morphToMany\` / \`morphedByMany\`
- \`static scopes\` - named query scopes, applied per query with \`query().scoped('name')\`
- \`static globalScopes\` - scopes auto-applied to EVERY query; opt out per query with \`withoutGlobalScope(name)\` / \`withoutGlobalScopes()\`
- \`static hooks\` - \`creating\`, \`created\`, \`updating\`, \`updated\`, \`saving\`, \`saved\`, \`deleting\`, \`deleted\`
- \`static revisions = { enabled, mode, includeRequestId }\` - audit log

Instance:
- \`get(key)\` / \`set(key, value)\` / \`fill(values)\` / \`forceFill(values)\`
- \`save(opts?)\` / \`delete(opts?)\` / \`restore()\` / \`refresh()\` / \`fresh()\`
- \`replicate(except?)\` - unsaved copy with PK, timestamps and (soft-delete) deleted_at stripped; \`except\` lists extra columns to strip
- \`increment(column, amount?, extra?)\` / \`decrement(column, amount?, extra?)\` - atomic counter step on this row (\`extra\` = additional columns to SET in the same UPDATE)
- \`related(name)\` - lazy relation accessor
- \`attach(name, ids)\` / \`detach(name, ids?)\` / \`sync(name, ids)\` / \`toggle(name, ids)\` - pivot sugar
- \`load(...relations)\` - eager-load after fetch
- \`isDirty(key?)\` / \`getDirty()\` / \`getChanges()\` / \`wasChanged(key?)\` / \`trashed()\` / \`is(other)\` / \`isNot(other)\`
- \`toObject()\` / \`toJSON()\` / \`toRaw()\`

Static:
- \`create(attrs, opts?)\` / \`createMany(rows, opts?)\`
- \`find(id)\` / \`findOrFail(id)\` / \`all()\`
- \`firstOrCreate(search, values?)\` / \`firstOrNew(search, values?)\` / \`updateOrCreate(search, values?)\`
- \`query()\` - fluent query builder entry
- \`transaction(db, tx => ...)\` - atomic multi-model unit of work (see the transactions doc)
- \`asOf(id, isoTimestamp)\` - time-travel reconstruction (revisions enabled)
`,
    "d1-eloquent://docs/api/query-builder": `# QueryBuilder API

Filters: \`where\` \`orWhere\` \`whereEq\` \`whereLike\` \`whereIn\` \`whereNotIn\` (arrays or subquery builders) \`whereNull\` \`whereNotNull\` \`whereBetween\` \`whereNotBetween\` \`whereRaw\` \`whereGroup\` \`whereColumn\` \`when(cond, fn)\` \`whereExists\` \`whereNotExists\`
Date parts: \`whereDate\` \`whereTime\` \`whereYear\` \`whereMonth\` \`whereDay\`
Soft deletes: \`withTrashed()\` \`onlyTrashed()\`
Scopes: \`scoped(...names)\` applies named \`static scopes\`; \`withoutGlobalScope(name)\` / \`withoutGlobalScopes()\` skip \`static globalScopes\` for this query
Shape: \`select\` \`selectRaw\` \`selectSub\` \`distinct\` \`join\` \`leftJoin\` \`groupBy\` \`having\` \`havingRaw\` \`union\` \`unionAll\` \`intersect\` \`except\` \`orderBy\` \`limit\` \`offset\` \`from\` \`indexedBy\` \`notIndexed\`
FTS5: \`whereMatch\` \`orderByRank\`
JSON: \`whereJsonPath\` \`whereJsonContains\` \`whereJsonLength\` \`selectJsonExtract\` \`selectJsonGroupArray\` \`selectJsonGroupObject\` \`orderByJsonPath\`
JSON updates: \`updateJsonSet\` \`updateJsonPatch\` \`updateJsonRemove\`
CTEs: \`withCte\` \`withRecursive\`
Relations: \`with(['posts'])\` or constrained \`with({ posts: q => q.whereEq('published', true).limit(5) })\` \`has\` \`doesntHave\` \`whereHas\` \`whereDoesntHave\` \`whereRelation(relation, column, opOrValue, value?)\` \`withCount\` \`withSum\` \`withAvg\` \`withMin\` \`withMax\` \`withExists\`
Atomic counters: \`increment(column, amount?, extra?)\` \`decrement(column, amount?, extra?)\` - query-scoped \`SET col = COALESCE(col, 0) +/- ?\`, returns changed-row count
Sessions: \`withSession('first-unconstrained' | 'first-primary' | bookmark)\` \`getBookmark()\`
RETURNING: \`insertReturning\` \`updateReturning\` \`deleteReturning\`
Prepared queries: use \`placeholder('name')\` as a filter value, call \`prepare(db?)\` once, then execute the returned \`PreparedQuery\` repeatedly with \`.get({ name: value })\` / \`.first({ name: value })\`
Pagination: \`paginate(page, perPage)\` \`paginateCursor({ orderBy, direction, perPage, after?, before? })\`
Terminals: \`get(db?)\` \`first(db?)\` \`firstWhere(column, opOrValue, value?)\` \`firstOrFail()\` \`pluck(col)\` \`value(col)\` \`count\` \`sum\` \`avg\` \`min\` \`max\` \`chunk(size, fn)\`
Meta: \`lastMeta()\` \`getWithMeta()\` \`firstWithMeta()\`

Gotcha: \`count()\` mutates the builder's SELECT - never reuse one builder for \`count()\` then \`get()\`; build the filtered query twice or use \`paginate()\`.
`,
    "d1-eloquent://docs/api/relationships": `# Relationships

Declarative on the model:

\`\`\`ts
static relations: Record<string, TRelationDefinition> = {
  author:  { type: 'belongsTo',     model: () => User, foreignKey: 'author_id' },
  posts:   { type: 'hasMany',       model: () => Post, foreignKey: 'user_id' },
  profile: { type: 'hasOne',        model: () => Profile, foreignKey: 'user_id' },
  tags:    { type: 'belongsToMany', model: () => Tag, pivot: 'post_tags',
              foreignPivotKey: 'post_id', relatedPivotKey: 'tag_id' },
  // Through an intermediate model: Country -> Users -> Posts
  posts2:  { type: 'hasManyThrough', model: () => Post, through: () => User,
              firstKey: 'country_id',  // FK on the through table referencing THIS model
              secondKey: 'user_id' },  // FK on the related table referencing the through model
  latest:  { type: 'hasOneThrough',  model: () => Post, through: () => User,
              firstKey: 'country_id', secondKey: 'user_id' },
  // Polymorphic
  comments: { type: 'morphMany', model: () => Comment, morphName: 'commentable', typeValue: 'post' },
  subject:  { type: 'morphTo',   model: () => null, morphName: 'subject' },
  taggable: { type: 'morphToMany', model: () => Tag, pivot: 'taggables',
              morphName: 'taggable', typeValue: 'post', relatedPivotKey: 'tag_id' },
}
\`\`\`

Eager load: \`.with(['posts', 'posts.tags'])\` - batched, no N+1.
Constrained eager load: \`.with({ posts: q => q.whereEq('published', true).orderBy('created_at', 'desc') })\` - filter/shape each eager-loaded relation.
Filter parents by relation: \`whereHas('posts', q => ...)\` or the shorthand \`whereRelation('posts', 'status', 'published')\`.
Relation aggregates on the parent row: \`withCount\` / \`withSum\` / \`withAvg\` / \`withMin\` / \`withMax\` / \`withExists\`.
Pivot management on belongsToMany / morphToMany / morphedByMany:
- \`model.attach(name, ids, { extras? })\`
- \`model.detach(name, ids?)\`
- \`model.sync(name, ids, { extras? })\`
- \`model.toggle(name, ids, { extras? })\`
`,
    "d1-eloquent://docs/api/transactions": `# Transactions

D1 has no interactive transactions - \`db.batch()\` is the only atomicity primitive. \`transaction()\` is therefore a write-only unit of work: ops run before-hooks and casts immediately but only COLLECT prepared statements; when the closure returns, everything flushes as ONE atomic batch. \`tx\` never reads.

\`\`\`ts
import { transaction } from '@orphnet/d1-eloquent'

const user = await transaction(env.DB, async (tx) => {
  const u = await tx.create(User, { id: crypto.randomUUID(), name: 'Alice' })
  await tx.create(Post, { id: crypto.randomUUID(), user_id: u.get('id') })
  tx.increment(Stats.query().whereEq('user_id', u.get('id')), 'post_count')
  return u
})
\`\`\`

Also available as \`Model.transaction(db, fn, opts?)\`, or \`Model.transaction(db, stmts)\` with a raw \`D1PreparedStatement[]\`.

Tx methods:
- \`tx.create(Model, attrs)\` - INSERT; fires saving/creating hooks + casts up front, returns the model
- \`tx.save(instance)\` - INSERT if unpersisted, else UPDATE its dirty attrs by PK
- \`tx.upsert(Model, attrs, conflictCols, updateCols?)\` - INSERT ... ON CONFLICT create-or-update
- \`tx.update(query, values)\` - bulk UPDATE via a query builder (no hooks, no revision)
- \`tx.delete(instanceOrQuery)\` - instance form fires deleting/deleted hooks and is soft-delete aware (await it); query form is a bulk DELETE (no hooks)
- \`tx.increment(query, column, amount?, extra?)\` / \`tx.decrement(query, column, amount?, extra?)\` - atomic counter step composed into the batch (no hooks, no revision)
- \`tx.updateJsonSet(query, col, path, value)\` / \`tx.updateJsonPatch(query, col, patch)\` / \`tx.updateJsonRemove(query, col, path)\`
- \`tx.results\` - the \`D1Result[]\` after flush

\`TxOptions\` (third argument): \`{ revision?: TRevisionContext, skipRevisions?: boolean, cache?: CacheAdapter }\` - revision rows for revision-enabled models are written in the SAME batch as their data statements.

Failure semantics: a before-hook returning \`false\` throws \`TransactionAborted\` and nothing is written; any batch failure (e.g. constraint violation) rolls back every statement. After-hooks (\`created\`/\`updated\`/\`deleted\`/\`saved\`) fire post-commit only.
`,
    "d1-eloquent://docs/guide/quick-start": `# Quick start

1. **Install**: \`bun add @orphnet/d1-eloquent\`
2. **Wire**: call \`configure(env)\` once at Worker start to auto-resolve the D1 binding.
3. **Define a model**:
   \`\`\`ts
   class User extends BaseModel<UserAttrs> {
     static table = 'users'
     static softDeletes = true
     static casts = { role: enumCast(['admin', 'member']) }
   }
   \`\`\`
4. **Migrate**: \`bunx d1-eloquent make:migration create_users\` then \`bunx d1-eloquent migrate\`.
   Or let the schema diff write it: \`bunx d1-eloquent generate\` (dry-run diff of models vs migrations), then \`bunx d1-eloquent generate --write\` to emit the reconciling migration.
5. **Query**: \`await User.query().whereEq('role', 'admin').get()\`
6. **Write atomically**: \`await transaction(env.DB, async (tx) => { await tx.create(User, { ... }) })\`
`,
};

async function buildProjectSummary(): Promise<string> {
    return JSON.stringify({
        root: ctx.project.root,
        wranglerConfig: ctx.project.wranglerConfig,
        d1Bindings: ctx.project.d1Bindings,
        counts: {
            models: ctx.project.models.length,
            migrations: ctx.project.migrations.length,
            seeders: ctx.project.seeders.length,
            factories: ctx.project.factories.length,
        },
        models: ctx.project.models.map((m) => ({
            name: m.name,
            table: m.table,
            softDeletes: m.softDeletes,
            revisions: m.revisions,
            relations: m.relations,
        })),
    }, null, 2);
}

export async function startMcpServer(projectRoot: string): Promise<void> {
    const project = discoverProject(projectRoot);
    ctx = { project, projectRoot };

    const server = new Server(
        { name: "d1-eloquent-mcp", version: pkg.version },
        { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        return handleTool(name, args ?? {});
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const uri = req.params.uri;
        if (uri === "d1-eloquent://project/summary") {
            return {
                contents: [{ uri, mimeType: "application/json", text: await buildProjectSummary() }],
            };
        }
        const doc = STATIC_DOCS[uri];
        if (doc) {
            return { contents: [{ uri, mimeType: "text/markdown", text: doc }] };
        }
        throw new Error(`Unknown resource: ${uri}`);
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        if (name === "create-model") {
            const modelName = (args?.name as string) || "Resource";
            const desc = (args?.description as string) || "";
            return {
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: [
                                `Scaffold a new \`${modelName}\` model for this d1-eloquent project.${desc ? "\nWhat it represents: " + desc : ""}`,
                                "",
                                "Steps:",
                                `1. Call \`make_resource\` with name=\"${modelName}\" so model + migration + seeder + factory are created in one go.`,
                                `2. Call \`read_migration\` for the new migration and fill in the schema (use \`t.id()\`, \`t.text()\`, \`t.timestamps()\`, etc.).`,
                                `3. Call \`read_model\` and tighten \`static casts\` + \`static relations\` to match the schema.`,
                                `4. Call \`run_migrate\` to apply locally.`,
                                `5. Call \`inspect_schema\` with the new table to confirm the columns match.`,
                            ].join("\n"),
                        },
                    },
                ],
            };
        }
        if (name === "audit-schema") {
            return {
                messages: [
                    {
                        role: "user" as const,
                        content: {
                            type: "text" as const,
                            text: [
                                "Audit every model in this project against the actual local D1 schema and report drift.",
                                "",
                                "Steps:",
                                "1. Call `list_models` to enumerate.",
                                "2. For each model, call `read_model` and capture the `table` + `casts` + `softDeletes` + `timestamps`.",
                                "3. Call `inspect_schema` (no table param) to get every actual table + column definition.",
                                "4. For each model, compare:",
                                "   - declared `table` exists?",
                                "   - if `softDeletes=true`, does the table have a `deleted_at` column?",
                                "   - if `timestamps=true`, `created_at` + `updated_at`?",
                                "   - cast columns exist in the schema?",
                                "5. Summarize drift in a single report grouped by severity.",
                            ].join("\n"),
                        },
                    },
                ],
            };
        }
        throw new Error(`Unknown prompt: ${name}`);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log lifecycle to stderr (stdout is reserved for MCP protocol)
    process.stderr.write(
        `d1-eloquent-mcp ready @ ${ctx.project.root}\n` +
            `  ${ctx.project.models.length} model(s)\n` +
            `  ${ctx.project.migrations.length} migration(s)\n` +
            `  ${ctx.project.seeders.length} seeder(s)\n` +
            `  ${ctx.project.factories.length} factor(y/ies)\n` +
            `  d1 bindings: ${ctx.project.d1Bindings.map((b) => b.binding).join(", ") || "(none)"}\n`,
    );
}
