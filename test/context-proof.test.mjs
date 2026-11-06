import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContextEpochStore, digest } from '../billion-context-pi-pocket/context.mjs';
import { branchEntries, contextInstances, legacyOrders } from '../billion-context-pi-pocket/identity.mjs';
const A = 'live-aaaaaaaaaaaaaaaa', B = 'live-bbbbbbbbbbbbbbbb', C = 'live-cccccccccccccccc';
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'bcp-proof-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root, store: new ContextEpochStore(root) };
}
const prefix = messages => branchEntries(messages).map(entry => `${entry.id}:${entry.timestamp}`);
const observe = (store, messages, reset = false, options = {}) => store.observe(12, branchEntries(messages)[0]?.id, reset, prefix(messages), { instances: contextInstances(messages), ...options });

for (const reordered of [[`${A}:10`, `${C}:30`, `${B}:20`], [`${B}:20`, `${A}:10`, `${C}:30`]]) {
    test(`cold-read permutation keeps epoch and stable anchor (${reordered[0] === `${A}:10` ? 'tail' : 'new first'})`, async t => {
        const { root, store } = await fixture(t);
        await store.observe(12, A, false, [`${A}:10`, `${B}:20`, `${C}:30`]);
        const old = await store.read(12);
        const inode = (await stat(store.file(12))).ino;
        const reloaded = new ContextEpochStore(root);
        const next = await reloaded.observe(12, reordered[0].split(':')[0], false, reordered);
        assert.equal(next.epoch, 0, 'same message instances must not start a new context after cold read');
        assert.equal(next.head, A, 'checkpoint contextId is not the first physical reordered message');
        assert.equal(next.proof, old.proof);
        assert.equal((await stat(store.file(12))).ino, inode, 'a permutation is not a marker rewrite');
        const grown = await reloaded.observe(12, B, false, ['live-0000000000000001:1', ...reordered]);
        assert.equal(grown.epoch, 0, 'an appended identity sorting before every old one is still growth');
        assert.equal(grown.head, A);
        assert.equal((await new ContextEpochStore(root).observe(12, B, false, [...reordered, 'live-0000000000000001:1'])).epoch, 0);
    });
}

test('canonical content/time/count proof decouples identical-content occurrence rank from timestamp', async t => {
    const { root, store } = await fixture(t);
    const first = { role: 'user', content: 'same', timestamp: 10 };
    const second = { ...first, timestamp: 20 };
    await observe(store, [first, second, first]);
    const reloaded = new ContextEpochStore(root);
    assert.equal((await observe(reloaded, [second, first, first])).epoch, 0);
    assert.equal((await observe(reloaded, [second, first])).epoch, 1, 'lost duplicate occurrence is a boundary');
    assert.equal((await observe(reloaded, [{ ...second, timestamp: 21 }, first])).epoch, 2, 'retimestamped instances are different');
});

test('verified legacy ordered digest migrates directly, and saved-pass order can prove a cold reorder', async t => {
    for (const permutation of [false, true]) {
        const { root, store } = await fixture(t);
        const messages = [10, 20, 30].map(timestamp => ({ role: 'user', content: String(timestamp), timestamp }));
        const entries = branchEntries(messages);
        const old = { format: 1, epoch: 4, head: entries[0].id, prefixLength: 3, prefixHash: digest(prefix(messages)) };
        await writeFile(store.file(12), JSON.stringify(old));
        const current = permutation ? [messages[1], messages[0], messages[2]] : messages;
        const migrated = await observe(store, current, false, { legacyOrders: legacyOrders(current, { lastPassIds: entries.map(entry => entry.id) }) });
        assert.equal(migrated.epoch, 4, 'rollout does not mass-bump old epochs');
        assert.equal(migrated.head, old.head);
        assert.ok(migrated.proof);
        assert.equal((await new ContextEpochStore(root).read(12)).proof, migrated.proof);
    }
});

test('unprovable legacy order retains marker and files with an explicit repair error', async t => {
    const { root, store } = await fixture(t);
    const marker = JSON.stringify({ format: 1, epoch: 0, head: A, prefixLength: 2, prefixHash: digest([`${A}:1`, `${B}:2`]) });
    await writeFile(store.file(12), marker);
    await writeFile(join(root, 'original.acp.json'), 'PRIVATE_STATE');
    await assert.rejects(store.observe(12, B, false, [`${B}:2`, `${A}:1`]), /explicit repair required/);
    assert.equal(await readFile(store.file(12), 'utf8'), marker);
    assert.equal(await readFile(join(root, 'original.acp.json'), 'utf8'), 'PRIVATE_STATE');
});

