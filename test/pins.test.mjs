import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root, stableVersion, isNewer } from '../scripts/upstream.mjs';
import { validatePin } from '../billion-context-pi-pocket/runtime.mjs';
import { executableFiles, assertCompatibleContract } from '../scripts/pin-contract.mjs';
const json = async (path) => JSON.parse(await readFile(join(root, path), 'utf8'));

test('stable release checks reject prereleases and downgrades', () => {
    assert.equal(stableVersion('0.1.83'), '0.1.83');
    for (const v of ['v0.1.83', '0.1.84-rc.1', '01.2.3', '1.2.3\nneeds_update=true', null]) assert.throws(() => stableVersion(v));
    assert.equal(isNewer('0.1.84', '0.1.83'), true);
    assert.equal(isNewer('0.1.82', '0.1.83'), false);
    assert.equal(isNewer('9007199254740993.0.0', '9007199254740992.0.0'), true);
});

test('reviewed pins, release provenance and contract agree', async () => {
    const [lock, upstream, pkg, contract] = await Promise.all(['billion-context-pi-pocket/runtime-lock.json', 'upstream.json', 'package.json', 'billion-context-pi-pocket/tool-contract.json'].map(json));
    assert.equal(lock.format, 1); assert.equal(lock.package, 'billion-context-pi');
    assert.equal(lock.current, upstream.version); assert.equal(pkg.version, lock.current);
    assert.equal(pkg.devDependencies['billion-context-pi'], lock.current);
    assert.equal(new Set(lock.releases.map((p) => p.version)).size, lock.releases.length);
    for (const pin of lock.releases) validatePin(pin);
    const pin = lock.releases.find((p) => p.version === lock.current);
    assert.ok(pin); assert.equal(pin.integrity, upstream.npmIntegrity);
    assert.ok(pin.executableFiles && typeof pin.executableFiles === 'object' && !Array.isArray(pin.executableFiles));
    const executablePaths = Object.keys(pin.executableFiles);
    assert.deepEqual(executablePaths, [...executablePaths].sort());
    assert.ok(executablePaths.includes('package.json'));
    for (const path of executablePaths) {
        assert.ok(path === 'package.json' || /\.(?:js|mjs|cjs)$/.test(path));
        assert.match(pin.executableFiles[path], /^[a-f0-9]{64}$/);
    }
    assert.match(upstream.commit, /^[a-f0-9]{40}$/);
    assert.equal(contract.format, 1); assert.equal(contract.package, lock.package); assert.equal(contract.version, lock.current);
    assert.deepEqual(contract.tools.map((t) => t.name), ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache']);
    for (const tool of contract.tools) { assert.equal(typeof tool.description, 'string'); assert.ok(tool.parameters && typeof tool.parameters === 'object'); }
    const notices = await readFile(join(root, 'billion-context-pi-pocket/THIRD-PARTY-NOTICES.txt'), 'utf8');
    assert.match(notices, /Additional Term — Attribution on Product Surfaces/);
    for (const [name, entry] of Object.entries(upstream.bundledDependencies)) assert.ok(notices.includes(`${name} ${entry.version}`));
});

test('executable map hashes the archive file bytes in sorted order', () => {
    const archive = new Map([
        ['z.cjs', Buffer.from('z')], ['README.md', Buffer.from('ignored')],
        ['package.json', Buffer.from('{}')], ['a.mjs', Buffer.from('a')], ['dir/b.js', Buffer.from('b')],
    ]);
    assert.deepEqual(executableFiles(archive), {
        'a.mjs': 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
        'dir/b.js': '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d',
        'package.json': '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        'z.cjs': '594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06',
    });
    assert.throws(() => executableFiles(new Map()));
});

test('tool compatibility rejects name, order, and parameter schema drift', () => {
    const base = { format: 1, package: 'billion-context-pi', tools: [
        { name: 'compress', description: 'old', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
        { name: 'decompress', parameters: { type: 'object' } },
    ] };
    const next = structuredClone(base);
    next.tools[0].description = 'new';
    assert.doesNotThrow(() => assertCompatibleContract(base, next));
    next.tools[0].parameters.properties.x.type = 'number';
    assert.throws(() => assertCompatibleContract(base, next), /review required/);
    next.tools = structuredClone(base.tools).reverse();
    assert.throws(() => assertCompatibleContract(base, next), /review required/);
    next.tools = structuredClone(base.tools); next.tools[0].name = 'other';
    assert.throws(() => assertCompatibleContract(base, next), /review required/);
});

test('gallery extension closure meets file and byte limits', async () => {
    const paths = ['billion-context-pi-pocket.ts'];
    async function walk(relative) {
        for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
            assert.ok(!entry.name.startsWith('.') && entry.name !== 'node_modules', `Forbidden path: ${relative}/${entry.name}`);
            const path = `${relative}/${entry.name}`;
            if (entry.isDirectory()) await walk(path);
            else { assert.ok(entry.isFile(), `Non-regular file: ${path}`); paths.push(path); }
        }
    }
    await walk('billion-context-pi-pocket');
    assert.ok(paths.length <= 50, `${paths.length} files`);
    let total = 0;
    for (const path of paths) { const stat = await lstat(join(root, path)); assert.ok(stat.isFile() && stat.size <= 524288, `${path}: ${stat.size}`); total += stat.size; }
    assert.ok(total <= 2097152, `${total} bytes`);
});
