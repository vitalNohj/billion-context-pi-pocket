import test from 'node:test';
import assert from 'node:assert/strict';
import mutableFs, * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { RuntimeStore, unpackArchive, validatePin, fingerprint } from '../billion-context-pi-pocket/runtime.mjs';

function octal(number, width) {
  return `${number.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader({ name, type = '0', body = Buffer.alloc(0), linkname = '', prefix = '', size = body.length }) {
  const header = Buffer.alloc(512);
  assert.ok(Buffer.byteLength(name) <= 100, 'fixture name fits the tar header');
  header.write(name, 0, 100);
  header.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(0, 12), 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = type === '\0' ? 0 : type.charCodeAt(0);
  header.write(linkname, 157, 100);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function tar(entries, { end = true } = {}) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? '');
    blocks.push(tarHeader({ ...entry, body }), body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function archive(entries, options) {
  return gzipSync(tar(entries, options));
}

function pax(pairs) {
  return Buffer.concat(pairs.map(([key, value]) => {
    const suffix = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(suffix) + 1;
    while (String(length).length + Buffer.byteLength(suffix) !== length) {
      length = String(length).length + Buffer.byteLength(suffix);
    }
    return Buffer.from(`${length}${suffix}`);
  }));
}

function fixture(version = '1.2.3', extra = []) {
  const entries = [
    { name: 'package/', type: '5' },
    { name: 'package/package.json', body: `${JSON.stringify({
      name: 'billion-context-pi', version, type: 'module',
      scripts: { postinstall: 'DO NOT RUN THIS SCRIPT' },
    }, null, 2)}\n` },
    { name: 'package/index.mjs', body: 'export const installed = true;\n' },
    { name: 'package/src/worker.mjs', body: 'export default "unchanged";\n' },
    { name: 'package/asset.bin', body: Buffer.from([0, 255, 1, 2, 10]) },
    { name: 'package/empty.txt', body: '' },
    { name: 'package/.published', body: 'published byte for byte\n' },
    { name: 'package/empty-directory/', type: '5' },
    ...extra,
  ];
  const bytes = archive(entries);
  const pin = pinFor(bytes, version, entries.reduce((total, entry) => total + Buffer.byteLength(entry.body ?? ''), 0));
  return { entries, bytes, pin };
}

function pinFor(bytes, version, unpackedBytes) {
  return {
    version,
    tarball: `https://registry.npmjs.org/billion-context-pi/-/billion-context-pi-${version}.tgz`,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    archiveBytes: bytes.length,
    ...(unpackedBytes === undefined ? {} : { unpackedBytes }),
  };
}

function response(bytes, headers = { 'content-length': String(bytes.length) }) {
  return new Response(bytes, { status: 200, headers });
}

