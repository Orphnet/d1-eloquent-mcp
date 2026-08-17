#!/usr/bin/env node
/**
 * d1-eloquent-mcp — MCP server entry point.
 *
 * Args:
 *   --project <path>    Project root to bind to. Defaults to cwd.
 */
import { startMcpServer } from "./server.js";

function parseArgs(argv: string[]): { project: string } {
    let project = process.cwd();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if ((a === "--project" || a === "-p") && argv[i + 1]) {
            project = argv[i + 1];
            i++;
        } else if (a?.startsWith("--project=")) {
            project = a.slice("--project=".length);
        }
    }
    return { project };
}

async function main() {
    const { project } = parseArgs(process.argv.slice(2));
    try {
        await startMcpServer(project);
    } catch (e) {
        process.stderr.write(`d1-eloquent-mcp fatal: ${(e as Error).message}\n`);
        process.exit(1);
    }
}

main().catch((e) => {
    process.stderr.write(`d1-eloquent-mcp fatal: ${(e as Error).message}\n`);
    process.exit(1);
});
