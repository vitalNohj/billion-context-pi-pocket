import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { filesUnder, bundledPackageNames, licenseFile } from './bundle-lib.mjs';
import { json, release, root, stableVersion, fetchJSON } from './upstream.mjs';
import { unpackArchive, validatePin } from '../billion-context-pi-pocket/runtime.mjs';
import { executableFiles, assertCompatibleContract } from './pin-contract.mjs';

const check = process.argv.slice(2);
if (check.length > 1 || (check.length && check[0] !== '--check')) throw new Error('Usage: npm run pins [-- --check]');
const out = join(root, 'billion-context-pi-pocket');
const upstream = await json(join(root, 'upstream.json'));
const pkg = await json(join(root, 'package.json'));
const version = stableVersion(upstream.version);
if (pkg.version !== version || pkg.devDependencies['billion-context-pi'] !== version) throw new Error('Package and upstream versions differ');
const metadata = await release(version);
if (metadata.gitHead !== upstream.commit || metadata.dist.integrity !== upstream.npmIntegrity) throw new Error('npm provenance differs from reviewed upstream metadata');
const url = `https://registry.npmjs.org/billion-context-pi/-/billion-context-pi-${version}.tgz`;
if (metadata.dist.tarball !== url) throw new Error('Unexpected npm tarball URL');
const canonicalIntegrity = (s) => typeof s === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(s) && Buffer.from(s.slice(7), 'base64').length === 64 && `sha512-${Buffer.from(s.slice(7), 'base64').toString('base64')}` === s;
async function verified(url, integrity) {
    if (!canonicalIntegrity(integrity)) throw new Error('Noncanonical SHA512 integrity');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'registry.npmjs.org' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Unexpected tarball host');
    const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'bcp-pins');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await chmod(cache, 0o700);
    const path = join(cache, Buffer.from(integrity.slice(7), 'base64').toString('hex') + '.tgz');
    let bytes;
    try { bytes = await readFile(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const valid = (b) => b && `sha512-${createHash('sha512').update(b).digest('base64')}` === integrity;
    if (!valid(bytes)) {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        const length = Number(response.headers.get('content-length'));
        if (length > 50_000_000) throw new Error('Archive too large');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 50_000_000) throw new Error('Archive too large');
            chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
        if (!valid(bytes)) throw new Error('Archive integrity mismatch');
        await writeFile(path, bytes, { mode: 0o600 });
        await chmod(path, 0o600);
    }
    return bytes;
}
const archive = await verified(url, upstream.npmIntegrity);
const files = await unpackArchive(archive);
const pin = { version, tarball: url, integrity: upstream.npmIntegrity, archiveBytes: archive.length, unpackedBytes: [...files.values()].reduce((n, b) => n + b.length, 0), executableFiles: executableFiles(files) };
validatePin(pin);
let old;
try { old = await json(join(out, 'runtime-lock.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (old && (old.format !== 1 || old.package !== 'billion-context-pi' || !Array.isArray(old.releases))) throw new Error('Invalid prior runtime lock');
const releases = old?.releases ?? [];
const seen = new Set();
for (const p of releases) { validatePin(p); if (seen.has(p.version)) throw new Error('Duplicate reviewed version'); seen.add(p.version); }
const existing = releases.find((p) => p.version === version);
if (existing) {
    for (const key of ['version', 'tarball', 'integrity', 'archiveBytes', 'unpackedBytes']) {
        if (existing[key] !== pin[key]) throw new Error(`Existing reviewed release pin changed: ${key}`);
    }
    if (existing.executableFiles !== undefined && !isDeepStrictEqual(existing.executableFiles, pin.executableFiles)) throw new Error('Existing reviewed executable file map changed');
    if (existing.executableFiles === undefined) existing.executableFiles = pin.executableFiles;
} else releases.push(pin);
const runtimeLock = { format: 1, package: 'billion-context-pi', current: version, releases };
const packageDir = join(root, 'node_modules/billion-context-pi');
const installedPaths = await filesUnder(packageDir);
const jsPaths = installedPaths.filter((p) => /\.(?:js|mjs|cjs)$/.test(p));
const expectedPaths = [...files.keys()].filter((p) => /\.(?:js|mjs|cjs)$/.test(p));
if (JSON.stringify(jsPaths.sort()) !== JSON.stringify(expectedPaths.sort())) throw new Error('Installed JavaScript file list differs from archive');
for (const p of ['package.json', ...expectedPaths]) {
    const expected = files.get(p);
    if (!expected || !(await readFile(join(packageDir, p))).equals(expected)) throw new Error(`Installed package differs from verified archive: ${p}`);
}
const names = await bundledPackageNames(packageDir);
if (JSON.stringify(names) !== JSON.stringify(Object.keys(upstream.bundledDependencies).sort())) throw new Error('Bundled dependency inventory changed');
let notices = `THIRD-PARTY NOTICES — billion-context-pi ${version}\nGenerated by scripts/pins.mjs from reviewed npm releases and upstream.json.\n\nThis extension uses billion-context-pi and acp-kernel by ranxianglei.\nhttps://github.com/ranxianglei/billion-context-pi\nhttps://github.com/ranxianglei/acp-kernel\nhttps://github.com/ranxianglei/billion-context\n\nThe acp-kernel notice includes an additional attribution term; it is retained in full.\n\n`;
for (const name of names) {
    const expected = upstream.bundledDependencies[name];
    const dep = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}/${stableVersion(expected.version)}`);
    if (dep.name !== name || dep.version !== expected.version || dep.license !== expected.license || dep.dist?.integrity !== expected.integrity) throw new Error(`Dependency metadata mismatch: ${name}`);
    // License inventories can contain thousands of source files. Runtime installation retains its 512-entry bound.
    const depFiles = await unpackArchive(await verified(dep.dist.tarball, expected.integrity), { maxEntries: 16_384 });
    notices += `===== ${name} ${expected.version} (${expected.license}) =====\nhttps://www.npmjs.com/package/${name}/v/${expected.version}\n\n`;
    const licenses = [...depFiles.keys()].filter((p) => !p.includes('/') && licenseFile(p)).sort();
    for (const p of licenses) notices += `--- ${p} ---\n${depFiles.get(p).toString('utf8')}\n\n`;
    for (const extra of upstream.extraLicenses?.[name] ?? []) notices += `--- ${extra.name} (${extra.source}) ---\n${extra.text}\n\n`;
    if (!licenses.length && !upstream.extraLicenses?.[name]?.length) throw new Error(`Missing license: ${name}`);
}
const temp = await mkdtemp(join(tmpdir(), 'bcp-contract-'));
let contract;
try {
    const result = spawnSync(process.execPath, [join(root, 'scripts/capture-contract.mjs'), join(packageDir, 'dist/index.js')], {
        cwd: temp, env: { PATH: process.env.PATH || '', HOME: temp, USERPROFILE: temp, XDG_CONFIG_HOME: join(temp, 'config'), XDG_CACHE_HOME: join(temp, 'cache'), PI_ACP_FORK_HOST: '1', ACP_AUTO_UPDATE: '0' }, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000,
    });
    if (result.error || result.status !== 0) throw new Error(`Contract capture failed: ${result.error || result.stderr}`);
    const tools = JSON.parse(result.stdout);
    if (JSON.stringify(tools.map((t) => t.name)) !== JSON.stringify(['compress','decompress','search_context','acp_status','acp_cache'])) throw new Error('Upstream tool names drifted');
    contract = { format: 1, package: 'billion-context-pi', version, tools };
} finally { await rm(temp, { recursive: true, force: true }); }
let previousContract;
try { previousContract = await json(join(out, 'tool-contract.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (previousContract) assertCompatibleContract(previousContract, contract);
else if (old) throw new Error('Reviewed tool contract missing; cannot verify compatibility');
const outputs = new Map([
    ['runtime-lock.json', Buffer.from(JSON.stringify(runtimeLock, null, 2) + '\n')],
    ['tool-contract.json', Buffer.from(JSON.stringify(contract, null, 2) + '\n')],
    ['BCP-LICENSE.txt', files.get('LICENSE')],
    ['THIRD-PARTY-NOTICES.txt', Buffer.from(notices)],
]);
if (!outputs.get('BCP-LICENSE.txt')) throw new Error('Published license missing');
for (const [p, content] of outputs) {
    const target = join(out, p);
    if (check.length) { if (!(await readFile(target)).equals(content)) throw new Error(`Generated file differs: ${p}`); }
    else await writeFile(target, content);
}
if (!check.length) {
    // Remove only the known obsolete generated artifacts. Never replace the helper directory.
    await rm(join(out, 'bundle.json'), { force: true });
    for (const entry of await readdir(out, { withFileTypes: true })) {
        if (entry.isDirectory() && /^billion-context-pi-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(entry.name)) await rm(join(out, entry.name), { recursive: true });
    }
}
console.log(`${check.length ? 'Verified' : 'Generated'} reviewed pin and contract for ${version}`);
