/** Public HTTP menu routes and real Pocket context hand-off. Models and owner downloads are faked;
 * a clean checkout obtains the exact verified npm archive once as test data before installing fetch counters. */
import { pinArchiveCache } from "./env.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { repo, ENTRY, FILES, dropInFolder } from "./fixtures.ts";
import { pinnedTestArchive } from "./pinned-archive.mjs";

const pocketDir = process.env.PI_POCKET_CHECKOUT;
const skip = pocketDir && existsSync(join(pocketDir, "test/helpers.ts")) ? false : "set PI_POCKET_CHECKOUT to a Pi Pocket checkout";
if (process.env.CI && skip !== false) throw new Error(`Integration tests must not skip in CI: ${skip}`);
let h: any;
let faux: any;
let app: any;
let dataDir: string;
let entry: string;
const trace = { messages: [] as readonly any[], requests: 0, native: 0 };
const textOf = (messages: readonly any[]) => messages.map((message) => JSON.stringify(message.content)).join("\n");
const lock = JSON.parse(readFileSync(join(repo, FILES, "runtime-lock.json"), "utf8"));
const pin = lock.releases.find((value: any) => value.version === lock.current);

function scriptedModel() {
    return h.scriptedModel((request: any) => {
        trace.requests += 1;
        trace.messages = request.messages;
        if (JSON.stringify(request).includes("context summarization assistant")) {
            trace.native += 1;
            return faux.fauxAssistantMessage([faux.fauxText("POCKET_NATIVE_SUMMARY: the earlier diagnostics were summarized by normal Pocket compaction.")]);
        }
        const { role, text } = h.lastText(request);
        const call = (name: string, args: any) => faux.fauxAssistantMessage([faux.fauxToolCall(name, args)], { stopReason: "toolUse" });
        if (role === "user" && text.includes("force-compress")) {
            return call("compress", { content: [{ startId: "m00001", endId: "m00001", summary: "MUST_NOT_CREATE_A_NEW_BLOCK" }] });
        }
        if (role === "user" && /read ([AB])/.test(text)) {
            return call("read", { path: join(h.work, `${/read ([AB])/.exec(text)![1]}.log`) });
        }
        if (role === "user" && /fold ([AB])/.test(text)) {
            const letter = /fold ([AB])/.exec(text)![1];
            const original = request.messages.find((message: any) => message.role === "toolResult" && JSON.stringify(message.content).includes(`OLD_LOG_${letter}`));
            assert.ok(original, "the actual original read result is present before compression");
            const ref = JSON.stringify(original.content).match(/m\d{5}/)?.[0];
            assert.ok(ref, "BCP assigned a current message reference");
            return call("compress", { content: [{ startId: ref, endId: ref, summary: `SUMMARY_${letter}: the finding from the original log, with all important details kept.` }] });
        }
        return faux.fauxAssistantMessage([faux.fauxText(role === "toolResult" ? "Completed." : "Continued.")]);
    });
}

