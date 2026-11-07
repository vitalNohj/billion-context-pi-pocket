/** Actual artifact hook -> outer selection -> bridge -> pinned runtime, with isolated server state. */
import { testHome } from './env.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { dropInFolder, FILES } from './fixtures.ts';
import { ContextEpochStore, digest } from '../billion-context-pi-pocket/context.mjs';
import { artifactPresentation, branchEntries, contextInstances, normalize, translateStateIds } from '../billion-context-pi-pocket/identity.mjs';
const pocket = process.env.PI_POCKET_CHECKOUT;
const skip = pocket && existsSync(join(pocket, 'test/helpers.ts')) ? false : 'set PI_POCKET_CHECKOUT to a Pi Pocket checkout';
if (process.env.CI && skip) throw new Error(String(skip));
const text = (messages: readonly any[]) => messages.map(message => JSON.stringify(message.content)).join('\n');
const prefix = (messages: readonly any[]) => branchEntries(messages.filter(message => message.role !== 'system')).map(entry => `${entry.id}:${entry.timestamp}`);
const user = (content: string, timestamp = 10) => ({ role: 'user', content: [{ type: 'text', text: content }], timestamp });
const context = { abortSignal: new AbortController().signal };
const originalOpening = 'Opening, the same text may appear after New context. ' + 'Historical opening detail. '.repeat(280);
const rawHistory = () => [
    user(originalOpening),
    { role: 'assistant', content: [{ type: 'toolCall', id: 'old-artifact', name: 'artifact_inline', arguments: { id: 'report', content: 'KNOWN_ARTIFACT_FACT: the database is amber.\n'.repeat(800) } }], timestamp: 20 },
    { role: 'toolResult', toolName: 'artifact_inline', toolCallId: 'old-artifact', content: [{ type: 'text', text: 'KNOWN_RESULT_FACT: the runner is violet.\n'.repeat(800) }], details: { artifactId: 'report', version: 1 }, isError: false, timestamp: 30 },
    // Artifact is not in NEVER_PRESERVE_RECENT_TOOLS (unlike the existing read fixtures).
    // Age both halves beyond the real 5,000-token floor, not only the five-message tail.
    user('Continue after the old artifact. ' + 'This later independent context needs to stay visible. '.repeat(600), 40),
    ...Array.from({ length: 6 }, (_, i) => [
        { role: 'assistant', content: [{ type: 'text', text: `Answer ${i}` }], timestamp: 50 + i * 2 },
        user(`Later turn ${i}`, 51 + i * 2),
    ]).flat(),
];
async function fixture(t: any, name = 'migration') {
    const root = mkdtempSync(join(tmpdir(), `bcp-${name}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const folder = join(root, 'extensions');
    const entry = dropInFolder(folder);
    symlinkSync(join(pocket!, 'node_modules'), join(folder, 'node_modules'), 'dir');
    const mod = await import(pathToFileURL(entry).href);
    const bridge = await import(pathToFileURL(join(folder, FILES, 'bridge.ts')).href);
    const { default: createArtifacts } = await import(join(pocket!, 'src/server/extensions/artifacts.ts'));
    const artifactHook = createArtifacts({}).hooks[0].handlers.beforeRequest;
    const { orderToolResults } = await import(join(pocket!, 'node_modules/@earendil-works/pi-durable/dist/harness/context.js'));
    const sid = '777';
    const markers = join(root, 'billion-context-pi-pocket-runtime/contexts');
    const stateDir = join(root, 'billion-context-pi');
    let enabled = true, offBehavior = 'restore-history';
    const api: any = { conversationId: sid, taskId: 'generation', callId: '',
        models: { getModel: () => ({ id: 'faux-1', provider: 'faux', contextWindow: 128000, maxTokens: 8000 }) },
        snapshot: async () => ({ enabled, offBehavior, cwd: root, model: { provider: 'faux', modelId: 'faux-1' } }),
    };
    const logs: string[] = [];
    const originalLog = console.info;
    console.info = (...args) => { logs.push(args.join(' ')); };
    t.after(() => { console.info = originalLog; });
    const host = { dataDir: root, notice() {} };
    const create = (web?: any) => mod.default(host, web);
    let extension = create();
    const handlers = () => extension.hooks.find((hook: any) => hook.handlers.beforeRequest).handlers;
    const toolHooks = () => extension.hooks.find((hook: any) => hook.handlers.beforeTool).handlers;
    const marker = () => JSON.parse(readFileSync(join(markers, `${sid}.json`), 'utf8'));
    const file = (epoch = marker().epoch) => join(stateDir, `${sid}${epoch ? `.context-${epoch}` : ''}.jsonl.acp.json`);
    const state = () => JSON.parse(readFileSync(file(), 'utf8'));
    const before = (messages: readonly any[], ctx: any = context) => handlers().beforeRequest({ messages }, api, ctx);
    const migrated = async (messages: readonly any[]) => (await artifactHook({ messages }, api, context))?.messages ?? messages;
    let count = 0;
    async function compress(messages: any[], startId: string, endId: string, summary: string) {
        const id = `compress-${++count}`;
        const call = { id, name: 'compress', arguments: { content: [{ startId, endId, summary }] } };
        const toolApi = { ...api, taskId: id, callId: id };
        await toolHooks().beforeTool(call, toolApi, context);
        const result = await extension.tools.find((tool: any) => tool.name === 'compress').execute(call.arguments, toolApi, context);
        assert.notEqual(result.isError, true, text([result]));
        const saved = await toolHooks().afterTool(call, result, toolApi, context);
        assert.ok(saved.details?.pocketBcpCheckpoint, `compress should checkpoint: ${JSON.stringify(result)}`);
        messages.push({ role: 'assistant', content: [{ type: 'toolCall', ...call }], timestamp: 100 + count * 2 });
        messages.push({ role: 'toolResult', toolName: 'compress', toolCallId: id, content: saved.content, details: saved.details, timestamp: 101 + count * 2 });
        return saved;
    }
    const execute = (name: string, args: any, overrides = {}) => extension.tools.find((tool: any) => tool.name === name).execute(args, { ...api, callId: `${name}-${++count}`, ...overrides }, context);
    return { root, sid, api, markers, stateDir, bridge, logs, marker, file, state, before, migrated, compress, execute, orderToolResults,
        reload() { extension = create(); }, mode(on: boolean, behavior = 'restore-history') { enabled = on; offBehavior = behavior; },
        menu() {
            const routes = new Map<string, any>(), defaults: any[] = [];
            create({ module: 'billion-context-pi-pocket', settings(items: any[]) { defaults.push(...items); }, setting: () => 'restore-history',
                client() {}, send() {}, onSettings() {}, route(method: string, path: string, fn: any) { routes.set(`${method} ${path}`, fn); },
                conversationRoute(method: string, path: string, fn: any) { routes.set(`${method} ${path}`, fn); } });
            return { defaults, status: () => routes.get('GET status/:source')({ ...api, context, conversation: { id: api.conversationId } }) };
        },
        damageRuntime() { writeFileSync(join(folder, FILES, 'billion-context-pi-0.1.83/dist/index.js'), 'broken reviewed program fixture'); },
        response: (message: any) => handlers().afterResponse(message, api, context),
        toolHooks,
    };
}
async function folded(f: any) {
    const messages = rawHistory();
    await f.before(messages);
    const ids = branchEntries(messages);
    const refs = f.state().messageRefs.byRaw;
    await f.compress(messages, refs[ids[1].id], refs[ids[2].id], 'COMPRESSED_KNOWN_FACT: database amber, runner violet.');
    await f.before(messages);
    return messages;
}

for (const [sharedAssistant, proof] of [[false, 'canonical'], [false, 'ordered'], [false, 'head-only'], [true, 'canonical'], [true, 'ordered'], [true, 'head-only']] as const) {
    test(`mixed legacy/modern artifact pairs migrate selectively, including ${sharedAssistant ? 'multiple calls in the opening assistant' : 'separate assistant messages'} (${proof})`, { skip }, async t => {
        const f = await fixture(t);
        const messages = rawHistory();
        const modernCall = { type: 'toolCall', id: 'already-modern', name: 'artifact', arguments: { inline: true, id: 'modern-report', content: 'ALREADY_MODERN_FACT: unchanged arguments.\n'.repeat(800) } };
        const modernResult = { role: 'toolResult', toolName: 'artifact', toolCallId: modernCall.id, content: [{ type: 'text', text: 'ALREADY_MODERN_RESULT: unchanged result.\n'.repeat(800) }], details: { artifactId: 'modern-report' }, timestamp: 35 };
        if (sharedAssistant) {
            messages[1].content.push(modernCall);
            messages.splice(3, 0, modernResult);
            messages.shift(); // The anchor itself needs the selective, multi-call alias proof.
        } else messages.splice(3, 0, { role: 'assistant', content: [modernCall], timestamp: 32 }, modernResult);
        await f.before(messages);
        const raw = branchEntries(messages);
        const legacyIndex = messages.findIndex(message => message.role === 'toolResult' && message.toolName === 'artifact_inline');
        const modernIndex = messages.indexOf(modernResult);
        const refs = f.state().messageRefs.byRaw;
        const modernRef = refs[raw[modernIndex].id];
        await f.compress(messages, refs[raw[legacyIndex].id], modernRef,
            'MIXED_KNOWN_FACT: the legacy runner is violet and the already-modern artifact keeps every original argument and result.');
        await f.before(messages);
        const full = f.state(), original = readFileSync(f.file(0));
        const anchor = f.marker().head;
        const modern = await f.migrated(messages);
        const fit = f.bridge.compatibleState(full, modern);
        assert.equal(fit.migrated, true);
        assert.equal(fit.aliases.has(raw[modernIndex].id), false, 'already-modern result identity stays untouched');
        assert.equal(fit.aliases.has(raw[legacyIndex].id), true);
        assert.deepEqual(contextInstances(messages), contextInstances(modern));
        const openingComposites = Object.entries(full.messageRefs.byRaw).filter(([id]) => id.startsWith(`${raw[0].id}#`));
        if (sharedAssistant) {
            assert.ok(openingComposites.length >= 2, 'real runtime refs contain both logical calls');
            for (const [id, ref] of openingComposites) assert.equal(fit.state.messageRefs.byRef[ref as string], `${branchEntries(modern)[0].id}${id.slice(raw[0].id.length)}`);
        }
        // Legacy migration must also select the mixed original, not reverse the whole pass.
        if (proof !== 'canonical') writeFileSync(join(f.markers, `${f.sid}.json`), JSON.stringify({ format: 1, epoch: 0, head: anchor,
            ...(proof === 'ordered' ? { prefixLength: messages.length, prefixHash: digest(prefix(messages)) } : {}) }));
        const output = await f.before(modern);
        assert.equal(f.marker().epoch, 1);
        assert.equal(f.marker().head, anchor);
        assert.equal(f.state().blocks.length, full.blocks.length);
        assert.equal(f.state().messageRefs.byRef[modernRef], raw[modernIndex].id);
        assert.deepEqual(readFileSync(f.file(0)), original);
        assert.match(text(output.messages), /MIXED_KNOWN_FACT/);
        const growth = [...modern, { role: 'assistant', content: [{ ...modernCall, id: 'new-modern' }], timestamp: 900 },
            { ...modernResult, toolCallId: 'new-modern', timestamp: 901 }];
        const growingFit = f.bridge.compatibleState(full, growth);
        assert.equal(growingFit.migrated, true);
        assert.equal(growingFit.state.lastPassIds.length, full.lastPassIds.length);
        await f.before(growth);
        f.reload(); await f.before(growth);
        assert.equal(f.marker().epoch, 1);
        f.api.conversationId = '778';
        const forked = await f.before(modern);
        assert.match(text(forked.messages), /MIXED_KNOWN_FACT/);
        assert.equal(JSON.parse(readFileSync(join(f.stateDir, '778.jsonl.acp.json'), 'utf8')).blocks.length, full.blocks.length);
    });
}

