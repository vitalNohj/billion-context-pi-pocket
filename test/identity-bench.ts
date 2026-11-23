/** Run with PI_POCKET_CHECKOUT=/path/to/pi-pocket node test/identity-bench.ts. No server or provider. */
import { testHome } from './env.ts';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dropInFolder, FILES } from './fixtures.ts';
import { freezeJson, longContext } from './long-context.mjs';

const pocket = process.env.PI_POCKET_CHECKOUT;
if (!pocket) throw new Error('Set PI_POCKET_CHECKOUT to a Pi Pocket checkout with dependencies installed.');
process.env.PI_ACP_FORK_HOST = '1';
process.env.ACP_AUTO_UPDATE = '0';
process.env.XDG_CONFIG_HOME = join(testHome, 'config');
process.env.XDG_CACHE_HOME = join(testHome, 'cache');
const root = realpathSync(testHome);
const folder = join(root, 'extensions');
const entryFile = dropInFolder(folder);
symlinkSync(resolve(pocket, 'node_modules'), join(folder, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const helper = (name: string) => import(pathToFileURL(join(folder, FILES, name)).href);
const entry = await import(pathToFileURL(entryFile).href);
const bridge = await helper('bridge.ts');
const { ContextEpochStore } = await helper('context.mjs');
const { selectContext } = await helper('selection.mjs');
const version = entry.BCP_VERSION;
const bcp = await helper(`billion-context-pi-${version}/dist/index.js`);
const model = { id: 'faux-1', provider: 'faux', contextWindow: 8_000_000, maxTokens: 8_000 };
const added = () => freezeJson({ role: 'user', content: 'One new message.', timestamp: 1_750_000_004_000 });
const context = { abortSignal: new AbortController().signal };
const original = longContext();
// Use a different set of objects to prepare saved IDs. Do not warm the measured requests.
const lastPassIds = bridge.branchEntries(original).map((item: any) => item.id);
const trials = 5;
const measurements = new Map<string, [number, number][]>();

async function measure<T>(action: () => T | Promise<T>) {
    const start = performance.now();
    const result = await action();
    return { duration: performance.now() - start, result };
}

async function measurePair<T>(name: string, action: (messages: readonly any[]) => T | Promise<T>) {
    const messages = longContext();
    const next = [...messages, added()];
    const cold = await measure(() => action(messages));
    const warm = await measure(() => action(next));
    const samples = measurements.get(name) ?? [];
    samples.push([cold.duration, warm.duration]);
    measurements.set(name, samples);
    return { cold: cold.result, warm: warm.result };
}

console.info = () => {}; // Suppress the adapter's per-request selection diagnostics.
for (let trial = 1; trial <= trials; trial++) {
    const dataDir = join(root, `trial-${trial}`);
    const stateDir = join(dataDir, 'billion-context-pi');
    mkdirSync(stateDir, { recursive: true });
    const host = { dataDir, notice() {} };
    const api = { conversationId: '2', models: { getModel: () => model },
        snapshot: async () => ({ cwd: dataDir, model: { provider: model.provider, modelId: model.id } }) };

    // Time selection with a compatible saved pass, including the real proof store on disk.
    writeFileSync(join(stateDir, '1.jsonl.acp.json'), JSON.stringify({ blocks: [], lastPassIds }));
    const epochs = new ContextEpochStore(join(dataDir, 'selection-contexts'));
    const selected = await measurePair('selectContext', messages => selectContext({ epochs, stateDir, sid: '1', messages, bridge, version }));
    assert.equal(selected.cold.epoch, 0);
    assert.equal(selected.warm.epoch, 0);

    const adapter = bridge.createBridge(host, bcp, version, { stateDir, extensionName: 'billion-context-pi', epoch: 0 });
    await measurePair('bridge.prepare', messages => adapter.prepare({ messages }, api, context));

    // The full hook includes its own selection, adapter preparation, and the untouched runtime.
    const beforeRequest = entry.default(host).hooks.find((hook: any) => hook.handlers.beforeRequest).handlers.beforeRequest;
    const output = await measurePair('beforeRequest', messages => beforeRequest({ messages }, { ...api, conversationId: '3' }, context));
    assert.ok(output.warm.messages.length > 0);

    // Measure stateFor with the same non-terminal host API, excluding adapter branch construction.
    const runtime = bcp.createRuntime();
    let branch: any[];
    const ctx = { model, sessionManager: { getSessionFile: () => undefined, getSessionId: () => '4', getBranch: () => branch } };
    const stateFor = async (entries: any[], messages: readonly any[]) => {
        branch = entries;
        const result = await runtime.stateFor(ctx, messages);
        assert.equal(result.entries.length, messages.length);
    };
    const tail = added();
    const cold = await measure(() => stateFor(lastPassIds.map((id: string, i: number) => ({ type: 'message', id, message: original[i] })), original));
    const entries = [...branch!, ...bridge.branchEntries([tail])];
    const messages = [...original, tail];
    const warm = await measure(() => stateFor(entries, messages));
    const samples = measurements.get('pinned stateFor') ?? [];
    samples.push([cold.duration, warm.duration]);
    measurements.set('pinned stateFor', samples);
}

console.log(`Node ${process.version}, runtime ${version}, ${original.length} messages, ${Buffer.byteLength(JSON.stringify(original))} bytes, ${trials} trials.`);
console.log('Wall time in ms, median [min–max]. Cold = first request, warm = same message objects plus one new message.');
for (const [name, samples] of measurements) {
    const stats = [0, 1].map(i => {
        const times = samples.map(sample => sample[i]).sort((a, b) => a - b);
        return `${times[Math.floor(times.length / 2)].toFixed(1)} [${times[0].toFixed(1)}–${times.at(-1)!.toFixed(1)}]`;
    });
    console.log(`${name}: cold ${stats[0]}, warm ${stats[1]}`);
}