if (skip === false) {
    h = await import(join(pocketDir!, "test/helpers.ts"));
    faux = await import(join(pocketDir!, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js"));
    dataDir = join(h.root, "bootstrap-legacy");
    entry = dropInFolder(join(dataDir, "extensions"));
    writeFileSync(join(h.work, "A.log"), "OLD_LOG_A: original diagnostics\n".repeat(200));
    writeFileSync(join(h.work, "B.log"), "OLD_LOG_B: later diagnostics\n".repeat(200));
    app = await h.openApp(scriptedModel(), dataDir);
    await app.setExtensionEnabled(h.owner(app), ENTRY, true);
    after(async () => { await app.close(); h.cleanUp(); });
}

async function say(target: any, id: any, text: string) {
    await h.say(target, id, text);
}
function saved(directory: string, id: any) {
    const boundary = join(directory, "billion-context-pi-pocket-runtime/contexts", `${id}.json`);
    const epoch = existsSync(boundary) ? JSON.parse(readFileSync(boundary, "utf8")).epoch : 0;
    const suffix = epoch > 0 ? `.context-${epoch}` : "";
    const file = join(directory, "billion-context-pi", `${id}${suffix}.jsonl.acp.json`);
    return { epoch, file, value: JSON.parse(readFileSync(file, "utf8")) };
}
async function withApi(target: any, action: (api: any) => Promise<void>) {
    const { createHandler } = await import(join(pocketDir!, "src/server/http.ts"));
    const server = createServer(createHandler({ app: target, listen: { host: "127.0.0.2", port: 0 }, restart() {} }));
    await new Promise<void>((done) => server.listen(0, "127.0.0.2", done));
    const origin = `http://127.0.0.2:${(server.address() as { port: number }).port}/api/x/billion-context-pi-pocket/`;
    const api = async (path: string, body?: unknown, status = 200, authenticated = true) => {
        const response = await fetch(origin + path, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: authenticated ? `Bearer ${target.config.ownerToken}` : "Bearer not-an-owner-token", "x-pocket": "1", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const result = await response.json();
        assert.equal(response.status, status, JSON.stringify(result));
        return result as any;
    };
    try { await action(api); }
    finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}

async function withFreshInstall(name: string, action: (fixture: any) => Promise<void>) {
    const directory = join(h.root, name);
    dropInFolder(join(directory, "extensions"), {}, false);
    const archive = await pinnedTestArchive(pin, { cacheDir: pinArchiveCache });
    const originalFetch = globalThis.fetch;
    let downloads = 0;
    let offline = false;
    const urls: string[] = [];
    const mockedFetch = (async (input: any, options: any) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        if (url !== pin.tarball) return originalFetch(input, options);
        downloads += 1;
        if (offline) throw new Error("OFFLINE_TEST");
        return new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    globalThis.fetch = mockedFetch;
    let target = await h.openApp(scriptedModel(), directory);
    // Pocket installs its own global fetch wrapper while opening; inject the transport after that setup.
    globalThis.fetch = mockedFetch;
    await target.setExtensionEnabled(h.owner(target), ENTRY, true);
    const fixture = {
        directory, get app() { return target; }, downloads: () => downloads, urls,
        sameFetch: () => globalThis.fetch === mockedFetch,
        setOffline(value: boolean) { offline = value; },
        async reopen() { await target.close(); target = await h.openApp(scriptedModel(), directory); globalThis.fetch = mockedFetch; await target.setExtensionEnabled(h.owner(target), ENTRY, true); },
    };
    try { await action(fixture); }
    finally { await target.close(); globalThis.fetch = originalFetch; }
}

test("owner menu installs only after a click, rejects unpinned input, and uninstalls without changing ACP", { skip, timeout: 30_000 }, async () => {
    await withFreshInstall("fresh-owner-menu", async (fixture: any) => {
        await withApi(fixture.app, async (api) => {
            const initial = await api("status");
            assert.equal(initial.runtime.state, "absent");
            assert.equal(initial.runtime.installed, false);
            assert.equal(fixture.downloads(), 0, "module load and menu status never install");
            assert.equal(existsSync(join(fixture.directory, "billion-context-pi")), false);
            await api("runtime/install", { version: "unreviewed" }, 400);
            await api("runtime/install", null, 400);
            await api("runtime/install", {}, 401, false);
            assert.equal(fixture.downloads(), 0);
            const installed = await api("runtime/install", {});
            assert.equal(installed.runtime.installed, true);
            assert.equal(installed.runtime.managed, true);
            assert.equal(installed.runtime.version, pin.version);
            assert.equal(fixture.downloads(), 1, JSON.stringify({ urls: fixture.urls, sameFetch: fixture.sameFetch() }));
            assert.equal(existsSync(join(fixture.directory, "extensions", FILES, `billion-context-pi-${pin.version}`)), false, "the program is not inside gallery files");
            const id = await h.newSession(fixture.app);
            await say(fixture.app, id, "read A");
            await say(fixture.app, id, "fold A");
            const snapshot = saved(fixture.directory, id);
            assert.equal(snapshot.value.blocks.length, 1);
            const bytes = readFileSync(snapshot.file);
            const removed = await api("runtime/uninstall", {});
            assert.equal(removed.runtime.state, "uninstalled");
            assert.equal(removed.runtime.installed, false);
            for (const folder of ["packages", "archives"]) assert.equal(existsSync(join(fixture.directory, "billion-context-pi-pocket-runtime", folder)), false, "a healthy uninstall removes program caches instead of creating recovery backups");
            assert.deepEqual(readFileSync(snapshot.file), bytes, "uninstall never deletes or rewrites ACP history");
            const again = await api("runtime/install", {});
            assert.equal(again.runtime.installed, true);
            assert.equal(fixture.downloads(), 2);
            await say(fixture.app, id, "continue");
            assert.match(textOf(trace.messages), /SUMMARY_A/);
            assert.doesNotMatch(textOf(trace.messages), /OLD_LOG_A/);
        });
    });
});

test("verified installed programs and saved compression work after an offline restart", { skip, timeout: 30_000 }, async () => {
    await withFreshInstall("fresh-offline", async (fixture: any) => {
        await withApi(fixture.app, async (api) => { await api("runtime/install", {}); });
        const id = await h.newSession(fixture.app);
        await say(fixture.app, id, "read A");
        await say(fixture.app, id, "fold A");
        fixture.setOffline(true);
        await fixture.reopen();
        await withApi(fixture.app, async (api) => { assert.equal((await api("status")).runtime.installed, true); });
        assert.equal(fixture.downloads(), 1, "restart must not download");
        await say(fixture.app, id, "continue");
        assert.match(textOf(trace.messages), /SUMMARY_A/);
        assert.doesNotMatch(textOf(trace.messages), /OLD_LOG_A/);
        assert.equal(fixture.downloads(), 1);
    });
});

test("chat Off is isolated and both configurable modes behave as promised", { skip, timeout: 20_000 }, async () => {
    const first = await h.newSession(app);
    const second = await h.newSession(app);
    await say(app, first, "read A"); await say(app, first, "fold A");
    await say(app, second, "read B"); await say(app, second, "fold B");
    await withApi(app, async (api) => {
        assert.equal((await api(`status/${first}`)).session.offBehavior, "restore-history");
        await api(`session/${first}`, { enabled: false, offBehavior: "restore-history" });
        await say(app, first, "continue");
        assert.match(textOf(trace.messages), /OLD_LOG_A/, "full Off restores original history");
        assert.equal((await api(`status/${second}`)).session.enabled, true);
        assert.equal(saved(dataDir, second).value.blocks.length, 1, "the second chat really compressed its original log");
        await say(app, second, "continue");
        assert.match(textOf(trace.messages), /SUMMARY_B/);
        assert.equal(textOf(trace.messages).includes("OLD_LOG_B"), false, JSON.stringify({ epoch: saved(dataDir, second).epoch, blocks: saved(dataDir, second).value.blocks }));
        await api(`session/${first}`, { offBehavior: "keep-summaries" });
        await say(app, first, "continue");
        assert.match(textOf(trace.messages), /SUMMARY_A/);
        assert.doesNotMatch(textOf(trace.messages), /OLD_LOG_A/);
        assert.match(textOf(trace.messages), /paused for this chat/);
        await say(app, first, "force-compress");
        const conversation = await app.harness.conversation(first, h.context);
        const history = (await conversation.context(h.context)).messages;
        const blocked = history.findLast((message: any) => message.role === "toolResult" && message.toolName === "compress");
        assert.equal(blocked.isError, true);
        assert.match(textOf([blocked]), /off in this chat/);
        assert.equal(saved(dataDir, first).value.blocks.length, 1);
        await api(`session/${first}`, { enabled: true });
        await say(app, first, "continue");
        assert.match(textOf(trace.messages), /SUMMARY_A/);
        assert.doesNotMatch(textOf(trace.messages), /paused for this chat/);
    });
});

test("legacy active compression and fork checkpoints survive inactive historical blocks", { skip, timeout: 20_000 }, async () => {
    const id = await h.newSession(app);
    await say(app, id, "read A"); await say(app, id, "fold A");
    const original = saved(dataDir, id);
    const priorRefs = structuredClone(original.value.messageRefs.byRaw);
    const active = original.value.blocks.find((block: any) => block.active);
    assert.ok(active);
    const legacy = structuredClone(original.value);
    legacy.blocks.push({ ...active, blockId: "b999", active: false, expanded: true,
        compressCallId: "historical-compress", effectiveMessageIds: ["live-deadbeefdeadbeef"], directMessageIds: ["live-deadbeefdeadbeef"] });
    await app.close();
    // A valid pre-upgrade sidecar has no Pocket epoch marker and may retain expanded historical blocks.
    writeFileSync(original.file, JSON.stringify(legacy));
    unlinkSync(join(dataDir, "billion-context-pi-pocket-runtime/contexts", `${id}.json`));
    app = await h.openApp(scriptedModel(), dataDir);
    await app.setExtensionEnabled(h.owner(app), ENTRY, true);
    await say(app, id, "continue with the inherited findings");
    const resumed = saved(dataDir, id);
    assert.equal(resumed.epoch, 0, "adoption must retain the existing ACP filename");
    assert.equal(resumed.file, original.file);
    assert.match(textOf(trace.messages), /SUMMARY_A/);
    assert.ok(resumed.value.blocks.some((block: any) => block.active && block.blockId === active.blockId));
    for (const [raw, ref] of Object.entries(priorRefs)) assert.equal(resumed.value.messageRefs.byRaw[raw], ref);
    await say(app, id, "read B"); await say(app, id, "fold B");
    const parent = await app.harness.conversation(id, h.context);
    const at = (await parent.entries({}, 1, undefined, h.context)).items[0].id;
    const child = await parent.fork(at, { ownership: { kind: "ownerless" } }, h.context);
    await (await child.submit({ type: "input", content: [{ type: "text", text: "continue with both findings" }] }, h.context)).wait(h.context);
    const inherited = saved(dataDir, child.id);
    assert.match(textOf(trace.messages), /SUMMARY_A/);
    assert.match(textOf(trace.messages), /SUMMARY_B/);
    assert.equal(inherited.value.blocks.filter((block: any) => block.active).length, 2,
        "checkpoint coverage must not reject valid active summaries because of an inactive historical block");
});

test("a paused fork restores summaries before rendering its first prompt", { skip, timeout: 20_000 }, async () => {
    const id = await h.newSession(app);
    await say(app, id, "read A"); await say(app, id, "fold A");
    await withApi(app, async (api) => {
        await api(`session/${id}`, { enabled: false, offBehavior: "keep-summaries" });
        await say(app, id, "continue");
        const parent = await app.harness.conversation(id, h.context);
        const at = (await parent.entries({}, 1, undefined, h.context)).items[0].id;
        const child = await parent.fork(at, { ownership: { kind: "ownerless" } }, h.context);
        await (await child.submit({ type: "input", content: [{ type: "text", text: "continue" }] }, h.context)).wait(h.context);
        // SDK-only forks have no Pocket session-list entry; read their public conversation document directly.
        const { SessionPrefs } = await import(pathToFileURL(entry).href);
        const profile = await app.harness.snapshot(SessionPrefs, child.id, h.context);
        assert.equal(profile.enabled, false);
        assert.equal(profile.offBehavior, "keep-summaries");
        const system = textOf(trace.messages.filter((message) => message.role === "system"));
        assert.match(system, /paused for this chat/);
        assert.match(system, /SUMMARY_A/, "the first paused prompt includes the inherited summary");
        assert.doesNotMatch(textOf(trace.messages), /OLD_LOG_A/);
        assert.equal(saved(dataDir, child.id).value.blocks.length, 1);
    });
});

test("Restore history respects an owner's disabled native-compaction setting instead of trapping the switch", { skip }, async () => {
    const id = await h.newSession(app);
    await say(app, id, "read A"); await say(app, id, "fold A");
    app.settings.applyOverrides({ compaction: { enabled: false } });
    try {
        await withApi(app, async (api) => {
            const disabled = await api(`session/${id}`, { enabled: false, offBehavior: "restore-history" });
            assert.equal(disabled.session.enabled, false);
            await say(app, id, "continue");
            assert.match(textOf(trace.messages), /OLD_LOG_A/);
        });
    } finally { app.settings.applyOverrides({ compaction: { enabled: true } }); }
});

test("normal Pocket compaction while Off starts a new ACP epoch without reviving old blocks", { skip, timeout: 30_000 }, async () => {
    app.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50 } });
    const id = await h.newSession(app);
    await say(app, id, "read A"); await say(app, id, "fold A");
    const original = saved(dataDir, id);
    const originalBytes = readFileSync(original.file);
    const conversation = await app.harness.conversation(id, h.context);
    const nativeBefore = trace.native;
    const blocked = await app.harness.waitForTask(await conversation.compact(undefined, h.context), h.context);
    assert.equal(blocked.state.outcome.status, "completed");
    assert.equal(blocked.state.outcome.result.entryId, undefined, "BCP still vetoes native compaction while enabled");
    assert.equal(trace.native, nativeBefore);
    await withApi(app, async (api) => {
        await api(`session/${id}`, { enabled: false, offBehavior: "restore-history" });
        const result = await app.harness.waitForTask(await conversation.compact(undefined, h.context), h.context);
        assert.equal(result.state.outcome.status, "completed");
        const placement = result.state.outcome.result;
        assert.ok(placement.entryId || placement.submissionId, "normal Pocket compaction actually created a summary");
        if (placement.submissionId) await (await app.harness.submission(placement.submissionId, h.context)).wait(h.context);
        assert.equal(trace.native, nativeBefore + 1);
        await say(app, id, "continue");
        assert.match(textOf(trace.messages), /POCKET_NATIVE_SUMMARY/);
        assert.deepEqual(readFileSync(original.file), originalBytes, "the original ACP file is retained, not rewritten");
        await api(`session/${id}`, { enabled: true });
        await say(app, id, "continue");
        const current = saved(dataDir, id);
        assert.equal(current.epoch, 1);
        assert.notEqual(current.file, original.file);
        assert.equal(current.value.blocks.length, 0, "old pre-compaction checkpoints and calls must not recreate a block");
        assert.match(textOf(trace.messages), /POCKET_NATIVE_SUMMARY/);
        await say(app, id, "read B"); await say(app, id, "fold B");
        assert.equal(saved(dataDir, id).value.blocks.length, 1);
        assert.match(saved(dataDir, id).value.blocks[0].summary, /SUMMARY_B/);
        const at = (await conversation.entries({}, 1, undefined, h.context)).items[0].id;
        const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, h.context);
        await (await fork.submit({ type: "input", content: [{ type: "text", text: "continue" }] }, h.context)).wait(h.context);
        assert.match(textOf(trace.messages), /SUMMARY_B/);
        assert.doesNotMatch(textOf(trace.messages), /OLD_LOG_B/);
        assert.equal(saved(dataDir, fork.id).value.blocks.length, 1);
    });
});