for (const mode of ['enabled', 'restore-history', 'keep-summaries']) {
    test(`ordered legacy native reset and compaction keep the continuation path open (${mode})`, { skip }, async t => {
        for (const emptyFirst of [true, false]) {
            const f = await fixture(t);
            const messages = await folded(f);
            const original = readFileSync(f.file(0));
            writeFileSync(join(f.markers, `${f.sid}.json`), JSON.stringify({ format: 1, epoch: 0, head: f.marker().head, prefixLength: messages.length, prefixHash: digest(prefix(messages)) }));
            f.mode(mode === 'enabled', mode === 'keep-summaries' ? mode : 'restore-history');
            if (emptyFirst) { await f.before([]); await f.before([]); }
            const compacted = [user('POCKET_NATIVE_COMPACTION: a new logical boundary.', 8000)];
            const output = await f.before(compacted);
            assert.equal(f.marker().epoch, 1);
            assert.equal(f.marker().replayFloor, 1);
            assert.ok(!existsSync(f.file()) || f.state().blocks.length === 0);
            assert.deepEqual(readFileSync(f.file(0)), original);
            assert.doesNotMatch(text(output.messages), /COMPRESSED_KNOWN_FACT|KNOWN_RESULT_FACT/);
            f.reload(); await f.before(compacted);
            assert.equal(f.marker().epoch, 1);
        }
    });
}

