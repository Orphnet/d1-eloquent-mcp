/**
 * Project discovery — scan the working directory for d1-eloquent
 * artifacts (models, migrations, seeders, factories, wrangler config).
 * Static parsing only — never imports user code, so it works without
 * the user's build chain.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface ModelInfo {
    name: string;
    file: string;
    table?: string;
    primaryKey?: string;
    softDeletes?: boolean;
    timestamps?: boolean;
    revisions?: boolean;
    relations?: string[];
    casts?: string[];
}

export interface MigrationInfo {
    name: string;
    file: string;
    timestamp: string;
}

export interface SimpleFile {
    name: string;
    file: string;
}

export interface ProjectInfo {
    root: string;
    wranglerConfig: string | null;
    d1Bindings: Array<{ binding: string; database_name?: string; database_id?: string }>;
    models: ModelInfo[];
    migrations: MigrationInfo[];
    seeders: SimpleFile[];
    factories: SimpleFile[];
}

const SKIP_DIRS = new Set([
    "node_modules", ".git", ".wrangler", ".nuxt", ".output", ".cache", "dist", "build",
    ".next", ".turbo", ".vscode", ".idea", "coverage", ".vitepress",
]);

function walk(dir: string, predicate: (path: string) => boolean, out: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, predicate, out);
        else if (predicate(full)) out.push(full);
    }
    return out;
}

function isModelFile(content: string): boolean {
    return /\bextends\s+BaseModel\b/.test(content);
}

function parseModel(file: string, root: string): ModelInfo | null {
    let src: string;
    try { src = readFileSync(file, "utf8"); }
    catch { return null; }
    if (!isModelFile(src)) return null;

    const classMatch = src.match(/(?:export\s+)?class\s+(\w+)\s+extends\s+BaseModel/);
    const name = classMatch?.[1] ?? "(unknown)";

    const tableMatch = src.match(/static\s+table\s*=\s*['"]([^'"]+)['"]/);
    const pkMatch = src.match(/static\s+primaryKey\s*=\s*['"]([^'"]+)['"]/);
    const softDel = /static\s+softDeletes\s*=\s*true/.test(src);
    const tstamps = /static\s+timestamps\s*=\s*true/.test(src) || !/static\s+timestamps\s*=\s*false/.test(src);
    const revs = /static\s+revisions\s*=\s*\{[^}]*enabled\s*:\s*true/.test(src);

    const relations: string[] = [];
    const relBlock = src.match(/static\s+relations[^=]*=\s*\{([\s\S]*?)\n\s*\}/);
    if (relBlock) {
        const inside = relBlock[1];
        const relNames = inside.matchAll(/(\w+)\s*:\s*\{/g);
        for (const m of relNames) relations.push(m[1]);
    }

    const casts: string[] = [];
    const castBlock = src.match(/static\s+casts[^=]*=\s*\{([\s\S]*?)\}\s*(?:as\s+const)?/);
    if (castBlock) {
        const castNames = castBlock[1].matchAll(/(\w+)\s*:/g);
        for (const m of castNames) casts.push(m[1]);
    }

    return {
        name,
        file: relative(root, file),
        table: tableMatch?.[1],
        primaryKey: pkMatch?.[1] ?? "id",
        softDeletes: softDel,
        timestamps: tstamps,
        revisions: revs,
        relations: relations.length ? relations : undefined,
        casts: casts.length ? casts : undefined,
    };
}

function parseMigrationName(file: string, root: string): MigrationInfo | null {
    const rel = relative(root, file);
    const base = file.split(/[/\\]/).pop() ?? file;
    if (!base.endsWith(".ts")) return null;
    const nameNoExt = base.replace(/\.ts$/, "");
    const tsMatch = nameNoExt.match(/^(\d{10,14})[_-](.*)$/);
    return {
        name: nameNoExt,
        file: rel,
        timestamp: tsMatch?.[1] ?? "",
    };
}

function findWranglerConfig(root: string): string | null {
    for (const name of ["wrangler.jsonc", "wrangler.toml", "wrangler.json"]) {
        const p = join(root, name);
        if (existsSync(p)) return p;
    }
    // Also scan one level deep (monorepo layout)
    try {
        for (const entry of readdirSync(root)) {
            const full = join(root, entry);
            try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
            if (SKIP_DIRS.has(entry)) continue;
            for (const name of ["wrangler.jsonc", "wrangler.toml", "wrangler.json"]) {
                const p = join(full, name);
                if (existsSync(p)) return p;
            }
        }
    } catch {}
    return null;
}

function parseD1Bindings(file: string): ProjectInfo["d1Bindings"] {
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { return []; }
    const out: ProjectInfo["d1Bindings"] = [];

    if (file.endsWith(".toml")) {
        // TOML: [[d1_databases]] blocks
        const blocks = content.split(/\[\[d1_databases\]\]/g).slice(1);
        for (const block of blocks) {
            const binding = block.match(/binding\s*=\s*['"]([^'"]+)['"]/)?.[1];
            const name = block.match(/database_name\s*=\s*['"]([^'"]+)['"]/)?.[1];
            const id = block.match(/database_id\s*=\s*['"]([^'"]+)['"]/)?.[1];
            if (binding) out.push({ binding, database_name: name, database_id: id });
        }
        return out;
    }

    // JSONC: strip line/block comments before parsing
    const stripped = content
        .replace(/\/\/[^\n]*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    try {
        const j = JSON.parse(stripped) as { d1_databases?: Array<{ binding: string; database_name?: string; database_id?: string }> };
        for (const b of j.d1_databases ?? []) {
            out.push({ binding: b.binding, database_name: b.database_name, database_id: b.database_id });
        }
    } catch {
        // best-effort regex fallback
        const regex = /"binding"\s*:\s*"([^"]+)"[\s\S]*?"database_name"\s*:\s*"([^"]+)"[\s\S]*?"database_id"\s*:\s*"([^"]+)"/g;
        for (const m of content.matchAll(regex)) {
            out.push({ binding: m[1], database_name: m[2], database_id: m[3] });
        }
    }
    return out;
}

export function discoverProject(root: string): ProjectInfo {
    const absRoot = resolve(root);

    const wranglerConfig = findWranglerConfig(absRoot);
    const d1Bindings = wranglerConfig ? parseD1Bindings(wranglerConfig) : [];

    const tsFiles = walk(absRoot, (p) => p.endsWith(".ts"));

    const models: ModelInfo[] = [];
    const migrations: MigrationInfo[] = [];
    const seeders: SimpleFile[] = [];
    const factories: SimpleFile[] = [];

    for (const f of tsFiles) {
        const rel = relative(absRoot, f).replace(/\\/g, "/");
        if (/(^|\/)(models)\//.test(rel) || /\/models\//.test(rel)) {
            const m = parseModel(f, absRoot);
            if (m) models.push(m);
        }
        if (/\/migrations\//.test(rel)) {
            const mig = parseMigrationName(f, absRoot);
            if (mig) migrations.push(mig);
        }
        if (/\/seeders\//.test(rel)) {
            seeders.push({ name: rel.split("/").pop()!.replace(/\.ts$/, ""), file: rel });
        }
        if (/\/factories\//.test(rel)) {
            factories.push({ name: rel.split("/").pop()!.replace(/\.ts$/, ""), file: rel });
        }
    }

    // Fall back to file-name heuristic for models if no /models/ dir
    if (models.length === 0) {
        for (const f of tsFiles) {
            const m = parseModel(f, absRoot);
            if (m) models.push(m);
        }
    }

    return {
        root: absRoot,
        wranglerConfig: wranglerConfig ? relative(absRoot, wranglerConfig) : null,
        d1Bindings,
        models: models.sort((a, b) => a.name.localeCompare(b.name)),
        migrations: migrations.sort((a, b) => a.name.localeCompare(b.name)),
        seeders: seeders.sort((a, b) => a.name.localeCompare(b.name)),
        factories: factories.sort((a, b) => a.name.localeCompare(b.name)),
    };
}