test("New context with an identical opening never reuses the previous ACP state", { skip, timeout: 30_000 }, async t => {
    for (const mode of ["enabled", "restore-history", "keep-summaries"]) {
        await t.test(mode, async () => {
            const id = await h.newSession(app);
            const opening = "REPEATED_CONTEXT_OPENING: keep the original instructions.\n".repeat(200);
            await say(app, id, opening);
            await say(app, id, "read A");
            await say(app, id, "fold A");
            const original = saved(dataDir, id);
            assert.equal(original.value.blocks.length, 1);
            assert.match(original.value.blocks[0].summary, /SUMMARY_A/);
            const originalBytes = readFileSync(original.file);
            await withApi(app, async api => {
                if (mode !== "enabled") await api(`session/${id}`, { enabled: false, offBehavior: mode });
                const conversation = await app.harness.conversation(id, h.context);
                await conversation.reset(undefined, h.context);
                await say(app, id, opening);
                assert.doesNotMatch(textOf(trace.messages), /SUMMARY_A/,
                    "the first request after New context must not contain old summaries");
                assert.match(textOf(trace.messages), /REPEATED_CONTEXT_OPENING/);
                if (mode !== "enabled") await api(`session/${id}`, { enabled: true });
                await say(app, id, "continue in the new context");
                const current = saved(dataDir, id);
                assert.equal(current.epoch, original.epoch + 1);
                assert.equal(current.value.blocks.length, 0);
                assert.notEqual(current.file, original.file);
                assert.deepEqual(readFileSync(original.file), originalBytes,
                    "New context preserves the old ACP file instead of rewriting it");
                assert.doesNotMatch(textOf(trace.messages), /SUMMARY_A/);
                await say(app, id, "read B");
                await say(app, id, "fold B");
                assert.match(saved(dataDir, id).value.blocks[0].summary, /SUMMARY_B/,
                    "compression must still work in the fresh epoch");
            });
        });
    }
});