test('Off/Restore history escapes an ambiguous legacy digest without restoring old checkpoints or replaying their compress calls', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    const original = readFileSync(f.file(0));
    const old = { format: 1, epoch: 0, head: f.marker().head, prefixLength: messages.length, prefixHash: digest(prefix(messages)) };
    writeFileSync(join(f.markers, `${f.sid}.json`), JSON.stringify(old));
    const retimed = messages.map(message => ({ ...message, timestamp: message.timestamp + 1000 }));
    assert.equal(f.bridge.stateFitsContext(f.state(), retimed), true, 'content IDs alone cannot prove changed timestamps');
    await assert.rejects(f.before(retimed), /Legacy context digest cannot be proved/);
    assert.equal(f.marker().epoch, 0, 'ambiguous enabled migration remains fail-closed');
    f.mode(false);
    const off = await f.before(retimed);
    assert.match(text(off.messages), /KNOWN_RESULT_FACT/);
    assert.equal(f.marker().epoch, 1);
    assert.equal(f.marker().replayFloor, 1);
    assert.deepEqual(readFileSync(f.file(0)), original);
    f.mode(true);
    await f.before(retimed);
    assert.equal(f.state().blocks.length, 0, 'old inline/v2 checkpoints and successful replay receipts are fenced out');
    f.reload(); await f.before(retimed);
    assert.equal(f.state().blocks.length, 0, 'the barrier persists across a cold read');
    const resultId = branchEntries(retimed)[2].id;
    const resultRef = f.state().messageRefs.byRaw[resultId];
    const saved = await f.compress(retimed, resultRef, resultRef,
        'POST_RESET_KNOWN_FACT: this is a new compression of the still-visible original runner result, made after the explicit reset.');
    assert.equal(saved.details.pocketBcpCheckpoint.contextEpoch, 1);
    await f.before(retimed);
    const decompressed = await f.execute('decompress', { blockId: 'b1', inline: true });
    assert.notEqual(decompressed.isError, true, text([decompressed]));
    assert.match(text([decompressed]), /KNOWN_RESULT_FACT/, 'original lookup is not filtered with obsolete replay receipts');
    rmSync(f.file()); f.reload();
    await f.before(retimed);
    assert.equal(f.state().blocks.length, 1, 'a new checkpoint inside this boundary still restores after state loss');
    assert.match(f.state().blocks[0].summary, /POST_RESET_KNOWN_FACT/);
    assert.equal(f.marker().epoch, 1);
});

