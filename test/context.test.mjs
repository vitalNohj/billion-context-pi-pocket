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