test("paused-view cleanup removes appended action reminders without deleting a summary or original text", { skip }, async () => {
    const module = await import(pathToFileURL(entry).href);
    const original = { role: "user", content: [{ type: "text", text: "My actual request" }], timestamp: 100 };
    const summary = { role: "assistant", content: [{ type: "text", text: "An existing compressed summary" }], timestamp: 50 };
    const notice = { role: "user", content: [{ type: "text", text: "New compression reminder" }], timestamp: 101 };
    const result = module.withoutNewNudges([summary, original, notice], [original]);
    assert.deepEqual(result, [summary, original]);
    assert.deepEqual(module.withoutNewNudges([summary], [original]), [summary], "a missing anchor must not erase context");
});

test("chat toggles retain the global default, and an explicit off-mode override can be reset", { skip }, async () => {
    const id = await h.newSession(app);
    await withApi(app, async (api) => {
        assert.equal((await api(`status/${id}`)).session.usesDefaultOffBehavior, true);
        const off = await api(`session/${id}`, { enabled: false });
        assert.equal(off.session.usesDefaultOffBehavior, true);
        assert.equal(off.session.offBehavior, "restore-history");
        const custom = await api(`session/${id}`, { offBehavior: "keep-summaries" });
        assert.equal(custom.session.usesDefaultOffBehavior, false);
        assert.equal(custom.session.offBehavior, "keep-summaries");
        const on = await api(`session/${id}`, { enabled: true });
        assert.equal(on.session.usesDefaultOffBehavior, false);
        assert.equal(on.session.offBehavior, "keep-summaries");
        const inherited = await api(`session/${id}`, { offBehavior: null });
        assert.equal(inherited.session.usesDefaultOffBehavior, true);
        assert.equal(inherited.session.offBehavior, "restore-history");
        await api(`session/${id}`, null, 400);
        await api(`session/${id}`, { offBehavior: "invented" }, 400);
        await api("status/not-a-number", undefined, 400);
        await api("status/999999999", undefined, 404);
    });
});