// Unit-strength adversarial checks use the actual bridge compatibility primitive, not a permissive mock.
test('typed aliases preserve composite refs, origins, inactive/nested blocks and all non-ID state', { skip }, async t => {
    const f = await fixture(t);
    const messages = rawHistory();
    const modern = await f.migrated(messages);
    assert.deepEqual(modern, messages.map(artifactPresentation), 'fixture uses the real built-in artifact hook');
    const old = branchEntries(messages), next = branchEntries(modern);
    const ids = old.map(entry => entry.id);
    const state = { blocks: [
        { blockId: 'b1', active: false, summary: 'UNCHANGED_PRIVATE_SUMMARY', directMessageIds: [`${ids[1]}#old-artifact`], effectiveMessageIds: [ids[2]], directBlockIds: [] },
        { blockId: 'b2', active: true, summary: 'nested', directMessageIds: [ids[2]], effectiveMessageIds: [`${ids[1]}#old-artifact`, ids[2]], directBlockIds: ['b1'] },
    ], lastPassIds: ids, messageRefs: { byRaw: { [`${ids[1]}#old-artifact`]: 'm00002', [ids[2]]: 'm00003' }, byRef: { m00002: `${ids[1]}#old-artifact`, m00003: ids[2] } },
    liveRefOrigins: [{ rawId: ids[1], identity: JSON.stringify(normalize(messages[1], true)) }],
    absorbed: [{ toolCallId: 'old-artifact', callMessageId: `${ids[1]}#old-artifact`, resultMessageId: ids[2], summary: 'absorbed fact', tokensReclaimed: 42, createdAt: 1 }],
    imageShrinks: [{ ref: 'm00003', rawMessageId: ids[2], mediaType: 'image/png', originalBytes: 100, shrunkBytes: 50 }],
    imageFullRestored: ['m00003'], hiddenOrphanRefs: ['m00002'], custom: { unchanged: ids[2] },
    rules: [{ id: 1, text: 'rule' }], stats: { totalCompressed: 9 }, tokenSnapshot: { value: 100 }, nudge: { level: 'emergency' } };
    const bytes = JSON.stringify(state);
    const result = f.bridge.compatibleState(state, modern);
    assert.equal(result.migrated, true);
    assert.equal(JSON.stringify(state), bytes, 'source state is untouched');
    assert.equal(result.state.messageRefs.byRef.m00002, `${next[1].id}#old-artifact`);
    assert.equal(result.state.messageRefs.byRaw[`${next[1].id}#old-artifact`], 'm00002');
    assert.equal(result.state.liveRefOrigins[0].rawId, next[1].id);
    assert.equal(result.state.liveRefOrigins[0].identity, JSON.stringify(normalize(modern[1], true)));
    assert.equal(result.state.absorbed[0].callMessageId, `${next[1].id}#old-artifact`);
    assert.equal(result.state.absorbed[0].resultMessageId, next[2].id);
    assert.equal(result.state.absorbed[0].toolCallId, 'old-artifact');
    assert.equal(result.state.absorbed[0].summary, state.absorbed[0].summary);
    assert.equal(result.state.imageShrinks[0].rawMessageId, next[2].id);
    assert.equal(result.state.imageShrinks[0].ref, 'm00003');
    for (const field of ['rules', 'stats', 'tokenSnapshot', 'nudge', 'imageFullRestored', 'hiddenOrphanRefs', 'custom']) assert.deepEqual(result.state[field], state[field]);
    assert.deepEqual(result.state.blocks.map((block: any) => [block.blockId, block.summary, block.directBlockIds, block.active]), state.blocks.map(block => [block.blockId, block.summary, block.directBlockIds, block.active]));
    const staleOrigin = structuredClone(state); staleOrigin.liveRefOrigins[0].identity = 'unproven origin';
    assert.throws(() => f.bridge.compatibleState(staleOrigin, modern), /Unproven migrated live ref origin/);
    for (const [name, changed] of [
        ['arguments', modern.map((message: any, index: number) => index === 1 ? { ...message, content: message.content.map((part: any) => ({ ...part, arguments: { ...part.arguments, id: 'different' } })) } : message)],
        ['details', modern.map((message: any, index: number) => index === 2 ? { ...message, details: { artifactId: 'edited' } } : message)],
        ['unmatched', modern.map((message: any, index: number) => index === 2 ? { ...message, toolCallId: 'wrong' } : message)],
        ['synthetic missing', f.orderToolResults(modern.filter((_: any, index: number) => index !== 2))],
        ['unknown rename', modern.map((message: any, index: number) => index === 2 ? { ...message, toolName: 'another_tool' } : message)],
    ] as const) assert.equal(f.bridge.compatibleState(state, changed).state, undefined, name);
    const missing = structuredClone(state); missing.lastPassIds.push('live-ffffffffffffffff');
    assert.equal(f.bridge.compatibleState(missing, modern).state, undefined, 'even one missing saved-pass ID outside active blocks rejects repair');
    const collision = structuredClone(state); collision.messageRefs.byRaw[next[2].id] = 'm99999';
    assert.throws(() => translateStateIds(collision, new Map([[ids[2], next[2].id]])), /Ambiguous/);
});