test('head-only legacy marker adopts versioned proof without an epoch bump', async t => {
    const { root, store } = await fixture(t);
    await writeFile(store.file(12), JSON.stringify({ format: 1, epoch: 8, head: A }));
    const next = await store.observe(12, B, false, [`${B}:2`, `${A}:1`]);
    assert.equal(next.epoch, 8, 'a surviving legacy anchor may move without discarding state');
    assert.ok(next.proof);
    assert.equal((await new ContextEpochStore(root).read(12)).head, A);
});

test('large private histories use small atomic markers and immutable identity-only proof objects', async t => {
    const { root, store } = await fixture(t);
    const messages = Array.from({ length: 2000 }, (_, timestamp) => ({ role: 'user', content: `PRIVATE_MESSAGE_${timestamp}`, timestamp }));
    await observe(store, messages);
    const marker = JSON.parse(await readFile(store.file(12), 'utf8'));
    assert.equal(marker.format, 2, 'old releases fail closed instead of silently ignoring a new proof on downgrade');
    assert.ok((await stat(store.file(12))).size <= 4096);
    const object = join(root, 'proofs', `${marker.proof}.json`);
    const bytes = await readFile(object, 'utf8');
    assert.doesNotMatch(bytes, /PRIVATE_MESSAGE|content|toolCall/);
    assert.ok(bytes.length > 4096);
    await observe(store, [...messages, { role: 'user', content: 'new', timestamp: 3000 }]);
    assert.equal(await readFile(object, 'utf8'), bytes, 'old proof objects are never mutated');
    await writeFile(store.file(12), JSON.stringify(marker)); // safe rollback to an older still-valid pointer
    assert.equal((await observe(new ContextEpochStore(root), messages)).epoch, 0);
});

test('missing, malformed, tampered and symlinked proof objects never downgrade to head-only', async t => {
    for (const mode of ['missing', 'malformed', 'tampered', 'symlink', 'directory-symlink']) {
        await t.test(mode, async t => {
            const { root, store } = await fixture(t);
            const original = await store.observe(12, A, false, [`${A}:1`]);
            const file = join(root, 'proofs', `${original.proof}.json`);
            const untouched = join(root, 'unrelated');
            await writeFile(untouched, 'DO_NOT_TOUCH');
            if (mode === 'missing') await rm(file);
            if (mode === 'malformed') await writeFile(file, '{');
            if (mode === 'tampered') await writeFile(file, (await readFile(file, 'utf8')).replace(':1,', ':2,' ) + ' ');
            if (mode === 'symlink') { await rm(file); await symlink(untouched, file); }
            if (mode === 'directory-symlink') { await rm(join(root, 'proofs'), { recursive: true }); await symlink(untouched, join(root, 'proofs')); }
            await assert.rejects(new ContextEpochStore(root).read(12));
            await assert.rejects(store.observe(12, A, false, [`${A}:1`]));
            assert.equal(await readFile(untouched, 'utf8'), 'DO_NOT_TOUCH');
            assert.equal(JSON.parse(await readFile(store.file(12), 'utf8')).epoch, 0);
        });
    }
});

test('unsafe proof pointers, marker bounds, and cancellation fail before publication', async t => {
    const { root, store } = await fixture(t);
    const previous = await store.observe(12, A, false, [`${A}:1`]);
    const bytes = await readFile(store.file(12));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(store.observe(12, A, false, [`${A}:1`, `${B}:2`], { signal: abort.signal }), /abort/i);
    assert.deepEqual(await readFile(store.file(12)), bytes);
    await writeFile(store.file(12), JSON.stringify({ format: 2, ...previous, proof: '../escape' }));
    await assert.rejects(store.read(12), /Invalid context-proof pointer/);
    await writeFile(store.file(12), ' '.repeat(4097));
    await assert.rejects(store.read(12), /Unsafe context-marker/);
    assert.ok((await stat(join(root, 'proofs', `${previous.proof}.json`))).isFile());
});