function serve(item, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(url, item.pin.tarball);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return response(item.bytes);
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function environment(t, fetcher = async () => { throw new Error('Offline: fetch is forbidden'); }) {
  // Canonicalize only the trusted OS temporary root, which can contain system symlinks on macOS.
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temporaryRoot, 'billion-runtime-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'runtime-data');
  const nodeModules = path.join(base, 'pocket-node_modules');
  const acp = path.join(base, 'acp');
  await fs.mkdir(nodeModules, { mode: 0o700 });
  await fs.mkdir(acp, { mode: 0o700 });
  await fs.writeFile(path.join(acp, 'session.json'), '{"keep":"ACP state"}\n');
  return { base, root, nodeModules, acp, store: new RuntimeStore({ root, nodeModules, fetcher }) };
}

async function absent(location) {
  await assert.rejects(fs.lstat(location), { code: 'ENOENT' });
}

async function assertLinkTarget(location, expected) {
  const actual = await fs.readlink(location);
  assert.ok(path.isAbsolute(actual));
  assert.equal(path.toNamespacedPath(actual), path.toNamespacedPath(expected));
}

async function assertSelected(store, pin, busy = false) {
  assert.deepEqual(await store.selection(), { format: 1, state: 'installed', version: pin.version, fingerprint: fingerprint(pin) });
  const resolved = await store.resolve([pin]);
  assert.equal(resolved.version, pin.version);
  assert.equal(resolved.installed, true);
  assert.equal(resolved.busy, busy);
}

async function ownStages(root) {
  return (await fs.readdir(root)).filter(name => name.startsWith('.stage-') || name.startsWith('.selection-'));
}

async function recoveryDirectories(root) {
  return (await fs.readdir(root)).filter(name => name.startsWith('.recovery-')).map(name => path.join(root, name));
}

async function contextsSentinel(root) {
  const contexts = path.join(root, 'contexts');
  await fs.mkdir(contexts, { recursive: true, mode: 0o700 });
  const location = path.join(contexts, 'user-state.json');
  await fs.writeFile(location, '{"keep":"user context"}\n');
  const stat = await fs.lstat(location);
  return {
    contexts, location,
    assertUnchanged: async () => {
      const current = await fs.lstat(location);
      assert.equal(current.dev, stat.dev);
      assert.equal(current.ino, stat.ino);
      assert.equal(current.mtimeMs, stat.mtimeMs);
      assert.equal(await fs.readFile(location, 'utf8'), '{"keep":"user context"}\n');
    },
  };
}

test('validates strict stable pins and canonical SHA512 integrity', () => {
  const item = fixture();
  assert.deepEqual(validatePin(item.pin), item.pin);
  assert.equal(fingerprint(item.pin), createHash('sha256').update(item.pin.integrity).digest('hex'));
  assert.match(fingerprint(item.pin), /^[a-f0-9]{64}$/);
  const { archiveBytes, unpackedBytes, ...withoutSizes } = item.pin;
  assert.deepEqual(validatePin(withoutSizes), withoutSizes);
  for (const version of ['v1.2.3', '01.2.3', '1.02.3', '1.2', '1.2.3-rc.1', '1.2.3+build', '1.2.3\n', '9007199254740992.0.0']) {
    assert.throws(() => validatePin({ ...item.pin, version }), /version/);
  }
  for (const tarball of [item.pin.tarball.replace('https:', 'http:'), `${item.pin.tarball}?x=1`,
    item.pin.tarball.replace('registry.npmjs.org', 'registry.npmjs.org.evil.test'), item.pin.tarball.replace('1.2.3', '2.0.0')]) {
    assert.throws(() => validatePin({ ...item.pin, tarball }), /tarball/);
  }
  for (const integrity of ['', item.pin.integrity.slice(0, -1), `${item.pin.integrity} ${item.pin.integrity}`,
    item.pin.integrity.replace('sha512-', 'sha256-'), `sha512-${'A'.repeat(85)}B==`]) {
    assert.throws(() => validatePin({ ...item.pin, integrity }), /integrity/);
  }
  for (const [key, values] of [['archiveBytes', [0, -1, 1.5, null, '1', 16 * 1024 * 1024 + 1]],
    ['unpackedBytes', [-1, 1.5, null, Infinity, 64 * 1024 * 1024 + 1]]]) {
    for (const value of values) assert.throws(() => validatePin({ ...item.pin, [key]: value }), new RegExp(key));
  }
  for (const bad of [null, [], 'pin']) assert.throws(() => validatePin(bad), /pin/);
});

test('installs unchanged full package bytes, then resolves and loads a cached pin offline', async t => {
  const item = fixture();
  const calls = [];
  const env = await environment(t, serve(item, calls));
  assert.equal(await env.store.selection(), null);
  assert.deepEqual(await env.store.status([]), { state: 'absent', installed: false, busy: false });
  await absent(env.root);
  let validations = 0;
  const installed = await env.store.install(item.pin, { validate: async (packageDir, pin) => {
    validations++;
    assert.ok(packageDir.startsWith(path.join(env.root, '.stage-')));
    assert.deepEqual(pin, item.pin);
    assert.equal(await env.store.selection(), null);
    assert.equal((await fs.readFile(path.join(packageDir, 'index.mjs'))).toString(), 'export const installed = true;\n');
  } });
  assert.equal(validations, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(installed, {
    state: 'installed', installed: true, version: item.pin.version, fingerprint: fingerprint(item.pin),
    packageDir: path.join(env.root, 'packages', fingerprint(item.pin), 'package'), busy: false,
  });
  const files = await unpackArchive(item.bytes);
  for (const [relative, bytes] of files) assert.deepEqual(await fs.readFile(path.join(installed.packageDir, relative)), bytes);
  assert.equal((await fs.stat(path.join(installed.packageDir, 'empty-directory'))).isDirectory(), true);
  const retained = path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`);
  assert.deepEqual(await fs.readFile(retained), item.bytes);
  await assertLinkTarget(path.join(path.dirname(installed.packageDir), 'node_modules'), env.nodeModules);
  for (const location of [env.root, path.dirname(retained), path.dirname(installed.packageDir), installed.packageDir]) {
    assert.equal((await fs.stat(location)).mode & 0o077, 0);
  }
  for (const location of [retained, path.join(env.root, 'selection.json'), path.join(installed.packageDir, 'package.json')]) {
    assert.equal((await fs.stat(location)).mode & 0o077, 0);
  }
  const offline = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async () => { assert.fail('Must not fetch cached bytes'); } });
  await assertSelected(offline, item.pin);
  assert.deepEqual(await offline.status([item.pin]), installed);
  assert.deepEqual(await offline.install(item.pin), installed);
  assert.deepEqual(await ownStages(env.root), []);
});

test('normal install succeeds when directory renames onto existing directories are rejected', async t => {
  const item = fixture();
  const env = await environment(t, serve(item));
  const originalRename = mutableFs.rename;
  let directoryOverwrites = 0;
  let selectionCommits = 0;
  t.mock.method(mutableFs, 'rename', async (source, destination) => {
    const sourceStat = await fs.lstat(source);
    if (sourceStat.isDirectory()) {
      const destinationStat = await fs.lstat(destination).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (destinationStat?.isDirectory()) {
        directoryOverwrites++;
        const error = new Error('Directory rename cannot overwrite an existing directory');
        error.code = 'EEXIST';
        throw error;
      }
    }
    if (destination === path.join(env.root, 'selection.json')) selectionCommits++;
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    const installed = await env.store.install(item.pin, { validate: async () => {
      await absent(path.join(env.root, 'packages', fingerprint(item.pin)));
      assert.equal(await env.store.selection(), null);
    } });
    assert.equal(directoryOverwrites, 0);
    assert.equal(selectionCommits, 1);
    await assertSelected(env.store, item.pin);
    for (const [relative, bytes] of await unpackArchive(item.bytes)) {
      assert.deepEqual(await fs.readFile(path.join(installed.packageDir, relative)), bytes);
    }
    assert.deepEqual(await ownStages(env.root), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('failed final bundle materialization or inspection removes only owned objects and preserves the old selection', async t => {
  const old = fixture('1.3.0');
  const next = fixture('1.4.0');
  for (const label of ['write failure', 'inspection failure', 'unexpected destination']) {
    await t.test(label, async sub => {
      const env = await environment(sub, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
      await env.store.install(old.pin);
      const pointerBefore = await fs.readFile(path.join(env.root, 'selection.json'));
      const final = path.join(env.root, 'packages', fingerprint(next.pin));
      const file = path.join(final, 'package', 'index.mjs');
      const originalOpen = mutableFs.open;
      const originalSymlink = mutableFs.symlink;
      let injected = false;
      sub.mock.method(mutableFs, 'open', async (location, ...args) => {
        if (label === 'write failure' && location === file) {
          injected = true;
          throw new Error('injected final bundle write failure');
        }
        return originalOpen(location, ...args);
      });
      sub.mock.method(mutableFs, 'symlink', async (target, location, type) => {
        await originalSymlink(target, location, type);
        if (label === 'inspection failure' && location === path.join(final, 'node_modules')) {
          injected = true;
          await fs.writeFile(file, 'corrupt final bytes');
        }
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(env.store.install(next.pin, { validate: async () => {
          if (label === 'unexpected destination') {
            injected = true;
            await fs.mkdir(final, { mode: 0o700 });
            await fs.writeFile(path.join(final, 'owner-sentinel'), 'must not overwrite or delete');
          }
        } }), /injected final bundle write failure|file mismatch|EEXIST/);
      } finally {
        sub.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(injected, true);
      await assertSelected(env.store, old.pin);
      assert.deepEqual(await fs.readFile(path.join(env.root, 'selection.json')), pointerBefore);
      if (label === 'unexpected destination') {
        assert.deepEqual(await fs.readdir(final), ['owner-sentinel']);
        assert.equal(await fs.readFile(path.join(final, 'owner-sentinel'), 'utf8'), 'must not overwrite or delete');
      } else await absent(final);
      assert.deepEqual(await ownStages(env.root), []);
    });
  }
});

test('cancellation after final verification keeps a complete offline cache without changing the old selection', async t => {
  const old = fixture('1.5.0');
  const next = fixture('1.6.0');
  const env = await environment(t, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
  await env.store.install(old.pin);
  const pointerBefore = await fs.readFile(path.join(env.root, 'selection.json'));
  const caller = new AbortController();
  const originalRmdir = mutableFs.rmdir;
  let canceled = false;
  t.mock.method(mutableFs, 'rmdir', async (location, ...args) => {
    await originalRmdir(location, ...args);
    if (path.dirname(location) === env.root && path.basename(location).startsWith('.stage-')) {
      canceled = true;
      caller.abort(new Error('canceled after final verification'));
    }
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(env.store.install(next.pin, { signal: caller.signal }), /canceled after final verification/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(canceled, true);
  await assertSelected(env.store, old.pin);
  assert.deepEqual(await fs.readFile(path.join(env.root, 'selection.json')), pointerBefore);
  assert.deepEqual(await ownStages(env.root), []);
  const offline = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules,
    fetcher: async () => assert.fail('The complete verified final cache must survive the cancellation') });
  await offline.install(next.pin);
  await assertSelected(offline, next.pin);
});

test('owned SDK links keep the absolute target and use the platform directory-link type', async t => {
  const item = fixture();
  const env = await environment(t, serve(item));
  const calls = [];
  const originalSymlink = mutableFs.symlink;
  t.mock.method(mutableFs, 'symlink', async (target, location, type) => {
    calls.push({ target, location, type });
    return originalSymlink(target, location, type);
  });
  syncBuiltinESMExports();
  try {
    await env.store.install(item.pin);
    assert.equal(calls.length, 2, 'Both the staging and final bundles must use the owned SDK link helper');
    for (const call of calls) {
      assert.equal(call.target, env.nodeModules);
      assert.ok(path.isAbsolute(call.target));
      assert.equal(call.type, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(path.basename(call.location), 'node_modules');
    }
    assert.ok(calls[0].location.startsWith(path.join(env.root, '.stage-')));
    assert.equal(calls[1].location, path.join(env.root, 'packages', fingerprint(item.pin), 'node_modules'));
    await assertSelected(env.store, item.pin);
    await env.store.uninstall();
    assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('peer target comparison rejects relative targets, keeps POSIX byte equality, and accepts Windows namespace forms', async t => {
  const item = fixture();
  for (const label of ['relative', 'different absolute', 'equivalent absolute spelling', 'namespace form']) {
    await t.test(label, async sub => {
      const env = await environment(sub, serve(item));
      const installed = await env.store.install(item.pin);
      const peer = path.join(path.dirname(installed.packageDir), 'node_modules');
      const target = {
        relative: path.relative(path.dirname(peer), env.nodeModules),
        'different absolute': env.acp,
        'equivalent absolute spelling': `${env.nodeModules}${path.sep}.`,
        'namespace form': path.toNamespacedPath(env.nodeModules),
      }[label];
      const accepts = label === 'namespace form'
        || (label === 'equivalent absolute spelling' && process.platform === 'win32');
      const originalReadlink = mutableFs.readlink;
      const originalStat = mutableFs.stat;
      sub.mock.method(mutableFs, 'readlink', async (location, ...args) => location === peer ? target : originalReadlink(location, ...args));
      sub.mock.method(mutableFs, 'realpath', async () => assert.fail('Peer comparison must not follow a link with realpath'));
      sub.mock.method(mutableFs, 'stat', async (location, ...args) => {
        assert.equal(location, env.nodeModules, 'Only the provided SDK directory can be followed');
        return originalStat(location, ...args);
      });
      syncBuiltinESMExports();
      try {
        if (accepts) await assertSelected(env.store, item.pin);
        else await assert.rejects(env.store.resolve([item.pin]), /peer link target mismatch/);
      } finally {
        sub.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  }
});

test('owned-link cleanup uses the same platform target comparison as resolve', async t => {
  const item = fixture();
  const env = await environment(t, serve(item));
  const installed = await env.store.install(item.pin);
  const peer = path.join(path.dirname(installed.packageDir), 'node_modules');
  const originalReadlink = mutableFs.readlink;
  let peerReads = 0;
  t.mock.method(mutableFs, 'readlink', async (location, ...args) => {
    if (location !== peer) return originalReadlink(location, ...args);
    return ++peerReads === 1 ? env.nodeModules : `${env.nodeModules}${path.sep}.`;
  });
  syncBuiltinESMExports();
  try {
    if (process.platform === 'win32') await env.store.uninstall();
    else await assert.rejects(env.store.uninstall(), /Changed runtime peer link/);
    assert.equal(peerReads, 2);
    assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('updates the selection, retains the old package and archive, and supports offline rollback', async t => {
  const old = fixture('1.0.0');
  const next = fixture('1.1.0');
  const env = await environment(t, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
  const oldStatus = await env.store.install(old.pin);
  await env.store.install(next.pin, { validate: async () => { await assertSelected(env.store, old.pin, true); } });
  await assertSelected(env.store, next.pin);
  assert.equal((await fs.stat(oldStatus.packageDir)).isDirectory(), true);
  assert.deepEqual(await fs.readFile(path.join(env.root, 'archives', `${fingerprint(old.pin)}.tgz`)), old.bytes);
  const offline = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async () => { throw new Error('offline'); } });
  await offline.install(old.pin);
  await assertSelected(offline, old.pin);
  assert.equal((await fs.stat(path.join(env.root, 'packages', fingerprint(next.pin), 'package'))).isDirectory(), true);
});

test('bad integrity and exact size failures preserve the old selection', async t => {
  const old = fixture('2.0.0');
  const next = fixture('2.1.0');
  const env = await environment(t, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
  await env.store.install(old.pin);
  const otherIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  for (const [pin, error] of [
    [{ ...next.pin, integrity: otherIntegrity }, /integrity mismatch/],
    [{ ...next.pin, archiveBytes: next.bytes.length + 1 }, /size mismatch/],
    [{ ...next.pin, archiveBytes: next.bytes.length - 1 }, /size mismatch/],
    [{ ...next.pin, unpackedBytes: next.pin.unpackedBytes + 1 }, /unpacked size mismatch/],
  ]) {
    await assert.rejects(env.store.install(pin), error);
    await assertSelected(env.store, old.pin);
    assert.deepEqual(await ownStages(env.root), []);
  }
  const noLength = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async () => response(next.bytes, {}) });
  await assert.rejects(noLength.install({ ...next.pin, archiveBytes: next.bytes.length - 1 }), /compressed size limit/);
  await assert.rejects(noLength.install({ ...next.pin, archiveBytes: next.bytes.length + 1 }), /size mismatch/);
  const wrongMetadata = { ...next.pin, version: '2.2.0', tarball: next.pin.tarball.replace('2.1.0', '2.2.0') };
  await assert.rejects(noLength.install(wrongMetadata), /metadata mismatch/);
  await assertSelected(env.store, old.pin);
});

test('rejects redirect responses and truncated Content-Length bodies', async t => {
  const item = fixture();
  const env = await environment(t);
  for (const fetcher of [
    async () => new Response(null, { status: 302, headers: { location: item.pin.tarball } }),
    async () => ({ status: 200, redirected: true, url: item.pin.tarball }),
    async () => ({ status: 200, redirected: false, url: 'https://evil.test/archive.tgz' }),
  ]) {
    const store = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher });
    await assert.rejects(store.install(item.pin), /pinned URL/);
    assert.equal(await store.selection(), null);
  }
  const short = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules,
    fetcher: async () => response(item.bytes.subarray(0, item.bytes.length - 2), { 'content-length': String(item.bytes.length) }) });
  await assert.rejects(short.install(item.pin), /Interrupted runtime download/);
});

test('a broken download preserves the old selection and releases the operation lock', async t => {
  const old = fixture('3.0.0');
  const next = fixture('3.1.0');
  const env = await environment(t, serve(old));
  await env.store.install(old.pin);
  const broken = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(next.bytes.subarray(0, 20));
      controller.error(new Error('download connection lost'));
    },
  })) });
  await assert.rejects(broken.install(next.pin), /download connection lost/);
  await assertSelected(env.store, old.pin);
  assert.deepEqual(await ownStages(env.root), []);
});

test('caller cancellation interrupts a pending stream, preserves selection, and permits a retry', async t => {
  const old = fixture('3.2.0');
  const next = fixture('3.3.0');
  const env = await environment(t, serve(old));
  await env.store.install(old.pin);
  const started = deferred();
  const canceled = deferred();
  let fetchSignal;
  const hanging = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async (_url, { signal }) => {
    fetchSignal = signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(next.bytes.subarray(0, 20)); },
      pull() { started.resolve(); },
      cancel() { canceled.resolve(); },
    }));
  } });
  const caller = new AbortController();
  const operation = hanging.install(next.pin, { signal: caller.signal });
  const rejected = assert.rejects(operation, /cancel runtime download/);
  await started.promise;
  caller.abort(new Error('cancel runtime download'));
  await rejected;
  assert.equal(fetchSignal.aborted, true);
  await canceled.promise;
  await assertSelected(env.store, old.pin);
  assert.deepEqual(await ownStages(env.root), []);
  const retry = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: serve(next) });
  await retry.install(next.pin);
  await assertSelected(retry, next.pin);
});

test('an already aborted signal does not fetch or create the runtime root', async t => {
  const env = await environment(t, async () => assert.fail('Must not fetch'));
  const caller = new AbortController();
  caller.abort(new Error('already canceled'));
  await assert.rejects(env.store.install(fixture().pin, { signal: caller.signal }), /already canceled/);
  await absent(env.root);
});

test('validation failure and cancellation remove only their own stages', async t => {
  const old = fixture('4.0.0');
  const next = fixture('4.1.0');
  const env = await environment(t, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
  await env.store.install(old.pin);
  let stagedDir;
  await assert.rejects(env.store.install(next.pin, { validate: async packageDir => {
    stagedDir = packageDir;
    await assertSelected(env.store, old.pin, true);
    throw new Error('runtime validation failed');
  } }), /runtime validation failed/);
  await absent(stagedDir);
  await absent(path.join(env.root, 'packages', fingerprint(next.pin)));
  await absent(path.join(env.root, 'archives', `${fingerprint(next.pin)}.tgz`));
  await assertSelected(env.store, old.pin);
  const caller = new AbortController();
  await assert.rejects(env.store.install(next.pin, { signal: caller.signal, validate: async () => {
    caller.abort(new Error('canceled during validation'));
  } }), /canceled during validation/);
  await assertSelected(env.store, old.pin);
  assert.deepEqual(await ownStages(env.root), []);
});

test('concurrent mutations are rejected across instances, normalized roots, and hot module reloads', async t => {
  const item = fixture();
  const entered = deferred();
  const release = deferred();
  const env = await environment(t, async () => { entered.resolve(); await release.promise; return response(item.bytes); });
  const first = env.store.install(item.pin);
  const completion = first.then(value => value, error => { throw error; });
  await entered.promise;
  const reloaded = await import('../billion-context-pi-pocket/runtime.mjs?runtime-unit-hot-reload');
  const second = new reloaded.RuntimeStore({ root: path.join(env.root, '..', path.basename(env.root), '.'),
    nodeModules: env.nodeModules, fetcher: serve(item) });
  try {
    assert.deepEqual(await second.status([]), { state: 'absent', installed: false, busy: true });
    await assert.rejects(second.install(item.pin), /busy/);
    await assert.rejects(second.repair(item.pin), /busy/);
    await assert.rejects(second.uninstall(), /busy/);
    await assert.rejects(second.uninstall({ recover: true }), /busy/);
  } finally { release.resolve(); }
  await completion;
  await assertSelected(second, item.pin);
  assert.equal((await second.status([item.pin])).busy, false);
});

test('an interrupted stage is neither selected, followed, nor deleted by a later operation', async t => {
  const item = fixture();
  const env = await environment(t, serve(item));
  const residue = path.join(env.root, '.stage-interrupted');
  await fs.mkdir(residue, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(residue, 'partial-package'), 'interrupted bytes');
  await fs.symlink(env.acp, path.join(residue, 'node_modules'), 'dir');
  assert.equal(await env.store.selection(), null);
  assert.equal((await env.store.resolve([item.pin])).state, 'absent');
  await env.store.install(item.pin);
  await assertSelected(env.store, item.pin);
  assert.equal(await fs.readFile(path.join(residue, 'partial-package'), 'utf8'), 'interrupted bytes');
  await env.store.uninstall();
  await assertLinkTarget(path.join(residue, 'node_modules'), env.acp);
  assert.equal(await fs.readFile(path.join(env.acp, 'session.json'), 'utf8'), '{"keep":"ACP state"}\n');
});

test('a verified archive-only cache can finish an interrupted publication without fetching', async t => {
  const item = fixture();
  const env = await environment(t);
  await fs.mkdir(path.join(env.root, 'archives'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`), item.bytes, { mode: 0o600 });
  await env.store.install(item.pin);
  await assertSelected(env.store, item.pin);
});