test('real artifact hook, warm short-state kernel, fresh repair key, second request and restart keep all compression', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    // Nested compression is retained through the repair, including full expansion of the inactive child.
    await f.compress(messages, 'b1', 'b1', 'NESTED_KNOWN_FACT: database amber, runner violet; all original details retained.');
    await f.before(messages);
    // A genuine independent compression survives in the short epoch; the artifact hierarchy is absent there.
    const opening = f.state().messageRefs.byRaw[branchEntries(messages)[0].id];
    await f.compress(messages, opening, opening, 'OPENING_KNOWN_FACT: preserve the original opening and its context independently of the artifact.');
    await f.before(messages);
    const full = f.state();
    const source = readFileSync(f.file(0));
    assert.equal(full.blocks.length, 3);
    const modern = await f.migrated(messages);
    const head = branchEntries(messages)[0].id;
    const markerFile = join(f.markers, `${f.sid}.json`);
    const compatible = f.bridge.compatibleState(full, modern).state;
    // Retain the real independent block, not a manually disabled child. Reconciliation would
    // reactivate a child with no consumer; an empty list would restore the latest checkpoint.
    const short = { ...compatible, blocks: compatible.blocks.filter((block: any) => block.blockId === 'b3') };
    writeFileSync(f.file(1), JSON.stringify(short));
    writeFileSync(markerFile, JSON.stringify({ format: 1, epoch: 1, head, prefixLength: modern.length, prefixHash: digest(prefix(modern)) }));
    // Establish its versioned proof before loading the warm kernel. The separate archive regression
    // covers automatic legacy recovery; here an established destination must stay short until repair.
    await new ContextEpochStore(f.markers).observe(f.sid, head, false, prefix(modern), { instances: contextInstances(modern) });
    const warmOutput = await f.before(modern); // real warm :1 kernel with genuine independent state
    assert.equal(f.state().blocks.length, 1, 'the fixture really warmed the short state, not a restored checkpoint');
    assert.equal(f.state().blocks[0].blockId, 'b3');
    assert.equal(f.state().blocks.filter((block: any) => block.active).length, 1);
    assert.match(text(warmOutput.messages), /KNOWN_RESULT_FACT/, 'the short warm episode really sends the unfurled artifact');
    const warmSelection = f.logs.findLast(line => line.includes('"kernel":"new"'))!;
    assert.match(warmSelection, /:1:g0/);
    const logFile = join(testHome, '.pi', 'acp.log');
    const logOffset = readFileSync(logFile, 'utf8').length;
    await f.response({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'prompt is too long: 200000 tokens > 128000 maximum', timestamp: 900 });
    const armed = await f.before(modern);
    const overflow = readFileSync(logFile, 'utf8').slice(logOffset);
    assert.match(overflow, /\[overflow-selfheal\].*event=detected window=128000/, 'the actual runtime detects the rejected warm request');
    assert.match(overflow, /\[overflow-selfheal\].*event=armed-emergency floor=114000 limit=120000/,
        'the warm episode applies a real emergency floor after the 8K output headroom; injection still obeys upstream benefit guards');
    // Reproduce the pre-fix 0 -> 1 decision with its exact compatibility predicate.
    assert.equal(f.bridge.stateFitsContext(full, modern), false);
    writeFileSync(markerFile, JSON.stringify({ format: 1, epoch: 0, head }));
    const legacy = new ContextEpochStore(f.markers);
    assert.equal((await legacy.observe(f.sid, head, !f.bridge.stateFitsContext(full, modern), prefix(modern))).epoch, 1);
    // The shipping hook instead proves the alias and publishes a derived state before selecting a fresh key.
    writeFileSync(markerFile, JSON.stringify({ format: 1, epoch: 0, head }));
    const output = await f.before(modern);
    assert.equal(f.marker().epoch, 2, 'fresh epoch skips the already-warm short state');
    assert.match(f.logs.findLast(line => line.includes('"kernel":"new"'))!, /:2:g0/);
    assert.equal(f.state().blocks.length, 3);
    assert.deepEqual(f.state().blocks.map((block: any) => [block.blockId, block.summary, block.active]), full.blocks.map((block: any) => [block.blockId, block.summary, block.active]));
    assert.deepEqual(readFileSync(f.file(0)), source, 'original sidecar remains byte-for-byte unchanged');
    assert.match(text(output.messages), /NESTED_KNOWN_FACT/);
    assert.doesNotMatch(text(output.messages), /KNOWN_ARTIFACT_FACT|KNOWN_RESULT_FACT|EMERGENCY/);
    // The hook injects its system prompt; compare user/assistant/tool bytes to the same raw roles,
    // and compare full request sizes against the actual warm uncompressed hook output.
    assert.ok(text(output.messages.filter((message: any) => message.role !== 'system')).length < text(modern).length / 2,
        'actual sent conversation is less than half the uncompressed view');
    assert.ok(text(output.messages).length < text(warmOutput.messages).length, 'the complete sent request also shrinks');
    assert.ok(output.messages.length < warmOutput.messages.length, 'compression replaces the original message pair');
    assert.ok(output.messages.length < armed.messages.length, 'the recovered view is smaller than the armed emergency view');
    const status = await f.execute('acp_status', { scope: 'compressed' });
    assert.match(text([status]), /b2/);
    assert.match(text([status]), /b3/);
    const search = await f.execute('search_context', { query: 'violet', limit: 5 });
    assert.match(text([search]), /violet/i);
    const restored = await f.execute('decompress', { blockId: 'b2', full: true, inline: true });
    assert.notEqual(restored.isError, true, text([restored]));
    assert.match(text([restored]), /KNOWN_RESULT_FACT/);
    const beforeCache = readFileSync(f.file());
    await f.execute('acp_cache', {});
    assert.deepEqual(readFileSync(f.file()), beforeCache, 'accounting is read-only');
    await f.before(modern);
    f.reload();
    await f.before(modern);
    assert.equal(f.marker().epoch, 2);
    assert.equal(f.state().blocks.length, 3);
    const resultRef = full.messageRefs.byRaw[branchEntries(messages)[2].id];
    assert.equal(f.state().messageRefs.byRef[resultRef], branchEntries(modern)[2].id, 'tool-visible ref label survives identity migration');
    await f.compress(modern, 'b2', 'b2', 'AFTER_MIGRATION_KNOWN_FACT: new nested compression preserves database amber and runner violet.');
    await f.before(modern);
    assert.equal(f.state().blocks.length, 4, 'new compression works on recovered composite/nested state');
    const expanded = await f.execute('decompress', { blockId: 'b4', full: true, inline: true });
    assert.match(text([expanded]), /KNOWN_RESULT_FACT/);
    assert.ok(f.logs.every(line => !/KNOWN_|amber|violet|PRIVATE/.test(line)), 'selection logs contain no message text or summaries');
});

