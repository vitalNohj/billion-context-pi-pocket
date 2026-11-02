import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleName, bundledPackageNames, filesUnder, licenseFile, sha256 } from "./bundle-lib.mjs";
import { json, root } from "./upstream.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: npm run bundle [-- --check]");
}
const upstream = await json(join(root, "upstream.json"));
const lock = await json(join(root, "package-lock.json"));
const ownPackage = await json(join(root, "package.json"));
const packageDir = join(root, "node_modules/billion-context-pi");
const pkg = await json(join(packageDir, "package.json"));
if (pkg.name !== "billion-context-pi" || pkg.version !== upstream.version || ownPackage.version !== upstream.version) {
    throw new Error("Extension, upstream metadata, and installed BCP versions must agree");
}
if (lock.packages["node_modules/billion-context-pi"]?.integrity !== upstream.npmIntegrity) {
    throw new Error("Installed BCP does not match the pinned npm release integrity");
}
const adapter = await readFile(join(root, `${bundleName}.ts`), "utf8");
if (!adapter.includes(`const TESTED_BCP_VERSIONS = [${JSON.stringify(upstream.version)}];`)) {
    throw new Error("TESTED_BCP_VERSIONS does not match the bundled release");
}
const names = await bundledPackageNames(packageDir);
if (JSON.stringify(names) !== JSON.stringify(Object.keys(upstream.bundledDependencies).sort())) {
    throw new Error("Bundled library inventory changed; run npm run refresh");
}

// Version the entire runtime path, not only the entry URL. Node then reloads
// relative child imports too when an adapter update changes the BCP version.
const runtimeDirectory = `billion-context-pi-${pkg.version}`;
const files = new Map();
for (const path of ["package.json", "LICENSE", ...await filesUnder(join(packageDir, "dist")).then((paths) => paths.map((p) => `dist/${p}`))]) {
    files.set(`${runtimeDirectory}/${path}`, await readFile(join(packageDir, path)));
}
let notices = `THIRD-PARTY NOTICES — billion-context-pi ${upstream.version}\n\n` +
    "This extension uses billion-context-pi and acp-kernel by ranxianglei.\n" +
    "https://github.com/ranxianglei/billion-context-pi\n" +
    "https://github.com/ranxianglei/acp-kernel\n" +
    "https://github.com/ranxianglei/billion-context\n\n" +
    "The published BCP runtime is copied unchanged. Its bundled libraries are listed below.\n" +
    "The acp-kernel notice includes an additional attribution term; it is retained in full.\n\n";
for (const name of names) {
    const expected = upstream.bundledDependencies[name];
    const installed = await json(join(root, "node_modules", name, "package.json"));
    const entry = lock.packages[`node_modules/${name}`];
    if (installed.version !== expected.version || entry?.integrity !== expected.integrity) {
        throw new Error(`License dependency does not match the upstream lock: ${name}`);
    }
    notices += `===== ${name} ${expected.version} (${expected.license} in npm metadata) =====\n`;
    notices += `https://www.npmjs.com/package/${name}/v/${expected.version}\n\n`;
    const licensePaths = (await readdir(join(root, "node_modules", name))).filter(licenseFile).sort();
    for (const path of licensePaths) {
        notices += `--- ${path} ---\n${await readFile(join(root, "node_modules", name, path), "utf8")}\n\n`;
    }
    for (const extra of upstream.extraLicenses?.[name] ?? []) {
        notices += `--- ${extra.name} (${extra.source}) ---\n${extra.text}\n\n`;
    }
    if (licensePaths.length === 0 && !upstream.extraLicenses?.[name]?.length) {
        throw new Error(`Missing full license notice for ${name}`);
    }
}
files.set("THIRD-PARTY-NOTICES.txt", Buffer.from(notices));
files.set("bundle.json", Buffer.from(JSON.stringify({
    package: pkg.name,
    version: pkg.version,
    runtimeDirectory,
    source: `https://github.com/${upstream.repository}/tree/${upstream.commit}`,
    npmIntegrity: upstream.npmIntegrity,
    bundledDependencies: upstream.bundledDependencies,
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([path, content]) => [path, { bytes: content.length, sha256: sha256(content) }])),
}, null, 2) + "\n"));

const destination = join(root, bundleName);
if (args[0] === "--check") {
    const actual = await filesUnder(destination);
    if (JSON.stringify(actual) !== JSON.stringify([...files.keys()].sort())) throw new Error("Bundle file list is stale");
    for (const [path, content] of files) {
        if (!(await readFile(join(destination, path))).equals(content)) throw new Error(`Bundle differs from pinned inputs: ${path}`);
    }
    console.log(`Verified ${pkg.name} ${pkg.version}: ${files.size} files, unchanged npm runtime, complete license notices.`);
} else {
    // Build next to the destination, then swap. Do not destroy a working bundle
    // if generating the replacement fails. This never touches live drop-ins.
    const stage = await mkdtemp(join(root, ".bcp-bundle-"));
    const backup = `${stage}-previous`;
    let movedPrevious = false;
    try {
        for (const [path, content] of files) {
            const target = join(stage, path);
            await mkdir(join(target, ".."), { recursive: true });
            await writeFile(target, content);
        }
        try {
            await rename(destination, backup);
            movedPrevious = true;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        try {
            await rename(stage, destination);
        } catch (error) {
            if (movedPrevious) await rename(backup, destination);
            throw error;
        }
        if (movedPrevious) await rm(backup, { recursive: true });
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
    const bytes = [...files.values()].reduce((total, content) => total + content.length, 0);
    console.log(`Bundled ${pkg.name} ${pkg.version}: ${files.size} files, ${bytes.toLocaleString("en")} bytes.`);
}
