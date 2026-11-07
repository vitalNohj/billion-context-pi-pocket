/** Real linked runner, WebSocket, daemon, Pocket hook chain and guarded remote file export. */
import './env.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { dropInFolder, ENTRY } from './fixtures.ts';
const pocket = process.env.PI_POCKET_CHECKOUT;
const skip = pocket && existsSync(join(pocket, 'test/helpers.ts')) ? false : 'set PI_POCKET_CHECKOUT to a Pi Pocket checkout';
if (process.env.CI && skip) throw new Error(String(skip));
const text = (messages: readonly any[]) => messages.map(message => JSON.stringify(message.content)).join('\n');

test('linked runner keeps aliased compression through forks/restart and guarded exports stay on its computer', { skip, timeout: 90000 }, async t => {
    const h = await import(join(pocket!, 'test/helpers.ts'));
    const { Runner } = await import(join(pocket!, 'src/runner/runner.ts'));
    const { fauxAssistantMessage, fauxText, fauxToolCall } = await import(join(pocket!, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js'));
    const computer = join(h.root, 'linked-computer');
    mkdirSync(computer);
    writeFileSync(join(computer, 'A.log'), 'REMOTE_KNOWN_A: the database is amber.\n'.repeat(400));
    writeFileSync(join(computer, 'B.log'), 'REMOTE_LATER_B: the parent-only later finding.\n'.repeat(400));
    let lastRequest: readonly any[] = [];
    const model = h.scriptedModel((request: any) => {
        lastRequest = request.messages;
        const last = request.messages.findLast((message: any) => message.role !== 'system');
        const body = h.lastText(request).text;
        const call = (name: string, args: any) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
        if (last.role === 'user' && body.includes('read-legacy')) return call('read', { path: join(computer, 'A.log') });
        if (last.role === 'user' && body.includes('read-later')) return call('read', { path: join(computer, 'B.log') });
        if (last.role === 'toolResult' && last.toolName === 'read' && body.includes('REMOTE_KNOWN_A')) {
            return call('artifact_inline', { id: 'legacy-report', content: 'REMOTE_OLD_ARTIFACT: the runner is violet.\n'.repeat(250) });
        }
        if (last.role === 'toolResult' && last.toolName === 'artifact_inline') {
            return fauxAssistantMessage([fauxText('Completed. ' + 'Later context remains visible and ages the old artifact. '.repeat(600))]);
        }
        if (last.role === 'user' && /fold-(legacy|later)/.test(body)) {
            const legacy = body.includes('fold-legacy');
            const start = request.messages.find((message: any) => message.role === 'toolResult' && message.toolName === 'read' && text([message]).includes(legacy ? 'REMOTE_KNOWN_A' : 'REMOTE_LATER_B'));
            const end = legacy ? request.messages.find((message: any) => message.role === 'toolResult' && message.toolName === 'artifact_inline') : start;
            const ref = (message: any) => text([message]).match(/m\d{5}/)?.[0];
            assert.ok(ref(start)); assert.ok(ref(end));
            return call('compress', { content: [{ startId: ref(start), endId: ref(end), summary: legacy
                ? 'REMOTE_SUMMARY_A: database amber and runner violet; retain all original remote details.'
                : 'REMOTE_SUMMARY_B: parent-only later finding, outside the earlier fork cutoff.' }] });
        }
        const target = /export-json:(\{[^\n]*\})/.exec(body);
        if (last.role === 'user' && target) return call('decompress', JSON.parse(target[1]));
        return fauxAssistantMessage([fauxText('Continued.')]);
    });
    const dataDir = join(h.root, 'remote-server-data');
    const entry = dropInFolder(join(dataDir, 'extensions'));
    let app: any;
    let runner: any;
    const server = createServer((_request, response) => response.writeHead(404).end());
    server.on('upgrade', (request, socket, head) => { if (!app.runners.upgrade(request, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await runner?.stop();
        await app?.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        h.cleanUp();
    });
    app = await h.openApp(model, dataDir);
    await app.setExtensionEnabled(h.owner(app), ENTRY, true);
    // Reproduce a genuinely old history through the public app, before enabling Pocket's compatibility hook.
    await app.setExtensionEnabled(h.owner(app), 'artifacts.ts', false);
    await app.setExtensionEnabled(h.owner(app), 'guard.ts', true);
    const { code } = app.runners.makeCode('Migration test computer', h.owner(app).id);
    const linked = app.runners.redeem(code);
    const runnerOptions = { link: { server: `http://127.0.0.1:${(server.address() as any).port}`, ...linked },
        version: 'test', cwd: computer, log() {}, retryMs: [50, 100, 200], ask: async () => ({ allow: true }) };
    const connect = async () => {
        runner = new Runner(runnerOptions);
        runner.start();
        await h.until(() => app.runners.list().some((item: any) => item.id === linked.id && item.online), 'linked runner connection');
        await app.runners.link(linked.id).info();
    };
    await connect();
    const { id } = await app.commands.createSession(h.owner(app), { cwd: computer, runner: linked.id });
    await app.commands.configure(id, h.owner(app), { model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: 'off' });
    const parent = await app.harness.conversation(id, h.context);
    const reply = async () => (await parent.entries({}, 50, undefined, h.context)).items.find((entry: any) => entry.model?.some((message: any) => message.role === 'assistant'))!.id;
    await h.say(app, id, 'read-legacy');
    for (let i = 0; i < 3; i++) await h.say(app, id, `continue aging ${i}`);
    const beforeCompression = await reply();
    await h.say(app, id, 'fold-legacy');
    const afterCompression = await reply();
    const stateDir = join(dataDir, 'billion-context-pi');
    const markers = join(dataDir, 'billion-context-pi-pocket-runtime/contexts');
    const marker = (source: any) => JSON.parse(readFileSync(join(markers, `${source}.json`), 'utf8'));
    const file = (source: any) => join(stateDir, `${source}${marker(source).epoch ? `.context-${marker(source).epoch}` : ''}.jsonl.acp.json`);
    const originalFile = file(id), original = readFileSync(originalFile);
    assert.equal(JSON.parse(original.toString()).blocks.length, 1);
    assert.ok(text((await parent.context(h.context)).messages).includes('artifact_inline'));
    await app.setExtensionEnabled(h.owner(app), 'artifacts.ts', true);
    await h.say(app, id, 'continue after artifact compatibility');
    assert.equal(marker(id).epoch, 1);
    assert.deepEqual(readFileSync(originalFile), original);
    assert.match(text(lastRequest), /REMOTE_SUMMARY_A/);
    assert.doesNotMatch(text(lastRequest), /REMOTE_KNOWN_A|REMOTE_OLD_ARTIFACT/);
    await h.say(app, id, 'read-later');
    await h.say(app, id, 'fold-later');
    assert.equal(JSON.parse(readFileSync(file(id), 'utf8')).blocks.length, 2);
    const before = await app.commands.fork(id, h.owner(app), { entryId: beforeCompression });
    await h.say(app, before.id, 'continue before compression');
    assert.equal(app.runnerOf(before.id), linked.id);
    assert.equal(JSON.parse(readFileSync(file(before.id), 'utf8')).blocks.length, 0);
    assert.doesNotMatch(text(lastRequest), /REMOTE_SUMMARY_A|REMOTE_SUMMARY_B/);
    const after = await app.commands.fork(id, h.owner(app), { entryId: afterCompression });
    const adapter = await import(pathToFileURL(entry).href);
    const child = await app.harness.conversation(after.id, h.context);
    await child.commit(async (tx: any) => {
        const prefs = await tx.doc(adapter.SessionPrefs, after.id);
        prefs.enabled = false; prefs.offBehavior = 'keep-summaries';
    }, h.context);
    await h.say(app, after.id, 'continue after compression');
    assert.equal(app.runnerOf(after.id), linked.id);
    assert.equal(JSON.parse(readFileSync(file(after.id), 'utf8')).blocks.length, 1);
    assert.match(text(lastRequest), /REMOTE_SUMMARY_A/);
    assert.doesNotMatch(text(lastRequest), /REMOTE_SUMMARY_B|REMOTE_KNOWN_A/);
    const selectedEpoch = marker(after.id).epoch;
    await runner.stop(); runner = undefined;
    await app.close(); app = undefined;
    app = await h.openApp(model, dataDir);
    await connect();
    const remoteWrites: string[] = [];
    const envFor = app.runners.env.bind(app.runners);
    app.runners.env = (...args: any[]) => {
        const env = envFor(...args), write = env.writeFile.bind(env);
        env.writeFile = (...values: any[]) => { remoteWrites.push(values[0]); return write(...values); };
        return env;
    };
    await h.say(app, after.id, 'continue after cold restart');
    assert.equal(marker(after.id).epoch, selectedEpoch);
    assert.equal(JSON.parse(readFileSync(file(after.id), 'utf8')).blocks.length, 1);
    assert.match(text(lastRequest), /REMOTE_SUMMARY_A/);
    assert.doesNotMatch(text(lastRequest), /REMOTE_SUMMARY_B/);
    const guarded: any[] = [];
    app.guard.judge = async (name: string, args: any) => {
        if (name !== 'write') return undefined;
        guarded.push(args);
        return { subject: args.path, decision: { action: 'allow', reason: 'REMOTE_MIGRATION_TEST' } };
    };
    const destination = join(computer, 'restored.txt');
    await h.say(app, after.id, `export-json:${JSON.stringify({ blockId: 'b1', full: true, toFile: destination })}`);
    const exported = (await (await app.harness.conversation(after.id, h.context)).context(h.context)).messages.findLast((message: any) => message.role === 'toolResult' && message.toolName === 'decompress');
    assert.ok(exported, 'the scripted model actually called decompress');
    assert.notEqual(exported.isError, true, text([exported]));
    assert.equal(guarded.length, 1, 'real Pocket guard sees the nested write');
    assert.equal(guarded[0].path, destination);
    assert.ok(remoteWrites.includes(destination), 'the actual runner ExecutionEnv performs the destination write');
    assert.match(readFileSync(destination, 'utf8'), /REMOTE_KNOWN_A|REMOTE_OLD_ARTIFACT/);
    assert.deepEqual(readdirSync(computer).sort(), ['A.log', 'B.log', 'restored.txt']);
    assert.ok(existsSync(join(markers, 'proofs')));
    assert.ok(existsSync(file(after.id)), 'runtime state/proofs stay with the server, not the linked computer');
});