test('new context, empty once, and compaction do not reuse an archived native boundary', async t => {
    const { root, store } = await fixture(t);
    const messages = [10, 20].map(timestamp => ({ role: 'user', content: 'identical opening', timestamp }));
    const initial = await observe(store, messages);
    await observe(store, [...messages].reverse());
    const empty = await observe(new ContextEpochStore(root), []);
    assert.equal(empty.epoch, 1);
    assert.equal((await observe(store, [])).epoch, 1);
    const reset = await observe(store, [{ ...messages[0], timestamp: 100 }]);
    assert.equal(reset.epoch, 1);
    assert.notEqual(reset.boundary, initial.boundary);
    assert.ok((await store.archived(12, reset.boundary)).every(marker => marker.epoch !== 0));
    const compacted = await observe(store, [{ role: 'user', content: 'native summary', timestamp: 200 }]);
    assert.equal(compacted.epoch, 2);
    assert.notEqual(compacted.boundary, reset.boundary);
    await assert.rejects(store.repair(12, 9, prefix(messages), contextInstances(messages), undefined, reset), /changed during repair/);
});

test('archived marker epochs and identities are validated before deriving a state path', async t => {
    const { root, store } = await fixture(t);
    const current = await store.observe(12, A, false, [`${A}:1`]);
    const archive = join(root, 'epochs', '12.0.json');
    for (const epoch of ['../../escape', -1, 9007199254740992]) {
        await writeFile(archive, JSON.stringify({ format: 2, ...current, epoch }));
        await assert.rejects(store.archived(12, current.boundary), /Invalid context marker/);
    }
    await writeFile(archive, JSON.stringify({ format: 2, ...current, epoch: 1 }));
    await assert.rejects(store.archived(12, current.boundary), /Invalid archived context epoch/);
    assert.equal((await store.read(12)).epoch, 0, 'unsafe archives cannot replace the active pointer');
});

test('explicit repair generations survive growth and concurrent wrappers cannot overwrite a newer native boundary', async t => {
    const { root, store } = await fixture(t);
    const first = await store.observe(12, A, false, [`${A}:1`]);
    await writeFile(store.file(12), JSON.stringify({ format: 2, ...first, generation: 7 }));
    const grown = await store.observe(12, A, false, [`${A}:1`, `${B}:2`]);
    assert.equal(grown.generation, 7);
    const current = await store.read(12);
    let release, entered;
    const released = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const replacement = store.observe(12, C, false, [`${C}:3`], { allocateEpoch: async minimum => { entered(); await released; return minimum; }, expected: current });
    await started;
    const stale = new ContextEpochStore(root).observe(12, A, false, [`${A}:1`, `${B}:2`], { expected: current });
    const refused = assert.rejects(stale, /Context changed while preparing request/);
    release();
    await replacement;
    await refused;
    const latest = await store.read(12);
    assert.equal(latest.epoch, 1);
    assert.equal(latest.head, C);
    assert.notEqual(latest.boundary, first.boundary);
});

test('artifact proof equivalence is paired and exact, not arbitrary tool renaming or unsupported legacy arguments', async t => {
    const raw = [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'artifact_inline', arguments: { content: 'fact' } }], timestamp: 1 },
        { role: 'toolResult', toolName: 'artifact_inline', toolCallId: 'a', content: [{ type: 'text', text: 'fact' }], timestamp: 2 },
    ];
    const modern = structuredClone(raw);
    modern[0].content[0].name = 'artifact'; modern[0].content[0].arguments.inline = true;
    modern[1].toolName = 'artifact';
    assert.deepEqual(contextInstances(raw), contextInstances(modern));
    const { store } = await fixture(t);
    await observe(store, raw);
    assert.equal((await observe(store, modern)).epoch, 0);
    assert.equal((await observe(store, [{ ...modern[0], timestamp: 3 }, modern[1]])).epoch, 1);
    assert.notDeepEqual(contextInstances([raw[0]]), contextInstances([modern[0]]), 'a missing result cannot prove an old call alias');
    assert.notDeepEqual(contextInstances([raw[1]]), contextInstances([modern[1]]), 'a lone renamed result is not an alias witness');
    const unsupported = structuredClone(raw); unsupported[0].content[0].arguments.inline = false;
    assert.notDeepEqual(contextInstances(unsupported), contextInstances(modern), 'host-overwritten extra arguments fail closed');
});