test('unpackArchive preserves regular file bytes and supports safe PAX path and size fields', async () => {
  const item = fixture();
  const files = await unpackArchive(item.bytes);
  assert.ok(files instanceof Map);
  assert.deepEqual(files.get('asset.bin'), Buffer.from([0, 255, 1, 2, 10]));
  assert.deepEqual(files.get('empty.txt'), Buffer.alloc(0));
  assert.equal(files.has('empty-directory'), false);
  const longPath = `package/${'a'.repeat(110)}/日本語.txt`;
  const body = Buffer.from('PAX payload\n');
  const withPax = archive([
    { name: 'package/PaxHeader', type: 'x', body: pax([['path', longPath], ['size', String(body.length)], ['mtime', '1.5']]) },
    { name: 'package/placeholder', body, size: 0 },
  ]);
  assert.deepEqual((await unpackArchive(withPax)).get(longPath.slice(8)), body);
  const prefixed = archive([{ name: 'entry.txt', prefix: 'package/nested', body: 'ustar prefix' }]);
  assert.equal((await unpackArchive(prefixed)).get('nested/entry.txt').toString(), 'ustar prefix');
});

test('author-side entry limits permit larger archives and bound headers plus inferred directories', async () => {
  const entries = Array.from({ length: 513 }, (_, i) => ({ name: `package/file-${i}`, body: 'x' }));
  const flat = archive(entries);
  await assert.rejects(unpackArchive(flat), /exceeds 512 entries/);
  await assert.rejects(unpackArchive(flat, { maxEntries: 512 }), /exceeds 512 entries/);
  const files = await unpackArchive(flat, { maxEntries: 513 });
  assert.equal(files.size, 513);
  for (const [relative, bytes] of files) {
    assert.match(relative, /^file-[0-9]+$/);
    assert.deepEqual(bytes, Buffer.from('x'));
  }

  const nested = archive(entries.map((entry, i) => ({ ...entry, name: `package/dir-${i}/file` })));
  await assert.rejects(unpackArchive(nested), /exceeds 512 filesystem entries/);
  await assert.rejects(unpackArchive(nested, { maxEntries: 1025 }), /exceeds 1025 filesystem entries/);
  assert.equal((await unpackArchive(nested, { maxEntries: 1026 })).size, 513);
});

