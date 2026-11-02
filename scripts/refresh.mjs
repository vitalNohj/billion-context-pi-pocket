import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledPackageNames, licenseFile } from "./bundle-lib.mjs";
import { fetchJSON, json, npm, release, repository, root, stableVersion } from "./upstream.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) throw new Error("Usage: npm run refresh -- <stable-version>");
const version = stableVersion(args[0]);
const previous = await json(join(root, "upstream.json"));
const metadata = await release(version);
const sourceBase = `https://raw.githubusercontent.com/${repository}/${metadata.gitHead}`;
const source = await fetchJSON(`${sourceBase}/package.json`);
if (source.name !== "billion-context-pi" || source.version !== version || source.license !== "MIT") {
    throw new Error("The npm release and its source commit do not agree");
}
const sourceLock = await fetchJSON(`${sourceBase}/package-lock.json`);
if (sourceLock.version !== version) throw new Error("Source lock file version does not match npm");

// Copy the published artifact, not a locally rebuilt approximation. Lifecycle
// scripts never run. npm verifies and records tarball integrity in the lock file.
const installFlags = ["install", "--save-dev", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund"];
npm([...installFlags, `billion-context-pi@${version}`]);
const names = await bundledPackageNames(join(root, "node_modules/billion-context-pi"));
const bundledDependencies = {};
for (const name of names) {
    const entry = sourceLock.packages?.[`node_modules/${name}`];
    if (!entry || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? "")) {
        throw new Error(`No pinned npm provenance for bundled library ${name}`);
    }
    stableVersion(entry.version);
    if (!["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"].includes(entry.license)) {
        throw new Error(`Review bundled library license: ${name}: ${entry.license}`);
    }
    bundledDependencies[name] = {
        version: entry.version,
        integrity: entry.integrity,
        license: entry.license,
    };
}
const obsolete = Object.keys(previous.bundledDependencies).filter((name) => !names.includes(name));
if (obsolete.length) {
    npm(["uninstall", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", ...obsolete]);
}
npm([...installFlags, ...names.map((name) => `${name}@${bundledDependencies[name].version}`)]);

// Some published Pi TUI versions omit their LICENSE file. Fetch its full notice
// from that package's exact source commit once, and pin it in our metadata.
// This is build-time only. Runtime never fetches code or license files.
const extraLicenses = {};
for (const name of names) {
    const entries = await readdir(join(root, "node_modules", name));
    if (entries.some(licenseFile)) continue;
    if (name !== "@earendil-works/pi-tui") throw new Error(`Missing license notice for ${name}`);
    const pkg = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}/${bundledDependencies[name].version}`);
    if (!/^[a-f0-9]{40}$/.test(pkg.gitHead ?? "") || pkg.repository?.url !== "git+https://github.com/earendil-works/pi.git") {
        throw new Error("Cannot pin the Pi TUI license source");
    }
    const url = `https://raw.githubusercontent.com/earendil-works/pi/${pkg.gitHead}/LICENSE`;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    if (!text.includes("Permission is hereby granted") || Buffer.byteLength(text) > 65_536) {
        throw new Error("Review the Pi TUI license notice");
    }
    extraLicenses[name] = [{ name: "LICENSE", source: url, text }];
}

npm(["version", version, "--no-git-tag-version", "--allow-same-version", "--ignore-scripts"]);
await writeFile(join(root, "upstream.json"), JSON.stringify({
    version,
    repository,
    commit: metadata.gitHead,
    npmIntegrity: metadata.dist.integrity,
    bundledDependencies,
    extraLicenses,
}, null, 2) + "\n");

const adapter = join(root, "billion-context-pi-pocket.ts");
const code = await readFile(adapter, "utf8");
const pattern = /const TESTED_BCP_VERSIONS = \[[^\]\n]*\];/g;
if ([...code.matchAll(pattern)].length !== 1) throw new Error("Cannot find the one TESTED_BCP_VERSIONS declaration");
await writeFile(adapter, code.replace(pattern, `const TESTED_BCP_VERSIONS = [${JSON.stringify(version)}];`));
npm(["run", "bundle"]);
console.log(`Prepared ${version}. Run the tests before committing this refresh.`);
