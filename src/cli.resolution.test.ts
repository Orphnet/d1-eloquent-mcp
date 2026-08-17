// cli.resolution.test.ts - binary resolution ladder for runCli / runWranglerD1Query.
// fs + child_process are mocked; no real binaries are ever spawned.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    spawnSync: vi.fn(),
    existsSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));

import { runCli, runWranglerD1Query } from "./cli.js";

const CWD = "/proj";
const DIRECT_CLI = "/proj/node_modules/.bin/d1-eloquent";
const DIRECT_WRANGLER = "/proj/node_modules/.bin/wrangler";

function okSpawn(stdout = "ok") {
    return { status: 0, stdout, stderr: "", error: undefined };
}
function failSpawn(status = 1, stderr = "boom") {
    return { status, stdout: "", stderr, error: undefined };
}
function enoentSpawn() {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    return { status: null, stdout: null, stderr: null, error };
}
function timeoutSpawn() {
    const error = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
    return { status: null, stdout: "", stderr: "", error };
}

beforeEach(() => {
    mocks.spawnSync.mockReset();
    mocks.existsSync.mockReset();
});

describe("runCli resolution order", () => {
    it("uses node_modules/.bin/d1-eloquent directly when present", () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.spawnSync.mockReturnValue(okSpawn("migrated"));

        const r = runCli(["migrate"], CWD);

        expect(mocks.existsSync).toHaveBeenCalledWith(DIRECT_CLI);
        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(mocks.spawnSync).toHaveBeenCalledWith(
            DIRECT_CLI,
            ["migrate"],
            expect.objectContaining({ cwd: CWD, encoding: "utf8", timeout: 30_000 }),
        );
        expect(r).toEqual({ success: true, stdout: "migrated", stderr: "", exitCode: 0 });
    });

    it("falls back to bunx when the direct bin is absent", () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.spawnSync.mockReturnValue(okSpawn());

        const r = runCli(["status"], CWD);

        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(mocks.spawnSync).toHaveBeenCalledWith(
            "bunx",
            ["@orphnet/d1-eloquent", "status"],
            expect.objectContaining({ cwd: CWD, encoding: "utf8", timeout: 30_000 }),
        );
        expect(r.success).toBe(true);
    });

    it("falls back to npx when bunx is missing (spawn ENOENT)", () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.spawnSync
            .mockReturnValueOnce(enoentSpawn()) // bunx missing
            .mockReturnValueOnce(okSpawn("via npx"));

        const r = runCli(["status"], CWD);

        expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
        expect(mocks.spawnSync.mock.calls[0][0]).toBe("bunx");
        expect(mocks.spawnSync.mock.calls[1][0]).toBe("npx");
        expect(mocks.spawnSync.mock.calls[1][1]).toEqual(["@orphnet/d1-eloquent", "status"]);
        expect(r).toEqual({ success: true, stdout: "via npx", stderr: "", exitCode: 0 });
    });

    it("skips a broken direct bin (spawn ENOENT) and continues down the ladder", () => {
        mocks.existsSync.mockReturnValue(true); // dangling symlink scenario
        mocks.spawnSync
            .mockReturnValueOnce(enoentSpawn()) // direct bin unspawnable
            .mockReturnValueOnce(okSpawn());

        const r = runCli(["status"], CWD);

        expect(mocks.spawnSync.mock.calls[0][0]).toBe(DIRECT_CLI);
        expect(mocks.spawnSync.mock.calls[1][0]).toBe("bunx");
        expect(r.success).toBe(true);
    });

    it("throws naming the binary and the bun add command when every runner is missing", () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.spawnSync.mockReturnValue(enoentSpawn());

        expect(() => runCli(["status"], CWD)).toThrowError(/"d1-eloquent"/);
        expect(() => runCli(["status"], CWD)).toThrowError(/bun add -d @orphnet\/d1-eloquent/);
        // exactly the two package runners were attempted per call (no direct bin)
        expect(mocks.spawnSync).toHaveBeenCalledTimes(4);
    });

    it("treats a non-ENOENT spawn error (timeout) as final, not a fallthrough", () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.spawnSync.mockReturnValue(timeoutSpawn());

        const r = runCli(["migrate"], CWD);

        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(r.success).toBe(false);
        expect(r.exitCode).toBeNull();
    });

    it("returns a non-zero exit from the resolved binary without retrying another runner", () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.spawnSync.mockReturnValue(failSpawn(2, "migration failed"));

        const r = runCli(["migrate"], CWD);

        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ success: false, stdout: "", stderr: "migration failed", exitCode: 2 });
    });

    it("forwards a custom timeout", () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.spawnSync.mockReturnValue(okSpawn());

        runCli(["fresh", "--force"], CWD, 120_000);

        expect(mocks.spawnSync).toHaveBeenCalledWith(
            DIRECT_CLI,
            ["fresh", "--force"],
            expect.objectContaining({ timeout: 120_000 }),
        );
    });
});

