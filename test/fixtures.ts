/** A gallery-sized entry in an isolated Pocket data directory, with optional exact legacy runtime files. */
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const repo = resolve(import.meta.dirname, "..");
export const ENTRY = "billion-context-pi-pocket.ts";
export const FILES = "billion-context-pi-pocket";
export const SETTINGS = "billion-context-pi-pocket.json";
export const LEGACY_SETTINGS = "billion-context-pi-pocket-adapter.json";
const npmRuntime = join(repo, "node_modules", "billion-context-pi");
export const legacyRuntimeVersion = () => JSON.parse(readFileSync(join(npmRuntime, "package.json"), "utf8")).version;

export function dropInFolder(folder: string, settings: Record<string, string> = {}, includeLegacy = true, settingsFile = SETTINGS): string {
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(repo, ENTRY), join(folder, ENTRY));
    cpSync(join(repo, FILES), join(folder, FILES), { recursive: true });
    if (includeLegacy) {
        cpSync(npmRuntime, join(folder, FILES, `billion-context-pi-${legacyRuntimeVersion()}`), {
            recursive: true,
            filter: (path) => !relative(npmRuntime, path).split(/[\\/]/).includes("node_modules"),
        });
    }
    writeFileSync(join(folder, settingsFile), JSON.stringify(settings));
    return join(folder, ENTRY);
}