test("a corrupt program can be switched Off, repaired offline, and uninstalled without touching saved history", { skip, timeout: 30_000 }, async () => {
    await withFreshInstall("repair-owner-menu", async (fixture: any) => {
        await withApi(fixture.app, async (api) => { await api("runtime/install", {}); });
        const id = await h.newSession(fixture.app);
        await say(fixture.app, id, "read A"); await say(fixture.app, id, "fold A");
        const history = saved(fixture.directory, id);
        const bytes = readFileSync(history.file);
        const selection = join(fixture.directory, "billion-context-pi-pocket-runtime/selection.json");
        writeFileSync(selection, "{damaged selection");
        fixture.setOffline(true);
        await fixture.reopen();
        await withApi(fixture.app, async (api) => {
            const damaged = await api(`status/${id}`);
            assert.equal(damaged.runtime.state, "error");
            assert.equal(damaged.session.enabled, true);
            const off = await api(`session/${id}`, { enabled: false, offBehavior: "restore-history" });
            assert.equal(off.session.enabled, false, "saved compression must never trap the owner without a runtime");
            await say(fixture.app, id, "continue");
            assert.equal(textOf(trace.messages).includes("OLD_LOG_A"), true);
            const repaired = await api("runtime/repair", {});
            assert.equal(repaired.runtime.installed, true);
            assert.equal(fixture.downloads(), 1, "repair uses the original verified archive while offline");
            assert.deepEqual(readFileSync(history.file), bytes);
            await api(`session/${id}`, { enabled: true });
            await say(fixture.app, id, "continue");
            assert.match(textOf(trace.messages), /SUMMARY_A/);
            assert.equal(textOf(trace.messages).includes("OLD_LOG_A"), false);
            const retained = readFileSync(history.file);
            writeFileSync(selection, "not valid JSON again");
            const removed = await api("runtime/uninstall", {});
            assert.equal(removed.runtime.state, "uninstalled");
            assert.deepEqual(readFileSync(history.file), retained);
            assert.equal(fixture.downloads(), 1, "recovery uninstall never downloads or runs a program");
        });
    });
});

