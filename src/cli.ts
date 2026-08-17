/**
 * Shell helpers — child_process wrappers around the existing d1-eloquent
 * CLI + wrangler. All shell-arg quoting goes through `spawnSync` arg
 * arrays so no shell-injection vectors.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CliResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

interface BinarySpec {
    /** Executable name inside <projectRoot>/node_modules/.bin */
    binName: string;
    /** What bunx/npx are asked to run when the direct bin is absent */
    packageSpec: string;
    /** Install command surfaced when nothing can run the binary */
    installCmd: string;
}

const D1_ELOQUENT_BIN: BinarySpec = {
    binName: "d1-eloquent",
    packageSpec: "@orphnet/d1-eloquent",
    installCmd: "bun add -d @orphnet/d1-eloquent",
};

const WRANGLER_BIN: BinarySpec = {
    binName: "wrangler",
    packageSpec: "wrangler",
    installCmd: "bun add -d wrangler",
};

function toResult(r: SpawnSyncReturns<string>): CliResult {
    return {
        success: r.status === 0,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.status,
    };
}

/**
 * Run a project binary via a resolution ladder:
 *  1. <cwd>/node_modules/.bin/<binName> when present (version-pinned, no
 *     package-runner download step),
 *  2. `bunx <packageSpec>`,
 *  3. `npx <packageSpec>`.
 *
 * A runner that is missing entirely (spawn ENOENT) falls through to the next
 * candidate; any other outcome (success, non-zero exit, timeout) is final and
 * returned as a CliResult. When no candidate can even be spawned, throws an
 * error naming the missing binary and its install command.
 */
function runBinary(spec: BinarySpec, args: string[], cwd: string, timeoutMs: number): CliResult {
    const directBin = join(cwd, "node_modules", ".bin", spec.binName);
    const candidates: Array<{ command: string; argv: string[] }> = [];
    if (existsSync(directBin)) {
        candidates.push({ command: directBin, argv: args });
    }
    candidates.push({ command: "bunx", argv: [spec.packageSpec, ...args] });
    candidates.push({ command: "npx", argv: [spec.packageSpec, ...args] });

    for (const candidate of candidates) {
        const r: SpawnSyncReturns<string> = spawnSync(candidate.command, candidate.argv, {
            cwd,
            encoding: "utf8",
            timeout: timeoutMs,
        });
        const spawnErrCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
        if (spawnErrCode === "ENOENT") continue; // this runner does not exist; try the next
        return toResult(r);
    }

    throw new Error(
        `Cannot run "${spec.binName}": ${directBin} does not exist and neither bunx nor npx ` +
        `is available on PATH. Install it in the project with: ${spec.installCmd}`,
    );
}

export function runCli(args: string[], cwd: string, timeoutMs = 30_000): CliResult {
    return runBinary(D1_ELOQUENT_BIN, args, cwd, timeoutMs);
}

export function runWranglerD1Query(
    dbName: string,
    sql: string,
    cwd: string,
    opts: { remote?: boolean; timeoutMs?: number } = {},
): CliResult {
    const args = ["d1", "execute", dbName];
    args.push(opts.remote ? "--remote" : "--local");
    args.push("--json", "--command", sql);
    return runBinary(WRANGLER_BIN, args, cwd, opts.timeoutMs ?? 10_000);
}

/** Write/DDL keywords that must never appear in a read-only statement. */
const WRITE_KEYWORDS =
    /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|DETACH|VACUUM|REINDEX)\b/i;

/**
 * Strip string literals (contents) and comments from SQL so keyword scanning
 * can't be fooled by `'... DELETE ...'` and can't miss `--`/`/* * /`-hidden
 * writes. Also reports whether a second statement follows a `;`. SQLite escapes
 * quotes by doubling (`''`), which is handled.
 */
function stripSqlNoise(sql: string): { code: string; multiStatement: boolean } {
    let code = "";
    let multiStatement = false;
    let inStr = false;
    let quote = "";
    let inLine = false;
    let inBlock = false;
    let sawSemicolon = false; // a top-level `;` was seen — real content after it = multi-statement

    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        const n = sql[i + 1];

        if (inLine) {
            if (c === "\n") { inLine = false; code += "\n"; }
            continue;
        }
        if (inBlock) {
            if (c === "*" && n === "/") { inBlock = false; i++; }
            continue;
        }
        if (inStr) {
            if (c === quote) {
                if (n === quote) { i++; continue; } // escaped quote ('')
                inStr = false;
                quote = "";
            }
            continue; // drop string contents
        }

        if (c === "-" && n === "-") { inLine = true; i++; continue; }
        if (c === "/" && n === "*") { inBlock = true; i++; continue; }
        if (c === "'" || c === '"' || c === "`") {
            if (sawSemicolon) multiStatement = true;
            inStr = true;
            quote = c;
            continue;
        }
        if (c === ";") { sawSemicolon = true; continue; }
        if (sawSemicolon && !/\s/.test(c)) multiStatement = true; // real statement after `;`
        code += c;
    }

    return { code, multiStatement };
}

/**
 * Verify a SQL statement is read-only. Allows SELECT / WITH ... SELECT /
 * EXPLAIN / read PRAGMA. Rejects:
 *  - a leading keyword outside the allow-list,
 *  - multi-statement payloads,
 *  - any write/DDL keyword anywhere outside a string/comment — this closes the
 *    `WITH cte AS (...) DELETE ...` bypass, since a CTE can legally prefix DML,
 *  - assignment-form PRAGMA (`PRAGMA journal_mode = ...`), which mutates state.
 */
export function ensureReadOnlySql(sql: string): { ok: true } | { ok: false; reason: string } {
    const trimmed = sql.trim().replace(/^;+|;+$/g, "").trim();
    const head = trimmed.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "").replace(/^--[^\n]*\n?/g, "").trimStart();
    const firstWord = head.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? "";
    const allowed = new Set(["SELECT", "WITH", "EXPLAIN", "PRAGMA"]);
    if (!allowed.has(firstWord)) {
        return { ok: false, reason: `Only SELECT / WITH / EXPLAIN / PRAGMA allowed for query_d1. Got: ${firstWord || "(empty)"}` };
    }

    const { code, multiStatement } = stripSqlNoise(trimmed);
    if (multiStatement) {
        return { ok: false, reason: "Multi-statement queries are not allowed." };
    }
    if (WRITE_KEYWORDS.test(code)) {
        return {
            ok: false,
            reason: "Only read-only statements are allowed; a write/DDL keyword was found (e.g. a WITH-prefixed CTE wrapping INSERT/UPDATE/DELETE).",
        };
    }
    if (firstWord === "PRAGMA" && /=/.test(code)) {
        return { ok: false, reason: "Assignment-form PRAGMA (which mutates state) is not allowed; only read PRAGMAs." };
    }
    return { ok: true };
}
