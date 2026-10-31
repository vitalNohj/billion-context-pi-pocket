import { testHome } from "./env.ts";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { bundleName, bundledPackageNames, filesUnder, sha256 } from "../scripts/bundle-lib.mjs";
import { isNewer, stableVersion } from "../scripts/upstream.mjs";

const root = resolve(import.meta.dirname, "..");
const bundle = join(root, bundleName);
const manifest = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));

test("release checks accept stable versions and never downgrade", () => {
    assert.equal(stableVersion("0.1.83"), "0.1.83");
    for (const invalid of ["latest", "v0.1.83", "0.1.84-beta.1", "01.2.3", "1.2.3\nneeds_update=true", "$(id)", null]) {
        assert.throws(() => stableVersion(invalid));
    }
    assert.equal(isNewer("0.1.84", "0.1.83"), true);
    assert.equal(isNewer("0.2.0", "0.1.83"), true);
    assert.equal(isNewer("1.0.0", "0.99.99"), true);
    assert.equal(isNewer("0.1.83", "0.1.83"), false);
    assert.equal(isNewer("0.1.82", "0.1.83"), false);
    assert.equal(isNewer("9007199254740993.0.0", "9007199254740992.0.0"), true);
});

test("the committed artifact matches the exact published npm runtime", async () => {
    const packageDir = join(root, "node_modules/billion-context-pi");
    const names = await bundledPackageNames(packageDir);
    assert.deepEqual(names, Object.keys(manifest.bundledDependencies).sort());
    assert.equal(manifest.runtimeDirectory, `billion-context-pi-${manifest.version}`);
    const deployed = join(bundle, manifest.runtimeDirectory);
    for (const path of ["package.json", "LICENSE", ...await filesUnder(join(packageDir, "dist")).then((paths) => paths.map((p) => `dist/${p}`))]) {
        assert.deepEqual(readFileSync(join(deployed, path)), readFileSync(join(packageDir, path)), `Unchanged upstream file: ${path}`);
    }
    const notices = readFileSync(join(bundle, "THIRD-PARTY-NOTICES.txt"), "utf8");
    assert.match(notices, /Additional Term — Attribution on Product Surfaces/);
    for (const [name, entry] of Object.entries(manifest.bundledDependencies) as [string, any][]) {
        assert.ok(notices.includes(`${name} ${entry.version}`), `License credit: ${name}`);
    }
    const expectedFiles = [...Object.keys(manifest.files), "bundle.json"].sort();
    assert.deepEqual(await filesUnder(bundle), expectedFiles);
    for (const [path, entry] of Object.entries(manifest.files) as [string, any][]) {
        const content = readFileSync(join(bundle, path));
        assert.equal(content.length, entry.bytes, path);
        assert.equal(sha256(content), entry.sha256, path);
    }
});

test("verification rejects altered or unexpected bundle files without rewriting them", () => {
    const fixture = mkdtempSync(join(testHome, "verify-"));
    mkdirSync(join(fixture, "scripts"));
    for (const path of ["package.json", "package-lock.json", "upstream.json", `${bundleName}.ts`]) {
        cpSync(join(root, path), join(fixture, path));
    }
    for (const path of ["bundle.mjs", "bundle-lib.mjs", "upstream.mjs"]) {
        cpSync(join(root, "scripts", path), join(fixture, "scripts", path));
    }
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    cpSync(bundle, join(fixture, bundleName), { recursive: true });
    const verify = () => spawnSync(process.execPath, [join(fixture, "scripts/bundle.mjs"), "--check"], { encoding: "utf8" });
    const clean = verify();
    assert.equal(clean.status, 0, clean.stderr);
    const extra = join(fixture, bundleName, "unexpected.js");
    writeFileSync(extra, "// unexpected\n");
    assert.notEqual(verify().status, 0);
    assert.equal(readFileSync(extra, "utf8"), "// unexpected\n");
    unlinkSync(extra);
    const entry = join(fixture, bundleName, manifest.runtimeDirectory, "dist/index.js");
    appendFileSync(entry, "\n// changed\n");
    const changed = verify();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Bundle differs from pinned inputs/);
    assert.ok(readFileSync(entry, "utf8").endsWith("// changed\n"));
});