test('archive entry limits reject non-integers and values outside 1 through 16384', async () => {
  const bytes = archive([{ name: 'package/file', body: 'x' }]);
  for (const maxEntries of [0, -1, 1.5, NaN, Infinity, -Infinity, 16385, '513', null, {}, 513n]) {
    await assert.rejects(unpackArchive(bytes, { maxEntries }), /entry limit: expected an integer from 1 to 16384/);
  }
  for (const maxEntries of [1, 16384, undefined]) {
    assert.deepEqual((await unpackArchive(bytes, { maxEntries })).get('file'), Buffer.from('x'));
  }
});

test('rejects malicious paths, link types, checksums, duplicate entries, and file/directory conflicts', async () => {
  for (const name of ['package/../escape', 'package/a/../../escape', '/package/file', 'C:/file', 'package/C:/file',
    'package/a\\..\\escape', 'package//file', 'package/./file', 'elsewhere/file', 'package/file/', 'package']) {
    await assert.rejects(unpackArchive(archive([{ name, body: 'bad' }])), /path|prefix/);
  }
  for (const type of ['1', '2', '3', '4', '6', 'L', 'K', 'g', 'S']) {
    await assert.rejects(unpackArchive(archive([{ name: 'package/link', type, linkname: '../../acp/session.json' }])), /entry type/);
  }
  await assert.rejects(unpackArchive(archive([{ name: 'package/file', body: 'bad', linkname: 'hidden link' }])), /links/);
  const badChecksum = tar([{ name: 'package/file', body: 'bytes' }]);
  badChecksum[0] ^= 1;
  await assert.rejects(unpackArchive(gzipSync(badChecksum)), /checksum/);
  await assert.rejects(unpackArchive(archive([{ name: 'package/file', body: 'one' }, { name: 'package/file', body: 'two' }])), /Duplicate/);
  await assert.rejects(unpackArchive(archive([{ name: 'package/dir/', type: '5' }, { name: 'package/dir', body: 'file' }])), /Duplicate|conflict/);
  await assert.rejects(unpackArchive(archive([{ name: 'package/parent', body: 'file' }, { name: 'package/parent/child', body: 'child' }])), /conflict/);
  await assert.rejects(unpackArchive(archive([{ name: 'file', prefix: 'package/..', body: 'bad' }])), /path/);
});