test("failed owner repair leaves the prior verified program usable", { skip, timeout: 30_000 }, async () => {
    await withFreshInstall("failed-owner-repair", async (fixture: any) => {
        await withApi(fixture.app, async (api) => {
            await api("runtime/install", {});
            const before = JSON.parse(readFileSync(join(fixture.directory, "billion-context-pi-pocket-runtime/selection.json"), "utf8"));
            // An uncached pin is covered by the RuntimeStore tests. Here force pre-activation validation to fail
            // by removing only the immutable script copied into this test entry; no real install is affected.
            const validator = join(fixture.directory, "extensions", FILES, "verify-runtime.mjs");
            const original = readFileSync(validator);
            writeFileSync(validator, "throw new Error('TEST_REPAIR_VALIDATION_FAILED');\n");
            try { await api("runtime/repair", {}, 500); }
            finally { writeFileSync(validator, original); }
            assert.deepEqual(JSON.parse(readFileSync(join(fixture.directory, "billion-context-pi-pocket-runtime/selection.json"), "utf8")), before);
            assert.equal((await api("status")).runtime.installed, true);
            const id = await h.newSession(fixture.app);
            await say(fixture.app, id, "read A"); await say(fixture.app, id, "fold A");
            assert.equal(saved(fixture.directory, id).value.blocks.length, 1);
        });
    });
});

