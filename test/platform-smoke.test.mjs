import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { RuntimeStore } from '../billion-context-pi-pocket/runtime.mjs';
import { ContextEpochStore } from '../billion-context-pi-pocket/context.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(repository, 'billion-context-pi-pocket/runtime-lock.json'), 'utf8'));
const pin = lock.releases.find(value => value.version === lock.current);
assert.ok(pin, 'The current reviewed pin must exist');

// No Pocket checkout, npm install, upstream execution, or live data is needed here.
// The native filesystem must really support the provided-package link and its cleanup.
test('the pinned installer and provided-package link work on the native filesystem', { timeout: 120_000 }, async t => {
    // Canonicalize the OS temp directory, not arbitrary untrusted runtime paths.
    const base = await mkdtemp(join(await realpath(tmpdir()), 'bcp-native-install-'));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 3 }));
    const root = join(base, 'runtime');
    const provided = join(base, 'provided-packages');
    const peer = join(provided, '@bcp-test/provided');
    await mkdir(peer, { recursive: true });
    await writeFile(join(peer, 'package.json'), JSON.stringify({ name: '@bcp-test/provided', version: '1.0.0', main: 'index.cjs' }));
    await writeFile(join(peer, 'index.cjs'), 'module.exports = "provided-package-fixture";\n');
    const providedFile = await realpath(join(peer, 'index.cjs'));
    let downloads = 0;
    const cache = join(homedir(), '.cache/bcp-pins', `${Buffer.from(pin.integrity.slice('sha512-'.length), 'base64').toString('hex')}.tgz`);
    const fetcher = async (url, options) => {
        assert.equal(url, pin.tarball);
        downloads++;
        try {
            const bytes = await readFile(cache);
            return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return fetch(url, options);
        }
    };
    const store = new RuntimeStore({ root, nodeModules: provided, fetcher });
    const contexts = new ContextEpochStore(join(root, 'contexts'));
    assert.equal((await store.status(lock.releases)).state, 'absent');
    assert.equal(downloads, 0, 'Loading status must not install or download');
    await contexts.observe(7, 'live-1234567890abcdef');
    const marker = join(root, 'contexts', '7.json');
    const originalMarker = await readFile(marker);
    const checkProvidedPackage = async packageDir => {
        const require = createRequire(join(packageDir, 'package.json'));
        assert.equal(await realpath(require.resolve('@bcp-test/provided')), providedFile);
    };
    const installed = await store.install(pin, { validate: checkProvidedPackage });
    assert.equal(installed.installed, true);
    assert.equal(installed.version, pin.version);
    assert.equal(downloads, 1);
    await checkProvidedPackage(installed.packageDir);
    assert.equal((await store.status(lock.releases)).installed, true);
    // A repeated owner action validates the existing cache without downloading again.
    await store.install(pin, { validate: checkProvidedPackage });
    assert.equal(downloads, 1);
    await store.uninstall();
    assert.equal((await store.status(lock.releases)).state, 'uninstalled');
    await assert.rejects(access(join(root, 'packages')), { code: 'ENOENT' });
    await assert.rejects(access(join(root, 'archives')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(marker), originalMarker, 'Uninstall must preserve context boundaries');
    await access(providedFile);
    assert.equal(downloads, 1);
});
