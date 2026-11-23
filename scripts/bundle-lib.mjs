import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const bundleName = "billion-context-pi-pocket";
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
    const dist = join(packageDir, "dist");
    const code = await Promise.all((await filesUnder(dist)).filter((file) => file.endsWith(".js")).map((file) => readFile(join(dist, file), "utf8")));
    return bundledNames(code);
}

export function bundledNames(code) {
    const names = new Set();
    for (const text of code) {
        // Upstream's unminified tsup output identifies the bundled source modules.
        for (const match of text.matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)) names.add(match[1]);
    }
    if (names.size === 0) throw new Error("Cannot identify bundled libraries; review the upstream build format");
    return [...names].sort();
}

/** Compare the actual dep sources included in both release builds, not only their package.json ranges. */
export function bundledSources(files) {
    const sources = new Map();
    for (const [file, bytes] of files) {
        if (!file.startsWith("dist/") || !file.endsWith(".js.map")) continue;
        const map = JSON.parse(bytes);
        if (!Array.isArray(map.sources) || map.sources.length !== map.sourcesContent?.length) throw new Error(`Incomplete source map: ${file}`);
        for (const [i, name] of map.sources.entries()) {
            if (!name.startsWith("../node_modules/")) continue;
            const content = map.sourcesContent[i];
            if (typeof content !== "string" || (sources.has(name) && sources.get(name) !== content)) {
                throw new Error(`Invalid bundled source: ${name}`);
            }
            sources.set(name, content);
        }
    }
    if (!sources.size) throw new Error("Cannot verify bundled libraries without their source maps");
    return sources;
}