test('rejects unsafe PAX forms and duplicate PAX-selected paths', async () => {
  for (const fields of [
    [['path', 'package/../../acp/session.json']],
    [['path', '/absolute/file']],
    [['path', 'package/a\\b']],
    [['path', 'elsewhere/file']],
    [['linkpath', '../../acp/session.json']],
    [['GNU.sparse.map', '0,1']],
    [['size', '-1']],
    [['size', '1.5']],
    [['size', '16777217']],
    [['path', 'package/one'], ['path', 'package/two']],
  ]) {
    await assert.rejects(unpackArchive(archive([
      { name: 'package/PaxHeader', type: 'x', body: pax(fields) },
      { name: 'package/file', body: '' },
    ])), /PAX|path|prefix/);
  }
  await assert.rejects(unpackArchive(archive([
    { name: 'package/same', body: 'first' },
    { name: 'package/PaxHeader', type: 'x', body: pax([['path', 'package/same']]) },
    { name: 'package/other', body: 'second' },
  ])), /Duplicate/);
  await assert.rejects(unpackArchive(archive([{ name: 'package/PaxHeader', type: 'x', body: Buffer.from('99 path=package/file\n') }])), /PAX/);
  await assert.rejects(unpackArchive(archive([{ name: 'package/PaxHeader', type: 'x', body: pax([['path', 'package/file']]) }])), /Incomplete/);
});

test('rejects truncated archives, incomplete end markers, oversized files, and excess entries', async () => {
  await assert.rejects(unpackArchive(Buffer.from('not gzip')));
  const item = fixture();
  await assert.rejects(unpackArchive(item.bytes.subarray(0, item.bytes.length - 5)));
  await assert.rejects(unpackArchive(archive([{ name: 'package/file', body: 'x' }], { end: false })), /Incomplete/);
  await assert.rejects(unpackArchive(gzipSync(Buffer.alloc(512))), /end marker/);
  await assert.rejects(unpackArchive(archive([{ name: 'package/huge', size: 16 * 1024 * 1024 + 1 }])), /per-file/);
  const entries = Array.from({ length: 513 }, (_, i) => ({ name: `package/file-${i}`, body: '' }));
  await assert.rejects(unpackArchive(archive(entries)), /512/);
  const badPadding = tar([{ name: 'package/file', body: 'x' }]);
  badPadding[514] = 1;
  await assert.rejects(unpackArchive(gzipSync(badPadding)), /payload/);
  const trailing = Buffer.concat([tar([{ name: 'package/file', body: 'x' }]), Buffer.alloc(512, 1)]);
  await assert.rejects(unpackArchive(gzipSync(trailing)), /end marker/);
});

test('resolve detects file, directory, link, archive, and package metadata corruption without fetching', async t => {
  const item = fixture();
  for (const [label, corrupt, pattern] of [
    ['changed file', async dir => fs.writeFile(path.join(dir, 'index.mjs'), 'tampered'), /file mismatch/],
    ['missing file', async dir => fs.unlink(path.join(dir, 'asset.bin')), /files are missing/],
    ['extra file', async dir => fs.writeFile(path.join(dir, 'unexpected'), 'extra'), /Unexpected/],
    ['extra empty directory', async dir => fs.mkdir(path.join(dir, 'extra-dir')), /Unexpected/],
    ['symlink', async (dir, env) => { await fs.unlink(path.join(dir, 'index.mjs')); await fs.symlink(path.join(env.acp, 'session.json'), path.join(dir, 'index.mjs')); }, /contains a link/],
    ['hard link', async (dir, env) => { const outside = path.join(env.base, 'outside.mjs'); await fs.copyFile(path.join(dir, 'index.mjs'), outside); await fs.unlink(path.join(dir, 'index.mjs')); await fs.link(outside, path.join(dir, 'index.mjs')); }, /hard link/],
    ['metadata', async dir => fs.writeFile(path.join(dir, 'package.json'), '{"name":"other","version":"1.2.3"}'), /file mismatch/],
  ]) {
    await t.test(label, async sub => {
      const env = await environment(sub, serve(item));
      const installed = await env.store.install(item.pin);
      await corrupt(installed.packageDir, env);
      const offline = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async () => assert.fail('Must not fetch') });
      await assert.rejects(offline.resolve([item.pin]), pattern);
      await assert.rejects(offline.install(item.pin), pattern);
    });
  }
  await t.test('archive bytes', async sub => {
    const env = await environment(sub, serve(item));
    await env.store.install(item.pin);
    const damaged = Buffer.from(item.bytes);
    damaged[damaged.length - 1] ^= 1;
    await fs.writeFile(path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`), damaged);
    await assert.rejects(env.store.resolve([item.pin]), /integrity mismatch/);
  });
  await t.test('pin allowlist', async sub => {
    const env = await environment(sub, serve(item));
    await env.store.install(item.pin);
    await assert.rejects(env.store.resolve([]), /not an allowed pin/);
    await assert.rejects(env.store.resolve([fixture('9.0.0').pin]), /not an allowed pin/);
  });
});

test('rejects tampered peer links and preserves the uninstall marker after cleanup fails', async t => {
  const item = fixture();
  const env = await environment(t, serve(item));
  const installed = await env.store.install(item.pin);
  const peer = path.join(path.dirname(installed.packageDir), 'node_modules');
  await fs.unlink(peer);
  await fs.symlink(env.acp, peer, 'dir');
  await assert.rejects(env.store.resolve([item.pin]), /peer link target mismatch/);
  await assert.rejects(env.store.uninstall(), /peer link target mismatch/);
  assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
  assert.deepEqual(await env.store.resolve([item.pin]), { state: 'uninstalled', installed: false, busy: false });
  await assertLinkTarget(peer, env.acp);
  assert.equal(await fs.readFile(path.join(env.acp, 'session.json'), 'utf8'), '{"keep":"ACP state"}\n');
});

test('rejects symlink roots, controlled directories, selection files, and unexpected cache objects', async t => {
  const item = fixture();
  await t.test('root', async sub => {
    const env = await environment(sub, serve(item));
    await fs.symlink(env.acp, env.root, 'dir');
    await assert.rejects(env.store.selection(), /Unsafe runtime directory/);
    await assert.rejects(env.store.install(item.pin), /Unsafe runtime directory/);
    await absent(path.join(env.acp, 'selection.json'));
  });
  for (const child of ['packages', 'archives']) {
    await t.test(child, async sub => {
      const env = await environment(sub, serve(item));
      await fs.mkdir(env.root);
      await fs.symlink(env.acp, path.join(env.root, child), 'dir');
      await assert.rejects(env.store.install(item.pin), /Unsafe runtime directory/);
      await assert.rejects(env.store.uninstall(), /Unsafe runtime directory/);
      assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
      await assertLinkTarget(path.join(env.root, child), env.acp);
    });
  }
  await t.test('selection', async sub => {
    const env = await environment(sub, serve(item));
    await fs.mkdir(env.root);
    await fs.symlink(path.join(env.acp, 'session.json'), path.join(env.root, 'selection.json'));
    await assert.rejects(env.store.selection(), /Unsafe runtime file/);
    await assert.rejects(env.store.install(item.pin), /Unsafe runtime file/);
    assert.equal(await fs.readFile(path.join(env.acp, 'session.json'), 'utf8'), '{"keep":"ACP state"}\n');
  });
  await t.test('archive', async sub => {
    const env = await environment(sub, serve(item));
    await fs.mkdir(path.join(env.root, 'archives'), { recursive: true });
    const location = path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`);
    await fs.symlink(path.join(env.acp, 'session.json'), location);
    await assert.rejects(env.store.install(item.pin), /Unsafe runtime file/);
    await assertLinkTarget(location, path.join(env.acp, 'session.json'));
  });
  await t.test('unrecognized package object', async sub => {
    const env = await environment(sub, serve(item));
    const location = path.join(env.root, 'packages', fingerprint(item.pin));
    await fs.mkdir(location, { recursive: true });
    await fs.writeFile(path.join(location, 'unrelated'), 'keep');
    await assert.rejects(env.store.install(item.pin), /Unexpected runtime cache object/);
    assert.equal(await fs.readFile(path.join(location, 'unrelated'), 'utf8'), 'keep');
  });
});

