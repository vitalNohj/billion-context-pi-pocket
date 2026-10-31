import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const bundleName = "billion-context-pi-pocket-adapter";
export const sha256 = (content) => createHash("sha256").update(content).digest("hex");
export const licenseFile = (name) => /^(?:licen[cs]e|copying|notice)(?:\.[a-z0-9_-]+)?$/i.test(name);

export async function filesUnder(directory, prefix = "") {
    const files = [];
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) files.push(...await filesUnder(directory, path));
        else if (entry.isFile()) files.push(path);
        else throw new Error(`Bundle inputs must be regular files, not links: ${path}`);
    }
    return files.sort();
}

export async function bundledPackageNames(packageDir) {
    const names = new Set();
    for (const file of await filesUnder(join(packageDir, "dist"))) {
        if (!file.endsWith(".js")) continue;
        const code = await readFile(join(packageDir, "dist", file), "utf8");
        // Upstream's unminified tsup output identifies the bundled source modules.
        for (const match of code.matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)) names.add(match[1]);
    }
    if (names.size === 0) throw new Error("Cannot identify bundled libraries; review the upstream build format");
    return [...names].sort();
}
