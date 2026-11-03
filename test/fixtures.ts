/** A gallery-sized entry in an isolated Pocket data directory, with optional exact legacy runtime files. */
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const repo = resolve(import.meta.dirname, "..");
export const ENTRY = "billion-context-pi-pocket.ts";
export const FILES = "billion-context-pi-pocket";
export const SETTINGS = "billion-context-pi-pocket.json";
export const LEGACY_SETTINGS = "billion-context-pi-pocket-adapter.json";

export function dropInFolder(folder: string, settings: Record<string, string> = {}, includeLegacy = true, settingsFile = SETTINGS): string {
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(repo, ENTRY), join(folder, ENTRY));
    cpSync(join(repo, FILES), join(folder, FILES), { recursive: true });
    if (includeLegacy) {
        const { current } = JSON.parse(readFileSync(join(repo, FILES, "runtime-lock.json"), "utf8"));
        const source = join(repo, "node_modules", "billion-context-pi");
        cpSync(source, join(folder, FILES, `billion-context-pi-${current}`), {
            recursive: true,
            filter: (path) => !relative(source, path).split(/[\\/]/).includes("node_modules"),
        });
    }
    writeFileSync(join(folder, settingsFile), JSON.stringify(settings));
    return join(folder, ENTRY);
}