test('uninstall removes retained versions but preserves the sibling ACP directory and the explicit opt-out', async t => {
  const old = fixture('5.0.0');
  const next = fixture('5.1.0');
  const env = await environment(t, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
  const acpBefore = await fs.stat(env.acp);
  await env.store.install(old.pin);
  await env.store.install(next.pin);
  assert.deepEqual(await env.store.uninstall(), { state: 'uninstalled', installed: false, busy: false });
  assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
  assert.deepEqual(await env.store.status([old.pin, next.pin]), { state: 'uninstalled', installed: false, busy: false });
  assert.equal((await fs.stat(env.acp)).ino, acpBefore.ino);
  assert.equal(await fs.readFile(path.join(env.acp, 'session.json'), 'utf8'), '{"keep":"ACP state"}\n');
  await absent(path.join(env.root, 'packages'));
  await absent(path.join(env.root, 'archives'));
  assert.deepEqual(await env.store.uninstall(), { state: 'uninstalled', installed: false, busy: false });
  await env.store.install(next.pin);
  await assertSelected(env.store, next.pin);
});

test('uninstall does not delete an unexpected archive object or restore the installed pointer', async t => {
  const item = fixture();
  const env = await environment(t, serve(item));
  await env.store.install(item.pin);
  const unrelated = path.join(env.root, 'archives', 'not-our-file');
  await fs.writeFile(unrelated, 'do not delete');
  await assert.rejects(env.store.uninstall(), /Unexpected object in runtime archives/);
  assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'do not delete');
  assert.equal((await env.store.status([item.pin])).busy, false);
});

test('repair recovers malformed selection, missing or modified package files, and a missing archive', async t => {
  const item = fixture('6.0.0');
  for (const label of ['malformed selection', 'missing file', 'modified file', 'missing archive']) {
    await t.test(label, async sub => {
      const calls = [];
      const env = await environment(sub, serve(item, calls));
      const installed = await env.store.install(item.pin);
      const contexts = await contextsSentinel(env.root);
      const archive = path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`);
      if (label === 'malformed selection') await fs.writeFile(path.join(env.root, 'selection.json'), '{not valid JSON\n');
      if (label === 'missing file') await fs.unlink(path.join(installed.packageDir, 'index.mjs'));
      if (label === 'modified file') await fs.writeFile(path.join(installed.packageDir, 'index.mjs'), 'modified bytes');
      if (label === 'missing archive') await fs.unlink(archive);
      const pointerBefore = await fs.readFile(path.join(env.root, 'selection.json'));
      const packagesBefore = await fs.lstat(path.join(env.root, 'packages'));
      await assert.rejects(env.store.resolve([item.pin]));
      const result = await env.store.repair(item.pin, { validate: async (packageDir, pin) => {
        assert.ok(packageDir.startsWith(path.join(env.root, '.recovery-')));
        assert.deepEqual(pin, item.pin);
        assert.deepEqual(await fs.readFile(path.join(env.root, 'selection.json')), pointerBefore);
        assert.equal((await fs.lstat(path.join(env.root, 'packages'))).ino, packagesBefore.ino);
        assert.equal(await fs.readFile(path.join(packageDir, 'index.mjs'), 'utf8'), 'export const installed = true;\n');
      } });
      assert.equal(result.packageDir, installed.packageDir);
      assert.equal(calls.length, label === 'missing archive' ? 2 : 1);
      await assertSelected(env.store, item.pin);
      const directories = await recoveryDirectories(env.root);
      assert.equal(directories.length, 1);
      const previous = path.join(directories[0], 'previous');
      assert.deepEqual((await fs.readdir(previous)).sort(), ['archives', 'packages', 'selection.json']);
      assert.equal((await fs.lstat(path.join(previous, 'packages'))).ino, packagesBefore.ino);
      assert.deepEqual(await fs.readFile(path.join(previous, 'selection.json')), pointerBefore);
      assert.equal((await fs.stat(directories[0])).mode & 0o077, 0);
      assert.equal((await fs.stat(previous)).mode & 0o077, 0);
      const oldFile = path.join(previous, 'packages', fingerprint(item.pin), 'package', 'index.mjs');
      if (label === 'missing file') await absent(oldFile);
      if (label === 'modified file') assert.equal(await fs.readFile(oldFile, 'utf8'), 'modified bytes');
      if (label === 'missing archive') await absent(path.join(previous, 'archives', `${fingerprint(item.pin)}.tgz`));
      await contexts.assertUnchanged();
      const offline = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules,
        fetcher: async () => assert.fail('Repaired cache must resolve offline') });
      await assertSelected(offline, item.pin);
    });
  }
});

test('repair uses a verified cached archive offline for missing package files and a changed SDK path', async t => {
  const item = fixture('7.0.0');
  for (const label of ['missing package file', 'changed SDK path']) {
    await t.test(label, async sub => {
      const env = await environment(sub, serve(item));
      const installed = await env.store.install(item.pin);
      let nodeModules = env.nodeModules;
      if (label === 'missing package file') await fs.unlink(path.join(installed.packageDir, 'index.mjs'));
      else {
        nodeModules = path.join(env.base, 'upgraded-pocket-node_modules');
        await fs.mkdir(nodeModules, { mode: 0o700 });
      }
      let downloads = 0;
      let validations = 0;
      const offline = new RuntimeStore({ root: env.root, nodeModules, fetcher: async () => {
        downloads++;
        throw new Error('Offline: repair must use the verified cached archive');
      } });
      await assert.rejects(offline.resolve([item.pin]));
      const result = await offline.repair(item.pin, { validate: async (packageDir, pin) => {
        validations++;
        assert.deepEqual(pin, item.pin);
        assert.ok(packageDir.startsWith(path.join(env.root, '.recovery-')));
        await assertLinkTarget(path.join(path.dirname(packageDir), 'node_modules'), nodeModules);
        assert.equal(await fs.readFile(path.join(packageDir, 'index.mjs'), 'utf8'), 'export const installed = true;\n');
      } });
      assert.equal(downloads, 0);
      assert.equal(validations, 1);
      assert.equal(result.packageDir, installed.packageDir);
      await assertLinkTarget(path.join(path.dirname(result.packageDir), 'node_modules'), nodeModules);
      assert.deepEqual(await fs.readFile(path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`)), item.bytes);
      await assertSelected(offline, item.pin);
      const [recovery] = await recoveryDirectories(env.root);
      await assertLinkTarget(path.join(recovery, 'previous', 'packages', fingerprint(item.pin), 'node_modules'), env.nodeModules);
    });
  }
});