test('real orderToolResults permutation, new physical head, restart and post-reorder compress retain the anchor', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    // orderToolResults moves an interposed user message past the result without changing any instances.
    const shuffled = [messages[0], messages[1], messages[3], messages[2], ...messages.slice(4)];
    await f.before(shuffled);
    const ordered = f.orderToolResults(shuffled);
    assert.notDeepEqual(ordered, shuffled);
    f.reload();
    await f.before(ordered);
    const head = f.marker().head;
    const epoch = f.marker().epoch;
    await f.before([ordered[3], ...ordered.slice(0, 3), ...ordered.slice(4)]);
    assert.equal(f.marker().head, head);
    assert.equal(f.marker().epoch, epoch);
    assert.equal(f.state().blocks.length, 1);
    await f.compress(messages, 'b1', 'b1', 'POST_REORDER_NESTED_FACT: database amber, runner violet, with all details retained.');
    assert.equal(f.state().blocks.length, 2);
    await f.before(ordered);
    assert.equal(f.marker().epoch, epoch);
});

test('same-key disk edits are not invalidation; explicit generation change rejects stale response/tool hooks', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    const complete = f.state();
    writeFileSync(f.file(), JSON.stringify({ ...complete, blocks: [] }));
    await f.before(messages);
    assert.equal(f.state().blocks.length, 1, 'the warm kernel still owns its state until the key changes');
    const savedMarker = f.marker();
    const call = { id: 'old-tool', name: 'read', arguments: {} };
    await f.toolHooks().beforeTool(call, f.api, context);
    writeFileSync(f.file(), JSON.stringify({ ...complete, blocks: [] }));
    writeFileSync(join(f.markers, `${f.sid}.json`), JSON.stringify({ ...savedMarker, generation: 1 }));
    await f.response({ role: 'assistant', content: [], timestamp: 999 });
    const stale = await f.execute('compress', { content: [] });
    assert.equal(stale.isError, true);
    assert.match(text([stale]), /Context changed/);
    await f.toolHooks().afterTool(call, { content: [] }, f.api, context);
    assert.equal(f.state().blocks.length, 0, 'old response/tool hooks do not overwrite the replacement');
    assert.ok(f.logs.some(line => line.includes('stale-response-generation')));
    assert.ok(f.logs.some(line => line.includes('stale-tool-generation')));
    await f.before(messages);
    assert.match(f.logs.findLast(line => line.includes('"key"'))!, /:0:g1/);
});

