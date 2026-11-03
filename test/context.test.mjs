import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContextEpochStore } from '../billion-context-pi-pocket/context.mjs';

const A = 'live-1234567890abcdef';
const B = 'live-fedcba0987654321';
async function fixture(t) {
    const base = await mkdtemp(join(await realpath(tmpdir()), 'bcp-context-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'contexts');
    return { base, root, store: new ContextEpochStore(root) };
}

test('a fresh context read is side-effect free and the original state epoch stays zero', async t => {
    const { root, store } = await fixture(t);
    assert.deepEqual(await store.read(12), { epoch: 0 });
    await assert.rejects(stat(root), { code: 'ENOENT' });
    assert.deepEqual(await store.observe(12, A), { epoch: 0, head: A });
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, '12.json'))).mode & 0o777, 0o600);
    const before = await stat(join(root, '12.json'));
    assert.deepEqual(await store.observe(12, A), { epoch: 0, head: A });
    assert.equal((await stat(join(root, '12.json'))).ino, before.ino, 'ordinary turns do not rewrite the boundary');
});

test('native compaction changes the boundary once and survives reload without deleting any history', async t => {
    const { base, root, store } = await fixture(t);
    const history = join(base, '12.jsonl.acp.json');
    await writeFile(history, 'ORIGINAL_ACP_STATE');
    await store.observe(12, A);
    assert.deepEqual(await store.observe(12, B), { epoch: 1, head: B });
    const reloaded = new ContextEpochStore(root);
    assert.deepEqual(await reloaded.read(12), { epoch: 1, head: B });
    assert.deepEqual(await reloaded.observe(12, B), { epoch: 1, head: B });
    assert.deepEqual(await reloaded.observe(12, A), { epoch: 2, head: A });
    assert.equal(await readFile(history, 'utf8'), 'ORIGINAL_ACP_STATE');
    assert.deepEqual(await reloaded.read(13), { epoch: 0 });
});

test('an incompatible pre-upgrade state can start a new epoch before its first tracked request', async t => {
    const { store } = await fixture(t);
    assert.deepEqual(await store.observe(14, A, true), { epoch: 1, head: A });
    assert.deepEqual(await store.observe(14, A), { epoch: 1, head: A });
});

test('a verified raw prefix extends normally and survives a store reload', async t => {
    const { root, store } = await fixture(t);
    const first = [`${A}:100`];
    assert.equal((await store.observe(12, A, false, first)).epoch, 0);
    const original = await stat(join(root, '12.json'));
    await store.observe(12, A, false, first);
    assert.equal((await stat(join(root, '12.json'))).ino, original.ino, 'an identical retry does not rewrite the proof');
    const extended = [...first, `${B}:200`];
    const next = await store.observe(12, A, false, extended);
    assert.equal(next.epoch, 0);
    assert.equal(next.prefixLength, 2);
    assert.match(next.prefixHash, /^[a-f0-9]{64}$/);
    const reloaded = new ContextEpochStore(root);
    assert.equal((await reloaded.observe(12, A, false, [...extended, `${A}:300`])).epoch, 0);
});

test('an identical opening cannot hide a shortened, replaced, or newly timestamped context', async t => {
    for (const [name, prefix] of [
        ['shorter', [`${A}:100`]],
        ['replaced tail', [`${A}:100`, `${B}:300`]],
        ['new opening instance', [`${A}:400`, `${B}:500`]],
    ]) {
        await t.test(name, async t => {
            const { store } = await fixture(t);
            await store.observe(12, A, false, [`${A}:100`, `${B}:200`]);
            const reset = await store.observe(12, A, false, prefix);
            assert.equal(reset.epoch, 1);
            assert.equal((await store.observe(12, A, false, prefix)).epoch, 1);
            assert.equal((await store.observe(12, A, false, [...prefix, `${B}:600`])).epoch, 1);
        });
    }
});

test('an observed empty context starts only one new epoch and preserves the previous ACP file', async t => {
    const { base, root, store } = await fixture(t);
    const history = join(base, '12.jsonl.acp.json');
    await writeFile(history, 'PRESERVED_OLD_ACP');
    await store.observe(12, A, false, [`${A}:100`, `${B}:200`]);
    const empty = await store.observe(12, undefined, false, []);
    assert.equal(empty.epoch, 1);
    assert.equal(empty.prefixLength, 0);
    const reloaded = new ContextEpochStore(root);
    assert.equal((await reloaded.observe(12, undefined, false, [])).epoch, 1);
    assert.equal((await reloaded.observe(12, B, false, [`${B}:300`])).epoch, 1);
    assert.equal(await readFile(history, 'utf8'), 'PRESERVED_OLD_ACP');
    assert.deepEqual(await store.observe(13, undefined, false, []), { epoch: 0 });
    await assert.rejects(stat(join(root, '13.json')), { code: 'ENOENT' });
    assert.equal((await store.observe(14, undefined, true, [])).epoch, 1);
    assert.equal((await store.observe(14, B, false, [`${B}:400`])).epoch, 1);
});

test('old format-1 records can adopt a prefix proof without resetting valid state', async t => {
    const { store } = await fixture(t);
    await store.observe(12, A);
    const adopted = await store.observe(12, A, false, [`${A}:100`]);
    assert.equal(adopted.epoch, 0);
    assert.equal(adopted.prefixLength, 1);
    assert.equal((await store.observe(12, A)).prefixHash, adopted.prefixHash, 'a head-only retry keeps a known proof');
});

test('invalid prefix proofs fail closed', async t => {
    const { root, store } = await fixture(t);
    for (const prefix of [null, 'not an array', [null], ['x'.repeat(513)]]) {
        await assert.rejects(store.observe(12, A, false, prefix), /Invalid context prefix/);
    }
    await assert.rejects(store.observe(12, undefined, false, [A]), /requires a head/);
    await mkdir(root);
    for (const proof of [
        { prefixLength: 1 }, { prefixHash: 'a'.repeat(64) },
        { prefixLength: -1, prefixHash: 'a'.repeat(64) },
        { prefixLength: 1, prefixHash: 'a'.repeat(64) + '\n' },
    ]) {
        await writeFile(join(root, '12.json'), JSON.stringify({ format: 1, epoch: 0, head: A, ...proof }));
        await assert.rejects(store.read(12), /Invalid context-prefix proof/);
    }
});

test('invalid IDs, identities, and stored records fail closed', async t => {
    const { root, store } = await fixture(t);
    for (const id of ['../12', 0, -1, '12\n', '1/2', Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => store.file(id), /Invalid conversation/);
    }
    for (const head of ['bad', A + '\n', '../escape']) await assert.rejects(store.observe(12, head), /Invalid context identity/);
    await mkdir(root);
    await writeFile(join(root, '12.json'), JSON.stringify({ format: 1, epoch: -1, head: A }));
    await assert.rejects(store.read(12), /Invalid context marker/);
    await writeFile(join(root, '12.json'), 'x'.repeat(4097));
    await assert.rejects(store.read(12), /Unsafe context-marker/);
});

test('context markers never follow a symlink to unrelated data', async t => {
    const { base, root, store } = await fixture(t);
    await mkdir(root);
    const unrelated = join(base, 'unrelated.json');
    await writeFile(unrelated, 'DO_NOT_CHANGE');
    await symlink(unrelated, join(root, '12.json'));
    await assert.rejects(store.read(12));
    await assert.rejects(store.observe(12, A));
    assert.equal(await readFile(unrelated, 'utf8'), 'DO_NOT_CHANGE');
});