describe("runWranglerD1Query resolution order", () => {
    it("uses node_modules/.bin/wrangler directly when present (local, default timeout)", () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.spawnSync.mockReturnValue(okSpawn("[]"));

        const r = runWranglerD1Query("MY_DB", "SELECT 1", CWD);

        expect(mocks.existsSync).toHaveBeenCalledWith(DIRECT_WRANGLER);
        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(mocks.spawnSync).toHaveBeenCalledWith(
            DIRECT_WRANGLER,
            ["d1", "execute", "MY_DB", "--local", "--json", "--command", "SELECT 1"],
            expect.objectContaining({ cwd: CWD, encoding: "utf8", timeout: 10_000 }),
        );
        expect(r).toEqual({ success: true, stdout: "[]", stderr: "", exitCode: 0 });
    });

    it("passes --remote and a custom timeout through", () => {
        mocks.existsSync.mockReturnValue(true);
        mocks.spawnSync.mockReturnValue(okSpawn());

        runWranglerD1Query("MY_DB", "SELECT 1", CWD, { remote: true, timeoutMs: 25_000 });

        expect(mocks.spawnSync).toHaveBeenCalledWith(
            DIRECT_WRANGLER,
            ["d1", "execute", "MY_DB", "--remote", "--json", "--command", "SELECT 1"],
            expect.objectContaining({ timeout: 25_000 }),
        );
    });

    it("falls back to bunx wrangler when the direct bin is absent", () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.spawnSync.mockReturnValue(okSpawn());

        runWranglerD1Query("MY_DB", "SELECT 1", CWD);

        expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
        expect(mocks.spawnSync).toHaveBeenCalledWith(
            "bunx",
            ["wrangler", "d1", "execute", "MY_DB", "--local", "--json", "--command", "SELECT 1"],
            expect.objectContaining({ cwd: CWD }),
        );
    });

    it("falls back to npx wrangler when bunx is missing", () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.spawnSync
            .mockReturnValueOnce(enoentSpawn())
            .mockReturnValueOnce(okSpawn());

        runWranglerD1Query("MY_DB", "SELECT 1", CWD);

        expect(mocks.spawnSync.mock.calls[0][0]).toBe("bunx");
        expect(mocks.spawnSync.mock.calls[1][0]).toBe("npx");
        expect(mocks.spawnSync.mock.calls[1][1]).toEqual([
            "wrangler", "d1", "execute", "MY_DB", "--local", "--json", "--command", "SELECT 1",
        ]);
    });

    it("throws naming wrangler and the bun add command when every runner is missing", () => {
        mocks.existsSync.mockReturnValue(false);
        mocks.spawnSync.mockReturnValue(enoentSpawn());

        expect(() => runWranglerD1Query("MY_DB", "SELECT 1", CWD)).toThrowError(/"wrangler"/);
        expect(() => runWranglerD1Query("MY_DB", "SELECT 1", CWD)).toThrowError(/bun add -d wrangler/);
    });
});