test('version-1 inline checkpoint aliases restore before a paused prompt; wrong runtime/context and corrupt v2 objects reject', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    const full = f.state();
    const checkpointResult = messages.findLast(message => message.role === 'toolResult' && message.details?.pocketBcpCheckpoint)!;
    const v2 = checkpointResult.details.pocketBcpCheckpoint;
    const sourceManifest = JSON.parse(readFileSync(join(f.stateDir, 'checkpoints', `${v2.stateId}.json`), 'utf8'));
    const { blockIds, ...sourceFields } = sourceManifest;
    const sourceState = { ...sourceFields, blocks: blockIds.map((id: string) => JSON.parse(readFileSync(join(f.stateDir, 'checkpoints', `${id}.json`), 'utf8'))) };
    const v1 = { version: 1, bcpVersion: '0.1.83', conversationId: f.sid, contextId: f.marker().head, state: sourceState };
    const modern = await f.migrated(messages);
    // Keep the complete saved pass, but no compress calls that could hide a failed restore by replaying.
    const base = modern.filter((message: any) => message.role === 'assistant'
        ? !message.content.some((part: any) => part.type === 'toolCall' && part.name === 'compress')
        : !(message.role === 'toolResult' && message.toolName === 'compress'));
    const request = (checkpoint: any) => [...base, { ...checkpointResult, details: { pocketBcpCheckpoint: checkpoint } }];
    // New destination chat: no mutable parent sidecar is ever consulted.
    f.api.conversationId = '778';
    const withCheckpoint = request(v1);
    f.mode(false, 'keep-summaries');
    const output = await f.before(withCheckpoint);
    assert.match(text(output.messages), /COMPRESSED_KNOWN_FACT/, 'paused first prompt sees migrated inherited summaries');
    const childFile = join(f.stateDir, '778.jsonl.acp.json');
    const child = JSON.parse(readFileSync(childFile, 'utf8'));
    assert.equal(child.blocks.length, 1);
    assert.equal(child.derivedFrom.parentSessionId, f.sid, 'version-1 restoration really ran, rather than replay fallback');
    const resultRef = full.messageRefs.byRaw[branchEntries(messages)[2].id];
    assert.notEqual(child.messageRefs.byRef[resultRef], full.messageRefs.byRef[resultRef]);
    f.reload();
    await f.before(withCheckpoint);
    assert.equal(JSON.parse(readFileSync(childFile, 'utf8')).blocks.length, 1);
    // No compress calls to replay: rejection must produce zero inherited blocks.
    for (const [index, checkpoint] of [
        { ...v1, bcpVersion: '0.0.0' }, { ...v1, contextId: 'live-ffffffffffffffff' },
        { ...v2, stateId: 'f'.repeat(64) },
    ].entries()) {
        f.api.conversationId = String(800 + index);
        await f.before(request(checkpoint));
        assert.equal(JSON.parse(readFileSync(join(f.stateDir, `${800 + index}.jsonl.acp.json`), 'utf8')).blocks.length, 0);
    }
    const manifestPath = join(f.stateDir, 'checkpoints', `${v2.stateId}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const blockPath = join(f.stateDir, 'checkpoints', `${manifest.blockIds[0]}.json`);
    f.api.conversationId = '815';
    await f.before(request(v2));
    assert.equal(JSON.parse(readFileSync(join(f.stateDir, '815.jsonl.acp.json'), 'utf8')).blocks.length, 1,
        'the otherwise-identical intact v2 fixture really fits the complete saved pass');
    let next = 820;
    for (const object of [manifestPath, blockPath]) for (const mode of ['missing', 'tampered']) {
        const original = readFileSync(object);
        if (mode === 'missing') renameSync(object, `${object}.held`);
        else writeFileSync(object, 'tampered');
        try {
            const id = String(++next);
            f.api.conversationId = id;
            await f.before(request(v2));
            assert.equal(JSON.parse(readFileSync(join(f.stateDir, `${id}.jsonl.acp.json`), 'utf8')).blocks.length, 0, `${mode} checkpoint object rejects`);
        } finally {
            if (mode === 'missing') renameSync(`${object}.held`, object);
            else writeFileSync(object, original);
        }
        assert.deepEqual(readFileSync(object), original, 'diagnostic fixture preserves the original checkpoint bytes');
    }
});

test('paused migration leaves controls/defaults/other chats alone, menu selects repaired stats, and damaged code cannot trap Off', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    const source = readFileSync(f.file(0));
    f.api.conversationId = '778';
    await f.before(rawHistory());
    const otherFile = join(f.stateDir, '778.jsonl.acp.json'), other = readFileSync(otherFile);
    f.api.conversationId = f.sid;
    f.mode(false, 'keep-summaries');
    const modern = await f.migrated(messages);
    const paused = await f.before(modern);
    assert.equal(f.marker().epoch, 1);
    assert.match(text(paused.messages), /paused for this chat/);
    assert.match(text(paused.messages), /COMPRESSED_KNOWN_FACT/);
    assert.equal((await f.execute('compress', { content: [] })).isError, true, 'migration does not unpause compression');
    assert.deepEqual(readFileSync(f.file(0)), source);
    const menu = f.menu();
    assert.equal((await menu.status()).session.enabled, false);
    assert.equal(menu.defaults[0].default, 'restore-history');
    f.mode(true);
    const opening = f.state().messageRefs.byRaw[branchEntries(modern)[0].id];
    await f.compress(modern, opening, opening, 'SELECTED_MENU_FACT: this new block belongs only to the repaired sidecar, not its abandoned source.');
    await f.before(modern);
    f.mode(false, 'keep-summaries');
    const status = await menu.status();
    assert.equal(status.stats.blocks, 2, 'menu counts the selected sidecar, not the one-block abandoned original');
    assert.equal(status.session.enabled, false);
    assert.equal(status.session.offBehavior, 'keep-summaries');
    assert.deepEqual(readFileSync(otherFile), other, 'migration and menu reads never modify another chat');
    assert.deepEqual(readFileSync(f.file(0)), source);
    f.damageRuntime(); f.reload(); f.mode(false, 'restore-history');
    const off = await f.before(modern);
    assert.match(text(off.messages), /off for this chat/);
    assert.match(text(off.messages), /KNOWN_RESULT_FACT/, 'Off can still restore raw history without importing a damaged program');
    assert.equal((await menu.status()).stats.blocks, 2);
    assert.equal(menu.defaults[0].default, 'restore-history');
});

test('set-aside legacy archive needs complete same-chat checkpoint provenance, not mtime or block count', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    const original = readFileSync(f.file(0));
    const modern = await f.migrated(messages);
    const head = f.marker().head;
    const markerFile = join(f.markers, `${f.sid}.json`);
    writeFileSync(markerFile, JSON.stringify({ format: 1, epoch: 1, head, prefixLength: modern.length, prefixHash: digest(prefix(modern)) }));
    const output = await f.before(modern);
    assert.equal(f.marker().epoch, 2);
    assert.match(text(output.messages), /COMPRESSED_KNOWN_FACT/);
    assert.deepEqual(readFileSync(f.file(0)), original);
    assert.ok(f.logs.some(line => line.includes('legacy-checkpoint-artifact-alias')));
    f.reload();
    await f.before(modern);
    assert.equal(f.marker().epoch, 2);
    assert.equal(f.state().blocks.length, 1);

    // The same alias-looking archive cannot cross a reset: the bounded request has no old calls/checkpoint.
    await f.before([user(originalOpening, 7000)]);
    assert.equal(f.marker().epoch, 3);
    assert.equal(f.state().blocks.length, 0);
    f.reload();
    assert.doesNotMatch(text((await f.before([user(originalOpening, 7000)])).messages), /COMPRESSED_KNOWN_FACT/);
});

test('cancelled repair preserves originals; a following native boundary skips unpublished and rolled-back epochs', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    const original = readFileSync(f.file(0));
    const previous = readFileSync(join(f.markers, `${f.sid}.json`));
    let checks = 0;
    const signal = { throwIfAborted() { if (++checks === 2) throw new Error('cancelled during proof publication'); } };
    await assert.rejects(f.before(await f.migrated(messages), { abortSignal: signal }), /cancelled during proof publication/);
    assert.equal(checks, 2);
    assert.deepEqual(readFileSync(f.file(0)), original);
    assert.deepEqual(readFileSync(join(f.markers, `${f.sid}.json`)), previous);
    assert.ok(existsSync(f.file(1)), 'complete unpublished repair state remains available for diagnosis');
    await f.before([user('NATIVE_COMPACTION_AFTER_CANCEL', 8000)]);
    assert.equal(f.marker().epoch, 2, 'a native boundary must never select the old unpublished epoch-1 file');
    assert.equal(f.state().blocks.length, 0);
    f.reload();
    assert.doesNotMatch(text((await f.before([user('NATIVE_COMPACTION_AFTER_CANCEL', 8000)])).messages), /COMPRESSED_KNOWN_FACT/);
});

test('aliased/reordered fork cutoffs, parent later compression, own-state restart and Keep summaries', { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    const afterCompression = await f.migrated(messages);
    const opening = f.state().messageRefs.byRaw[branchEntries(messages)[0].id];
    await f.compress(messages, opening, opening, 'PARENT_LATER_FACT: this independent compression happened after the child fork cutoff.');
    await f.before(await f.migrated(messages));
    const parentBytes = readFileSync(f.file());
    const child = (id: string) => JSON.parse(readFileSync(join(f.stateDir, `${id}.jsonl.acp.json`), 'utf8'));
    f.api.conversationId = '779';
    await f.before(await f.migrated(rawHistory()));
    assert.equal(child('779').blocks.length, 0, 'fork before compression inherits no later parent sidecar');
    f.api.conversationId = '780';
    f.mode(false, 'keep-summaries');
    const reordered = [afterCompression[3], ...afterCompression.slice(0, 3), ...afterCompression.slice(4)];
    const output = await f.before(reordered);
    assert.equal(child('780').blocks.length, 1);
    assert.match(text(output.messages), /COMPRESSED_KNOWN_FACT/);
    assert.doesNotMatch(text(output.messages), /PARENT_LATER_FACT|KNOWN_RESULT_FACT/);
    const marker = JSON.parse(readFileSync(join(f.markers, '780.json'), 'utf8'));
    assert.equal(marker.head, branchEntries(messages)[0].id, 'a complete visible checkpoint retains the stable anchor on a new physical head');
    f.reload();
    await f.before(reordered);
    assert.equal(child('780').blocks.length, 1);
    const expanded = await f.execute('decompress', { blockId: 'b1', full: true, inline: true });
    assert.match(text([expanded]), /KNOWN_RESULT_FACT/);
    f.mode(true);
    await f.compress(reordered, 'b1', 'b1', 'CHILD_OWN_FACT: database amber and runner violet, nested independently in the fork.');
    await f.before(reordered);
    f.mode(false, 'keep-summaries');
    f.reload();
    const own = await f.before(reordered);
    assert.equal(child('780').blocks.length, 2, 'an established child keeps its own compression instead of reinstalling a parent checkpoint');
    assert.match(text(own.messages), /CHILD_OWN_FACT/);
    assert.doesNotMatch(text(own.messages), /PARENT_LATER_FACT/);
    assert.deepEqual(readFileSync(f.file()), parentBytes, 'parent mutable state is never touched by child selection');
});

for (const mode of ['enabled', 'restore-history', 'keep-summaries']) { test(`request-bounded observation racing native compaction never revives an old proof (${mode})`, { skip }, async t => {
    const f = await fixture(t);
    const messages = await folded(f);
    await f.before(await f.migrated(messages));
    const old = f.marker();
    const source = readFileSync(f.file());
    f.mode(mode === 'enabled', mode === 'keep-summaries' ? mode : 'restore-history');
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const snapshot = f.api.snapshot;
    f.api.snapshot = async (...args: any[]) => { entered(); await released; return snapshot(...args); };
    // Pause the old request before it can observe. The native replacement commits in the meantime.
    const pending = f.before(await f.migrated(messages));
    await enteredPromise;
    const native = [user('COMPACTION_RACE_NEW_NATIVE_SUMMARY', 9999)];
    const epochs = new ContextEpochStore(f.markers);
    const nativeEntries = branchEntries(native);
    await epochs.observe(f.sid, nativeEntries[0].id, false, prefix(native), { instances: contextInstances(native) });
    f.api.entries = async () => { throw new Error('must not read an unbounded newer native head'); };
    f.api.snapshot = snapshot;
    release();
    await assert.rejects(pending, /Context changed while preparing request/);
    const current = await f.before(native);
    assert.ok(f.marker().epoch > old.epoch);
    assert.notEqual(f.marker().boundary, old.boundary);
    assert.doesNotMatch(text(current.messages), /COMPRESSED_KNOWN_FACT|KNOWN_RESULT_FACT/);
    assert.deepEqual(readFileSync(f.file(old.epoch)), source);
    f.reload();
    assert.doesNotMatch(text((await f.before(native)).messages), /COMPRESSED_KNOWN_FACT/);
}); }

for (const mode of ['enabled', 'restore-history', 'keep-summaries']) {
    test(`New context/native compaction after migration and reorder never revives archives (${mode})`, { skip }, async t => {
        const f = await fixture(t);
        const messages = await folded(f);
        const modern = await f.migrated(messages);
        await f.before(modern);
        await f.before([modern[3], ...modern.slice(0, 3), ...modern.slice(4)]);
        const before = f.marker();
        const original = readFileSync(f.file());
        f.mode(mode === 'enabled', mode === 'keep-summaries' ? mode : 'restore-history');
        await f.before([]);
        const reset = f.marker();
        await f.before([]);
        assert.equal(f.marker().epoch, reset.epoch);
        await f.before([user(originalOpening, 5000)]);
        assert.equal(f.marker().epoch, before.epoch + 1);
        assert.deepEqual(readFileSync(f.file(before.epoch)), original);
        f.reload();
        const output = await f.before([user(originalOpening, 5000)]);
        assert.doesNotMatch(text(output.messages), /COMPRESSED_KNOWN_FACT/);
        await f.before([user('POCKET_NATIVE_SUMMARY', 6000)]);
        assert.equal(f.marker().epoch, before.epoch + 2);
        assert.notEqual(f.marker().boundary, before.boundary);
        assert.ok(readdirSync(f.markers).includes('proofs'));
    });
}