test('repair downloads the pinned archive when the existing cached archive has invalid integrity or size', async t => {
  const item = fixture('7.1.0');
  for (const label of ['integrity', 'size']) {
    await t.test(label, async sub => {
      const env = await environment(sub, serve(item));
      await env.store.install(item.pin);
      const archivePath = path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`);
      const damaged = label === 'size' ? item.bytes.subarray(0, item.bytes.length - 1) : Buffer.from(item.bytes);
      if (label === 'integrity') damaged[damaged.length - 1] ^= 1;
      await fs.writeFile(archivePath, damaged);
      const calls = [];
      const repair = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: serve(item, calls) });
      await repair.repair(item.pin);
      assert.equal(calls.length, 1);
      await assertSelected(repair, item.pin);
      assert.deepEqual(await fs.readFile(archivePath), item.bytes);
      const [recovery] = await recoveryDirectories(env.root);
      assert.deepEqual(await fs.readFile(path.join(recovery, 'previous', 'archives', `${fingerprint(item.pin)}.tgz`)), damaged);
    });
  }
});

test('repair falls back to the network without reading archive symlinks or traversing a symlinked archives directory', async t => {
  const item = fixture('7.2.0');
  for (const label of ['archive symlink', 'archives directory symlink']) {
    await t.test(label, async sub => {
      const env = await environment(sub, serve(item));
      await env.store.install(item.pin);
      const targetDirectory = path.join(env.base, 'untrusted-cache-target');
      await fs.mkdir(targetDirectory, { mode: 0o700 });
      const targetArchive = path.join(targetDirectory, `${fingerprint(item.pin)}.tgz`);
      await fs.writeFile(targetArchive, item.bytes);
      const targetBefore = await fs.lstat(targetArchive);
      const archives = path.join(env.root, 'archives');
      const archivePath = path.join(archives, `${fingerprint(item.pin)}.tgz`);
      if (label === 'archive symlink') {
        await fs.unlink(archivePath);
        await fs.symlink(targetArchive, archivePath);
      } else {
        await fs.rename(archives, path.join(env.root, 'owner-saved-archives'));
        await fs.symlink(targetDirectory, archives, 'dir');
      }
      let downloads = 0;
      const forbiddenReads = [];
      const originalOpen = mutableFs.open;
      const originalLstat = mutableFs.lstat;
      sub.mock.method(mutableFs, 'open', async (location, ...args) => {
        if (location === targetArchive || (downloads === 0 && location === archivePath)) {
          forbiddenReads.push(location);
          throw new Error('Must not open an unsafe cached archive or its target');
        }
        return originalOpen(location, ...args);
      });
      sub.mock.method(mutableFs, 'lstat', async (location, ...args) => {
        if (label === 'archives directory symlink' && downloads === 0 && location === archivePath) {
          forbiddenReads.push(location);
          throw new Error('Must not traverse a symlinked archives directory');
        }
        return originalLstat(location, ...args);
      });
      syncBuiltinESMExports();
      try {
        const repair = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async (url, options) => {
          downloads++;
          return serve(item)(url, options);
        } });
        await repair.repair(item.pin);
        await assertSelected(repair, item.pin);
      } finally {
        sub.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(downloads, 1);
      assert.deepEqual(forbiddenReads, []);
      const [recovery] = await recoveryDirectories(env.root);
      const savedLink = label === 'archive symlink'
        ? path.join(recovery, 'previous', 'archives', `${fingerprint(item.pin)}.tgz`)
        : path.join(recovery, 'previous', 'archives');
      assert.equal((await fs.lstat(savedLink)).isSymbolicLink(), true);
      await assertLinkTarget(savedLink, label === 'archive symlink' ? targetArchive : targetDirectory);
      const targetAfter = await fs.lstat(targetArchive);
      assert.equal(targetAfter.ino, targetBefore.ino);
      assert.equal(targetAfter.mtimeMs, targetBefore.mtimeMs);
      assert.deepEqual(await fs.readFile(targetArchive), item.bytes);
      assert.deepEqual(await fs.readdir(targetDirectory), [`${fingerprint(item.pin)}.tgz`]);
    });
  }
});

test('failed repair downloads, integrity checks, validation, and cancellation preserve a good selection', async t => {
  const old = fixture('6.1.0');
  const uncached = fixture('6.2.0');
  for (const label of ['download', 'integrity', 'validation', 'cancellation']) {
    await t.test(label, async sub => {
      const env = await environment(sub, serve(old));
      await env.store.install(old.pin);
      // A verified archive for the old pin must not hide a failed repair download for this new pin.
      assert.notEqual(fingerprint(old.pin), fingerprint(uncached.pin));
      await absent(path.join(env.root, 'archives', `${fingerprint(uncached.pin)}.tgz`));
      const before = await fs.readFile(path.join(env.root, 'selection.json'));
      const packagesBefore = await fs.lstat(path.join(env.root, 'packages'));
      let downloads = 0;
      const repair = new RuntimeStore({ root: env.root, nodeModules: env.nodeModules, fetcher: async url => {
        downloads++;
        assert.equal(url, uncached.pin.tarball);
        if (label === 'download') throw new Error('repair download failed');
        const bytes = Buffer.from(uncached.bytes);
        if (label === 'integrity') bytes[bytes.length - 1] ^= 1;
        return response(bytes);
      } });
      const caller = new AbortController();
      await assert.rejects(repair.repair(uncached.pin, { signal: caller.signal, validate: async () => {
        await assertSelected(env.store, old.pin, true);
        if (label === 'validation') throw new Error('repair validation failed');
        if (label === 'cancellation') caller.abort(new Error('repair canceled'));
      } }), /repair download failed|integrity mismatch|repair validation failed|repair canceled/);
      assert.equal(downloads, 1);
      await assertSelected(env.store, old.pin);
      assert.deepEqual(await fs.readFile(path.join(env.root, 'selection.json')), before);
      assert.equal((await fs.lstat(path.join(env.root, 'packages'))).ino, packagesBefore.ino);
      await absent(path.join(env.root, 'packages', fingerprint(uncached.pin)));
      assert.deepEqual(await recoveryDirectories(env.root), []);
    });
  }
});

test('repair rejects a changed reserved object without quarantining or deleting the replacement', async t => {
  const old = fixture('6.3.0');
  const next = fixture('6.4.0');
  const env = await environment(t, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
  await env.store.install(old.pin);
  const contexts = await contextsSentinel(env.root);
  const pointer = await fs.readFile(path.join(env.root, 'selection.json'));
  const packages = path.join(env.root, 'packages');
  const ownerCopy = path.join(env.root, 'owner-saved-packages');
  await assert.rejects(env.store.repair(next.pin, { validate: async () => {
    await fs.rename(packages, ownerCopy);
    await fs.mkdir(packages, { mode: 0o700 });
    await fs.writeFile(path.join(packages, 'unexpected'), 'must not move or delete');
  } }), /Runtime recovery object changed/);
  assert.equal(await fs.readFile(path.join(packages, 'unexpected'), 'utf8'), 'must not move or delete');
  assert.deepEqual(await fs.readFile(path.join(env.root, 'selection.json')), pointer);
  assert.equal((await fs.stat(path.join(ownerCopy, fingerprint(old.pin), 'package'))).isDirectory(), true);
  assert.deepEqual(await recoveryDirectories(env.root), []);
  await contexts.assertUnchanged();
});

test('owner recovery quarantines reserved symlinks themselves and never changes their targets', async t => {
  const item = fixture('6.5.0');
  for (const action of ['repair', 'uninstall']) {
    await t.test(action, async sub => {
      const env = await environment(sub, serve(item));
      const contexts = await contextsSentinel(env.root);
      const targets = { 'selection.json': contexts.location, packages: contexts.contexts,
        archives: path.join(env.base, 'missing-archive-target') };
      const before = new Map();
      for (const [name, target] of Object.entries(targets)) {
        const location = path.join(env.root, name);
        await fs.symlink(target, location);
        before.set(name, await fs.lstat(location));
      }
      if (action === 'repair') {
        await env.store.repair(item.pin);
        await assertSelected(env.store, item.pin);
      } else {
        await env.store.uninstall({ recover: true });
        assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
        await absent(path.join(env.root, 'packages'));
        await absent(path.join(env.root, 'archives'));
      }
      const directories = await recoveryDirectories(env.root);
      assert.equal(directories.length, 1);
      const previous = path.join(directories[0], 'previous');
      for (const [name, target] of Object.entries(targets)) {
        const location = path.join(previous, name);
        assert.equal((await fs.lstat(location)).isSymbolicLink(), true);
        assert.equal((await fs.lstat(location)).ino, before.get(name).ino);
        await assertLinkTarget(location, target);
      }
      await contexts.assertUnchanged();
      await absent(targets.archives);
      assert.equal(await fs.readFile(path.join(env.acp, 'session.json'), 'utf8'), '{"keep":"ACP state"}\n');
    });
  }
});

test('recovery uninstall quarantines malformed control and corrupt cache while preserving contexts and unrelated files', async t => {
  const item = fixture('6.6.0');
  const env = await environment(t, serve(item));
  const installed = await env.store.install(item.pin);
  const contexts = await contextsSentinel(env.root);
  const unrelated = path.join(env.root, 'owner-settings.json');
  await fs.writeFile(unrelated, '{"keep":true}\n');
  await fs.writeFile(path.join(env.root, 'selection.json'), '{broken pointer');
  await fs.unlink(path.join(installed.packageDir, 'index.mjs'));
  await fs.unlink(path.join(env.root, 'archives', `${fingerprint(item.pin)}.tgz`));
  await assert.rejects(env.store.uninstall(), /Invalid runtime selection/);
  assert.deepEqual(await env.store.uninstall({ recover: true }), { state: 'uninstalled', installed: false, busy: false });
  assert.deepEqual(await env.store.selection(), { format: 1, state: 'uninstalled' });
  assert.deepEqual(await env.store.status([item.pin]), { state: 'uninstalled', installed: false, busy: false });
  await absent(path.join(env.root, 'packages'));
  await absent(path.join(env.root, 'archives'));
  const directories = await recoveryDirectories(env.root);
  assert.equal(directories.length, 1);
  const previous = path.join(directories[0], 'previous');
  assert.deepEqual((await fs.readdir(previous)).sort(), ['archives', 'packages', 'selection.json']);
  assert.equal(await fs.readFile(path.join(previous, 'selection.json'), 'utf8'), '{broken pointer');
  await contexts.assertUnchanged();
  assert.equal(await fs.readFile(unrelated, 'utf8'), '{"keep":true}\n');
  assert.equal(await fs.readFile(path.join(env.acp, 'session.json'), 'utf8'), '{"keep":"ACP state"}\n');
});

test('repair and recovery uninstall restore the prior cache and raw selection after pointer publication fails', async t => {
  const old = fixture('6.7.0');
  const next = fixture('6.8.0');
  for (const action of ['repair', 'uninstall']) {
    await t.test(action, async sub => {
      const env = await environment(sub, async url => response(url === old.pin.tarball ? old.bytes : next.bytes));
      await env.store.install(old.pin);
      if (action === 'uninstall') await fs.writeFile(path.join(env.root, 'selection.json'), '{malformed original');
      const contexts = await contextsSentinel(env.root);
      const before = new Map();
      for (const name of ['packages', 'archives', 'selection.json']) before.set(name, await fs.lstat(path.join(env.root, name)));
      const pointer = await fs.readFile(path.join(env.root, 'selection.json'));
      const originalRename = mutableFs.rename;
      let injected = false;
      sub.mock.method(mutableFs, 'rename', async (source, destination) => {
        if (!injected && destination === path.join(env.root, 'selection.json') && path.basename(path.dirname(source)) === 'candidate') {
          injected = true;
          if (action === 'repair') {
            assert.equal(await fs.readFile(path.join(env.root, 'packages', fingerprint(next.pin), 'package', 'index.mjs'), 'utf8'),
              'export const installed = true;\n');
          }
          throw new Error('injected recovery pointer publication failure');
        }
        return originalRename(source, destination);
      });
      syncBuiltinESMExports();
      try {
        const operation = action === 'repair' ? env.store.repair(next.pin) : env.store.uninstall({ recover: true });
        await assert.rejects(operation, /injected recovery pointer publication failure/);
      } finally {
        sub.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.equal(injected, true);
      for (const [name, stat] of before) assert.equal((await fs.lstat(path.join(env.root, name))).ino, stat.ino);
      assert.deepEqual(await fs.readFile(path.join(env.root, 'selection.json')), pointer);
      if (action === 'repair') await assertSelected(env.store, old.pin);
      else await assert.rejects(env.store.selection(), /Invalid runtime selection/);
      assert.deepEqual(await recoveryDirectories(env.root), []);
      await contexts.assertUnchanged();
    });
  }
});

test('explicit recovery still rejects symlink roots and root ancestors before fetching or touching their targets', async t => {
  const item = fixture('6.9.0');
  for (const label of ['root', 'ancestor']) {
    await t.test(label, async sub => {
      const env = await environment(sub, async () => assert.fail('Unsafe root must not fetch'));
      let root = env.root;
      if (label === 'root') await fs.symlink(env.acp, root, 'dir');
      else {
        const alias = path.join(env.base, 'unsafe-parent');
        await fs.symlink(env.acp, alias, 'dir');
        root = path.join(alias, 'runtime');
      }
      const store = new RuntimeStore({ root, nodeModules: env.nodeModules,
        fetcher: async () => assert.fail('Unsafe root must not fetch') });
      await assert.rejects(store.repair(item.pin), /Unsafe runtime directory/);
      await assert.rejects(store.uninstall({ recover: true }), /Unsafe runtime directory/);
      assert.deepEqual(await fs.readdir(env.acp), ['session.json']);
      assert.equal(await fs.readFile(path.join(env.acp, 'session.json'), 'utf8'), '{"keep":"ACP state"}\n');
    });
  }
});
