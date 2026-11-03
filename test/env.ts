/**
 * Import first. billion-context-pi reads `~/.pi/acp.json` and writes `~/.pi/acp.log` in the home folder it sees as it
 * loads: tests get their own, with no delegate tools and no self-update.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Pin generation verifies this local archive; capture its location before the test replaces HOME.
export const pinArchiveCache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "bcp-pins");
export const testHome = mkdtempSync(join(tmpdir(), "bcp-pocket-test-"));
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
mkdirSync(join(testHome, ".pi"), { recursive: true });
writeFileSync(
    join(testHome, ".pi", "acp.json"),
    JSON.stringify({ delegate: false, autoUpdate: false, repetitionGuard: false }),
);
process.env.HOME = testHome;
process.env.ACP_LOG_FILE = join(testHome, ".pi", "acp.log");