test("a concurrent off-behavior update cannot undo an explicit Off action", { skip }, async () => {
    const module = await import(pathToFileURL(entry).href);
    const routes = new Map<string, any>();
    const register = (_method: string, path: string, handler: any) => routes.set(path, handler);
    module.default({ dataDir, notice() {} }, {
        module: "billion-context-pi-pocket", settings() {}, setting() {}, client() {}, send() {},
        route: register, conversationRoute: register,
        error(status: number, text: string) { return Object.assign(new Error(text), { status }); },
    });
    const change = routes.get("session/:source");
    assert.equal(typeof change, "function");
    const value: any = { enabled: true };
    let reached!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>((done) => { reached = done; });
    const allowCommit = new Promise<void>((done) => { release = done; });
    const request = (body: any, delayed: boolean) => ({
        body, conversation: { id: 900004 }, context: h.context,
        async snapshot() { return { ...value, compactions: [] }; },
        async commit(apply: any) {
            if (delayed) { reached(); await allowCommit; }
            await apply({ doc: async () => value });
        },
    });
    const behavior = change(request({ offBehavior: "keep-summaries" }, true));
    try {
        await atCommit;
        await change(request({ enabled: false }, false));
    } finally { release(); }
    await behavior;
    assert.equal(value.enabled, false, "the behavior-only request must not write an older enabled value");
    assert.equal(value.offBehavior, "keep-summaries");
});

test("continuing Pi without an installed program does not download code or create ACP state", { skip }, async () => {
    await withFreshInstall("no-program-pi-import", async (fixture: any) => {
        const module = await import(pathToFileURL(join(fixture.directory, "extensions", ENTRY)).href);
        let companion: any;
        let cleanup: (() => void) | undefined;
        let disposed = false;
        module.default({ dataDir: fixture.directory, notice() {}, registerPiSessionCompanion(value: any) {
            companion = value;
            return () => { disposed = true; };
        } }, {
            module: "billion-context-pi-pocket", settings() {}, setting() {}, client() {}, send() {},
            route() {}, conversationRoute() {}, onDispose(value: () => void) { cleanup = value; },
        });
        assert.equal(companion.suffix, ".acp.json");
        let fetches = 0;
        const original = globalThis.fetch;
        globalThis.fetch = (async () => { fetches++; throw new Error("Continue must not download the program"); }) as typeof fetch;
        let note: string;
        try {
            note = await companion.continued({ conversationId: 900005, piFile: "not-read.jsonl", companion: "not-read.jsonl.acp.json", entries: [] });
        } finally { globalThis.fetch = original; }
        assert.match(note!, /not installed/);
        assert.equal(fetches, 0);
        assert.equal(existsSync(join(fixture.directory, "billion-context-pi/900005.jsonl.acp.json")), false);
        assert.equal(existsSync(join(fixture.directory, "billion-context-pi-pocket-runtime/selection.json")), false);
        cleanup!();
        assert.equal(disposed, true, "the optional host registration must be disposed with the module");
    });
});

test("switching Off allows automatic Pocket compaction and re-enable does not reload the old ACP epoch", { skip, timeout: 30_000 }, async () => {
    // The faux model has a 128k context window. This real policy puts the automatic threshold near 1k tokens.
    app.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50, backgroundTokens: 0,
        modelOverrides: { "faux/faux-1": { reserveTokens: 127_000 } } } });
    const id = await h.newSession(app);
    await say(app, id, "read A"); await say(app, id, "fold A");
    assert.equal(saved(dataDir, id).value.blocks.length, 1);
    const nativeBefore = trace.native;
    await withApi(app, async (api) => {
        await api(`session/${id}`, { enabled: false, offBehavior: "restore-history" });
        await say(app, id, "continue");
        assert.ok(trace.native > nativeBefore, "normal generation, not a manual compact request, ran Pocket compaction");
        assert.match(textOf(trace.messages), /POCKET_NATIVE_SUMMARY/);
        await api(`session/${id}`, { enabled: true });
        await say(app, id, "continue");
        const current = saved(dataDir, id);
        assert.ok(current.epoch > 0);
        assert.equal(current.value.blocks.length, 0);
        assert.match(textOf(trace.messages), /POCKET_NATIVE_SUMMARY/);
    });
});
