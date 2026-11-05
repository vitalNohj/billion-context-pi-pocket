/**
 * The adapter loaded the way Pi Pocket loads it: a drop-in in a test app's data folder, turned on, with a scripted
 * model (nothing reaches a provider). Needs a Pi Pocket checkout: `PI_POCKET_CHECKOUT=/path/to/pi-pocket npm test`.
 */
import { testHome } from "./env.ts";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { repo, ENTRY as ADAPTER, FILES as BUNDLE, SETTINGS, LEGACY_SETTINGS, dropInFolder } from "./fixtures.ts";
const pocketDir = process.env.PI_POCKET_CHECKOUT;
const skip =
    pocketDir === undefined
        ? "set PI_POCKET_CHECKOUT to a Pi Pocket checkout"
        : existsSync(join(pocketDir, "test", "helpers.ts"))
          ? false
          : `no Pi Pocket checkout at ${pocketDir}`;
if (process.env.CI && skip !== false) throw new Error(`Integration tests must not skip in CI: ${skip}`);

let h: any;
let app: any;
let dataDir = "";
let dropin = "";
let lastRequest: readonly any[] = [];
let mod: any;
let model: any;
let requestCount = 0;
const CHECKPOINT_KEY = "pocketBcpCheckpoint";

if (skip === false) {
    h = await import(join(pocketDir!, "test", "helpers.ts"));
    const { fauxAssistantMessage, fauxText, fauxToolCall } = await import(
        join(pocketDir!, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")
    );
    const { work, root, lastText, scriptedModel, openApp, owner, cleanUp } = h;
    dataDir = join(root, "data-bcp");
    dropin = dropInFolder(join(dataDir, "extensions"));
    writeFileSync(join(work, "A.log"), "OLD_LOG_A: original diagnostics\n".repeat(200));
    writeFileSync(join(work, "B.log"), "OLD_LOG_B: later diagnostics\n".repeat(200));

    model = scriptedModel((request: any) => {
        requestCount += 1;
        lastRequest = request.messages;
        const { role, text } = lastText(request);
        const call = (name: string, args: any) =>
            fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
        const batchDecompression = /decompress-batch:(\[[^\n]*\])/.exec(text);
        if (role === "user" && batchDecompression) {
            return call("codemode", { code: `const results = await Promise.all(${batchDecompression[1]}.map(args => tools.decompress(args))); for (const result of results) text(result);` });
        }
        const requestedDecompression = /decompress-json:(\{[^\n]*\})/.exec(text);
        if (role === "user" && requestedDecompression) {
            return call("decompress", JSON.parse(requestedDecompression[1]));
        }
        if (role === "user" && /read ([AB])/.test(text)) {
            return call("read", { path: join(work, `${/read ([AB])/.exec(text)![1]}.log`) });
        }
        if (role === "user" && /fold ([AB])/.test(text)) {
            const letter = /fold ([AB])/.exec(text)![1];
            const result = request.messages.find(
                (m: any) => m.role === "toolResult" && JSON.stringify(m.content).includes(`OLD_LOG_${letter}`),
            );
            assert.ok(result, "the old read result is there before it is folded");
            const ref = JSON.stringify(result.content).match(/m\d{5}/)?.[0];
            assert.ok(ref, "billion-context-pi tagged the old read result");
            const args = {
                content: [
                    {
                        startId: ref,
                        endId: ref,
                        summary: `SUMMARY_${letter}: the finding from the original log, with all important details kept.`,
                    },
                ],
            };
            if (text.includes("nested")) {
                const fail = text.includes("nested-error") ? '\nthrow new Error("fails after compressing");' : "";
                return call("codemode", { code: `text(await tools.compress(${JSON.stringify(args)}));${fail}` });
            }
            return call("compress", args);
        }
        if (role === "user" && text.includes("unfold")) {
            return call("decompress", {
                blockId: "b1",
                ...(text.includes("custom") ? { toFile: join(testHome, "custom-decompression.txt") }
                    : text.includes("file") ? {} : { inline: true }),
            });
        }
        return fauxAssistantMessage([fauxText(role === "toolResult" ? "Completed." : "Continued.")]);
    });
    app = await openApp(model, dataDir);
    await app.setExtensionEnabled(owner(app), ADAPTER, true);
    // The helper disables the classifier; explicitly enable Pocket's guard hook so controlled verdicts exercise it.
    await app.setExtensionEnabled(owner(app), "guard.ts", true);
    mod = await import(pathToFileURL(dropin).href);
    after(async () => {
        await app.close();
        cleanUp();
    });
}

const stateFile = (id: unknown) => join(dataDir, "billion-context-pi", `${id}.jsonl.acp.json`);
const state = (id: unknown) => JSON.parse(readFileSync(stateFile(id), "utf8"));
// Normal requests age blocks; compare compressed content and active/restored state, not those maintenance counters.
const blockContent = (id: unknown) => JSON.stringify(state(id).blocks.map(({ survivedCount: _age, generation: _generation, ...block }: any) => block));
const tail = async (conversation: any) => (await conversation.entries({}, 1, undefined, h.context)).items[0].id;
const textOf = (messages: readonly any[]) => messages.map((m) => JSON.stringify(m.content)).join("\n");
const continueFork = async (parent: any, at: any) => {
    const fork = await parent.fork(at, { ownership: { kind: "ownerless" } }, h.context);
    await (await fork.submit({ type: "input", content: [{ type: "text", text: "continue" }] }, h.context)).wait(
        h.context,
    );
    return fork;
};
/** A second instance of the drop-in, as a reload makes, and its request hook. */
const reloadedGeneration = async () => {
    const reloaded = await import(`${pathToFileURL(dropin).href}?reload=${Date.now()}`);
    const extension = reloaded.default({ dataDir, notice() {} });
    return extension.hooks.find((hk: any) => hk.handlers.beforeRequest).handlers;
};
const fakeApi = (conversationId: string) => ({
    conversationId,
    models: { getModel: () => ({ id: "faux-1", provider: "faux", contextWindow: 128000 }) },
    snapshot: async () => ({ cwd: h.work, model: { provider: "faux", modelId: "faux-1" } }),
});

test("says it works in sessions on another computer", { skip }, () => {
    assert.equal(mod.remoteSessions, true);
});

test("installs billion-context-pi's tools and prompt under the default name", { skip }, async () => {
    const extension = mod.default({ dataDir, notice() {} });
    assert.equal(extension.name, "billion-context-pi");
    assert.deepEqual(
        extension.tools.map((t: any) => t.name).sort(),
        ["acp_cache", "acp_status", "compress", "decompress", "search_context"],
    );
    assert.deepEqual(
        extension.sections.map((s: any) => s.key),
        ["billion_context"],
    );
    assert.ok(
        extension.tools.filter((t: any) => t.name !== "decompress").every((t: any) => t.annotations?.readOnlyHint === true),
        "context-only tools remain read-only",
    );
    const decompress = extension.tools.find((tool: any) => tool.name === "decompress");
    assert.equal(decompress.annotations.readOnlyHint, false, "a file-capable tool must not promise to be read-only");
    assert.equal(decompress.replay, "unsafe", "a requested file write cannot repeat after a crash");
    assert.deepEqual(Object.keys(decompress.parameters.properties).sort(), ["blockId", "full", "inline", "toFile"]);
});

test("compression keeps working in plan mode, where Pi Pocket lets read-only tools run", { skip }, async () => {
    const { context, newSession, say, owner, modelTexts } = h;
    const id = await newSession(app);
    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const said = (await modelTexts(app, id)).join("\n");
    assert.doesNotMatch(said, /Plan mode is on: The compress tool/);
    assert.equal(state(id).blocks.length, 1, "the compress call ran");
    await app.commands.approvePlan(id, owner(app));
});

test("forks recover only the compression made before their fork point", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    const parent = (await app.harness.conversation(id, context))!;
    await say(app, id, "read A");
    const beforeCompression = await tail(parent);
    await say(app, id, "fold A");
    const afterA = await tail(parent);
    assert.equal(state(id).blocks.length, 1);
    const system = lastRequest.filter((m: any) => m.role === "system");
    assert.ok(
        system.some((m: any) => /compress/.test(m.sections?.billion_context ?? m.content ?? "")),
        "billion-context-pi's prompt reaches the model",
    );
    const history = (await parent.context(context)).messages;
    const withCheckpoint = history.find((m: any) => m.role === "toolResult" && m.details?.[CHECKPOINT_KEY]) as any;
    assert.ok(withCheckpoint, "the compress result carries a checkpoint");
    assert.ok(!textOf(history).includes(CHECKPOINT_KEY), "the checkpoint is not model-visible");
    const checkpoint = withCheckpoint.details[CHECKPOINT_KEY];
    assert.equal(checkpoint.version, 2);
    assert.ok(JSON.stringify(checkpoint).length < 300, "the checkpoint does not copy the old log");

    await say(app, id, "read B");
    await say(app, id, "fold B");
    assert.equal(state(id).blocks.length, 2);

    const forkBefore = await continueFork(parent, beforeCompression);
    assert.equal(state(forkBefore.id).blocks.length, 0);
    assert.match(textOf(lastRequest), /OLD_LOG_A/);
    assert.doesNotMatch(textOf(lastRequest), /SUMMARY_A|SUMMARY_B/);

    const forkAfterA = await continueFork(parent, afterA);
    assert.equal(state(forkAfterA.id).blocks.length, 1);
    assert.match(textOf(lastRequest), /SUMMARY_A/);
    assert.doesNotMatch(textOf(lastRequest), /OLD_LOG_A|SUMMARY_B|OLD_LOG_B/);
    assert.equal(state(id).blocks.length, 2, "the parent's state is untouched");

    // A reload keeps the fork's own state instead of restoring an older inherited checkpoint over it.
    const generation = await reloadedGeneration();
    await generation.beforeRequest(
        { messages: (await forkAfterA.context(context)).messages },
        { conversationId: forkAfterA.id, models: fakeApi("").models, snapshot: app.harness.snapshot.bind(app.harness) },
        context,
    );
    assert.equal(state(forkAfterA.id).blocks.length, 1);
    await (await forkAfterA.submit({ type: "input", content: [{ type: "text", text: "unfold" }] }, context)).wait(
        context,
    );
    const decompressed = (await forkAfterA.context(context)).messages.findLast(
        (m: any) => m.role === "toolResult" && m.toolName === "decompress",
    ) as any;
    assert.notEqual(decompressed.isError, true);
    assert.match(textOf([decompressed]), /OLD_LOG_A/, "an inherited block can be decompressed");
});

test("histories without checkpoints replay their compress calls", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    const parent = (await app.harness.conversation(id, context))!;
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const messages = (await parent.context(context)).messages.map((m: any) => {
        if (m.role !== "toolResult" || !m.details?.[CHECKPOINT_KEY]) return m;
        const { [CHECKPOINT_KEY]: _checkpoint, ...details } = m.details;
        return { ...m, details };
    });
    const generation = await reloadedGeneration();
    const output = await generation.beforeRequest({ messages }, fakeApi("900001"), context);
    assert.equal(state("900001").blocks.length, 1);
    assert.match(textOf(output.messages), /SUMMARY_A/);
    assert.doesNotMatch(textOf(output.messages), /OLD_LOG_A/);
});

test("compression from codemode survives forks, even when the script fails afterwards", { skip }, async () => {
    const { context, newSession, say } = h;
    for (const kind of ["nested", "nested-error"]) {
        const id = await newSession(app);
        const parent = (await app.harness.conversation(id, context))!;
        await say(app, id, "read A");
        await say(app, id, `${kind} fold A`);
        assert.equal(state(id).blocks.length, 1);
        const result = (await parent.context(context)).messages.findLast(
            (m: any) => m.role === "toolResult" && m.toolName === "codemode",
        ) as any;
        assert.ok(result.details?.[CHECKPOINT_KEY], "the codemode result carries the checkpoint");
        assert.equal(result.isError === true, kind === "nested-error");
        const fork = await continueFork(parent, await tail(parent));
        assert.equal(state(fork.id).blocks.length, 1);
        assert.match(textOf(lastRequest), /SUMMARY_A/);
        assert.doesNotMatch(textOf(lastRequest), /OLD_LOG_A/);
    }
});

test("branch entry IDs match billion-context-pi's own", { skip }, async () => {
    const messages = [
        { role: "user", content: "one", timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "one" }], timestamp: 2 },
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "hidden" },
                { type: "text", text: "two" },
            ],
            timestamp: 3,
        },
    ];
    // Use the deployed bundle, without the repository's development dependencies.
    const { createRuntime } = await import(pathToFileURL(join(dataDir, "extensions", BUNDLE, `billion-context-pi-${mod.BCP_VERSION}`, "dist", "index.js")).href);
    const ctx = {
        model: { contextWindow: 128000 },
        sessionManager: { getSessionId: () => "ids", getSessionFile: () => undefined, getBranch: () => [] },
    };
    const result = await createRuntime().stateFor(ctx, messages);
    assert.deepEqual(
        mod.branchEntries(messages).map((e: any) => e.id),
        result.entries.map((e: any) => e.id),
    );
});

test("settings: the state folder and extension name are configurable", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "settings-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { stateDir: "bcp", extensionName: "bcp-adapter" });
    const configured = await import(pathToFileURL(file).href);
    const extension = configured.default({ dataDir: folder, notice() {} });
    assert.equal(extension.name, "bcp-adapter");
    assert.equal(existsSync(join(folder, "bcp")), false, "loading the installer does not create or rewrite ACP state");
});

test("the gallery entry loads without a runtime and does not install during loading", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "missing-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, {}, false);
    const configured = await import(pathToFileURL(file).href);
    const extension = configured.default({ dataDir: folder, notice() {} });
    assert.equal(extension.tools.length, 5, "reviewed tool declarations are stable before installation");
    assert.equal(existsSync(join(folder, "billion-context-pi-pocket-runtime")), false);
    assert.equal(existsSync(join(folder, "billion-context-pi")), false);
});

test("legacy package paths cannot override the reviewed installer pin", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "legacy-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { billionContextPi: join(folder, "not-installed") });
    const configured = await import(pathToFileURL(file).href);
    const manifest = JSON.parse(readFileSync(join(folder, BUNDLE, "runtime-lock.json"), "utf8"));
    assert.equal(configured.BCP_VERSION, manifest.current);
    assert.equal(configured.default({ dataDir: folder, notice() {} }).tools.length, 5);
});

test("an entry update reloads its own relative helpers without changing the runtime pin", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "reload-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder);
    const first = await import(pathToFileURL(file).href);
    const helper = join(folder, BUNDLE, "bridge.ts");
    writeFileSync(helper, `${readFileSync(helper, "utf8")}\n// test a new, reviewed helper revision\n`);
    const updated = await import(`${pathToFileURL(file).href}?updated`);
    assert.equal(updated.BCP_VERSION, first.BCP_VERSION);
    assert.notEqual(updated.branchEntries, first.branchEntries, "helper code is content-versioned on reload");
});

test("decompression keeps both automatic and custom file output", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    await say(app, id, "read A");
    await say(app, id, "fold A");
    await say(app, id, "unfold-file");
    const cache = join(testHome, ".cache", "pi", "acp-decompress");
    const outputs = readdirSync(cache).filter((name) => name.startsWith("b1-"));
    assert.ok(outputs.length > 0, "default output goes to the normal cache directory");
    assert.ok(outputs.some((name) => readFileSync(join(cache, name), "utf8").includes("OLD_LOG_A")));
    await say(app, id, "unfold-custom");
    const messages = await (await app.harness.conversation(id, context)).context(context);
    const result = messages.messages.findLast((m: any) => m.role === "toolResult" && m.toolName === "decompress");
    assert.notEqual(result.isError, true);
    assert.match(readFileSync(join(testHome, "custom-decompression.txt"), "utf8"), /OLD_LOG_A/);
});

test("the old settings filename keeps its stored identity and state folder", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "legacy-settings-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { stateDir: "bcp", extensionName: "bcp-adapter" }, true, LEGACY_SETTINGS);
    mkdirSync(join(folder, "bcp"));
    const sentinel = join(folder, "bcp", "existing.jsonl.acp.json");
    const contents = '{"blocks":[{"blockId":"b1","summary":"existing compressed history"}]}';
    writeFileSync(sentinel, contents);
    const configured = await import(pathToFileURL(file).href);
    assert.equal(configured.default({ dataDir: folder, notice() {} }).name, "bcp-adapter");
    assert.equal(readFileSync(sentinel, "utf8"), contents, "loading does not rewrite existing state");
    assert.equal(existsSync(join(folder, SETTINGS)), false, "loading does not mutate settings");
});

test("the new settings file takes precedence over an invalid legacy file", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "new-settings-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { stateDir: "current-state", extensionName: "current-extension" });
    writeFileSync(join(folder, LEGACY_SETTINGS), "not valid JSON");
    const configured = await import(pathToFileURL(file).href);
    assert.equal(configured.default({ dataDir: folder, notice() {} }).name, "current-extension");
    assert.equal(existsSync(join(folder, "current-state")), false, "state is created on use, not while loading the installer");
});

test("an invalid new settings file cannot silently use legacy settings", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "invalid-settings-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { stateDir: "bcp", extensionName: "bcp-adapter" }, true, LEGACY_SETTINGS);
    writeFileSync(join(folder, SETTINGS), "[]");
    await assert.rejects(import(pathToFileURL(file).href), /Invalid billion-context-pi-pocket settings/);
});

test("renaming a loaded module and settings keeps compressed sessions, forks, and restart recovery", { skip }, async () => {
    const migrationData = join(h.root, "data-bcp-rename");
    const folder = join(migrationData, "extensions");
    const current = dropInFolder(folder, { stateDir: "bcp", extensionName: "bcp-adapter" }, true, LEGACY_SETTINGS);
    const legacyName = "billion-context-pi-pocket-adapter.ts";
    const legacy = join(folder, legacyName);
    renameSync(current, legacy);
    let migrating = await h.openApp(model, migrationData);
    const stored = (id: unknown) => join(migrationData, "bcp", `${id}.jsonl.acp.json`);
    try {
        await migrating.setExtensionEnabled(h.owner(migrating), legacyName, true);
        const id = await h.newSession(migrating);
        await h.say(migrating, id, "read A");
        await h.say(migrating, id, "fold A");
        const parent = (await migrating.harness.conversation(id, h.context))!;
        const forkPoint = await tail(parent);
        const before = readFileSync(stored(id), "utf8");
        assert.equal(JSON.parse(before).blocks.length, 1);
        await migrating.setExtensionEnabled(h.owner(migrating), legacyName, false);
        renameSync(legacy, current);
        renameSync(join(folder, LEGACY_SETTINGS), join(folder, SETTINGS));
        await migrating.setExtensionEnabled(h.owner(migrating), ADAPTER, true);
        assert.equal(readFileSync(stored(id), "utf8"), before, "the rename does not rewrite compression state");
        await h.say(migrating, id, "continue");
        assert.match(textOf(lastRequest), /SUMMARY_A/);
        assert.doesNotMatch(textOf(lastRequest), /OLD_LOG_A/);
        const fork = await continueFork(parent, forkPoint);
        assert.equal(JSON.parse(readFileSync(stored(fork.id), "utf8")).blocks.length, 1);
        assert.match(textOf(lastRequest), /SUMMARY_A/);
        await migrating.close();
        migrating = await h.openApp(model, migrationData);
        await h.say(migrating, id, "unfold");
        const restarted = (await migrating.harness.conversation(id, h.context))!;
        const result = (await restarted.context(h.context)).messages.findLast(
            (entry: any) => entry.role === "toolResult" && entry.toolName === "decompress",
        );
        assert.ok(result);
        assert.notEqual(result.isError, true);
        assert.match(textOf([result]), /OLD_LOG_A/);
        assert.equal(existsSync(legacy), false);
        assert.equal(existsSync(join(folder, LEGACY_SETTINGS)), false);
    } finally {
        await migrating.close();
    }
});

for (const verdict of ["allow", "block", "approve", "deny"]) {
    test(`decompress uses Pocket's guard hook: ${verdict}`, { skip, timeout: 20_000 }, async () => {
        const { context, newSession, say, owner, until } = h;
        const id = await newSession(app);
        await say(app, id, "read A");
        await say(app, id, "fold A");
        const destination = join(testHome, `guarded-${verdict}.txt`);
        writeFileSync(destination, "EXISTING_FILE_MUST_NOT_CHANGE_BEFORE_APPROVAL");
        const blocksBefore = blockContent(id);
        const calls: any[] = [];
        const judge = app.guard.judge;
        // Use the real Pocket guard hook and approval machinery with a deterministic verdict, not a downloaded ML model.
        app.guard.judge = async (name: string, args: any) => {
            if (name !== "write") return undefined;
            calls.push(args);
            return {
                subject: args.path,
                decision: { action: verdict === "approve" || verdict === "deny" ? "ask" : verdict, reason: `TEST_GUARD_${verdict}` },
            };
        };
        const requestsBefore = requestCount;
        try {
            const { submissionId } = await app.commands.submit(id, owner(app), {
                text: `decompress-json:${JSON.stringify({ blockId: "b1", toFile: destination })}`,
                requestId: crypto.randomUUID(),
            });
            if (verdict === "approve" || verdict === "deny") {
                await until(() => app.approvals.forConversation(id).length === 1, "nested write approval");
                const [card] = app.approvals.forConversation(id);
                assert.equal(card.tool, "write", "Pocket asks about its own write tool");
                assert.equal(readFileSync(destination, "utf8"), "EXISTING_FILE_MUST_NOT_CHANGE_BEFORE_APPROVAL");
                await app.answerApproval(card.id, verdict === "approve", owner(app));
            }
            await (await app.harness.submission(submissionId, context)).wait(context);
            assert.equal(calls.length, 1, "the only destination write passes through Pocket's guard");
            assert.equal(calls[0].path, destination);
            assert.match(calls[0].content, /OLD_LOG_A/);
            const history = (await (await app.harness.conversation(id, context)).context(context)).messages;
            const result = history.findLast((message: any) => message.role === "toolResult" && message.toolName === "decompress");
            assert.ok(result);
            const saved = verdict === "allow" || verdict === "approve";
            assert.equal(result.isError === true, !saved);
            if (saved) {
                assert.match(readFileSync(destination, "utf8"), /OLD_LOG_A/);
                assert.match(textOf([result]), new RegExp(`written to ${destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
            } else {
                assert.equal(readFileSync(destination, "utf8"), "EXISTING_FILE_MUST_NOT_CHANGE_BEFORE_APPROVAL");
                assert.match(textOf([result]), /Could not save decompressed text/);
                assert.match(textOf([result]), /TEST_GUARD_/);
                assert.doesNotMatch(textOf([result]), /written to/);
            }
            assert.equal(blockContent(id), blocksBefore, "file output does not unfold the saved compressed block");
            const modelCalls = history.flatMap((message: any) => message.role === "assistant" ? message.content : [])
                .filter((part: any) => part.type === "toolCall");
            assert.equal(modelCalls.filter((call: any) => call.name === "decompress").length, 1);
            assert.equal(modelCalls.filter((call: any) => call.name === "write").length, 0, "the model never makes a follow-up write call");
            assert.equal(requestCount - requestsBefore, 2, "one tool request and one final answer, with no extra model turn");
        } finally {
            for (const card of app.approvals.forConversation(id)) await app.answerApproval(card.id, false, owner(app));
            app.guard.judge = judge;
        }
    });
}

test("decompress exports in one codemode script have independent guarded writes", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const destinations = [join(testHome, "batch-decompression-a.txt"), join(testHome, "batch-decompression-b.txt")];
    const judge = app.guard.judge;
    const judged: string[] = [];
    app.guard.judge = async (name: string, args: any) => {
        if (name === "write") judged.push(args.path);
        return undefined;
    };
    try {
        const before = requestCount;
        await say(app, id, `decompress-batch:${JSON.stringify(destinations.map((toFile) => ({ blockId: "b1", toFile })))}`);
        const history = (await (await app.harness.conversation(id, context)).context(context)).messages;
        const result = history.findLast((message: any) => message.role === "toolResult" && message.toolName === "codemode");
        assert.notEqual(result.isError, true, textOf([result]));
        assert.deepEqual(judged.sort(), destinations.slice().sort());
        for (const path of destinations) assert.match(readFileSync(path, "utf8"), /OLD_LOG_A/);
        assert.equal(requestCount - before, 2, "batching does not add a model turn");
    } finally { app.guard.judge = judge; }
});

test("decompress file capability is honestly blocked in plan mode without changing compression", { skip }, async () => {
    const { context, newSession, say, owner } = h;
    const id = await newSession(app);
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const destination = join(testHome, "planned-decompression.txt");
    const before = blockContent(id);
    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "unfold");
    await say(app, id, `decompress-json:${JSON.stringify({ blockId: "b1", toFile: destination })}`);
    const history = (await (await app.harness.conversation(id, context)).context(context)).messages;
    const results = history.filter((message: any) => message.role === "toolResult" && message.toolName === "decompress");
    assert.equal(results.length, 2);
    assert.ok(results.every((result: any) => result.isError === true));
    assert.match(textOf(results), /Plan mode is on: The decompress tool can change things/);
    assert.equal(existsSync(destination), false);
    assert.equal(blockContent(id), before);
    await app.commands.approvePlan(id, owner(app));
    await say(app, id, `decompress-json:${JSON.stringify({ blockId: "b1", toFile: destination })}`);
    assert.match(readFileSync(destination, "utf8"), /OLD_LOG_A/);
});

test("decompress propagates a real Pocket write failure without a direct-write fallback", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const destination = join(testHome, "decompression-is-a-directory");
    mkdirSync(destination);
    await say(app, id, `decompress-json:${JSON.stringify({ blockId: "b1", toFile: destination })}`);
    const history = (await (await app.harness.conversation(id, context)).context(context)).messages;
    const result = history.findLast((message: any) => message.role === "toolResult" && message.toolName === "decompress");
    assert.equal(result.isError, true);
    assert.match(textOf([result]), /Could not save decompressed text/);
    assert.equal(statSync(destination).isDirectory(), true);
});

test("decompress a single message to a file through the same wrapper", { skip }, async () => {
    const { context, newSession, say } = h;
    const id = await newSession(app);
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const ref = state(id).blocks[0].effectiveMessageIds.find((value: string) => value.startsWith("live-"));
    assert.ok(ref);
    const destination = join(testHome, "single-message-decompression.txt");
    await say(app, id, `decompress-json:${JSON.stringify({ blockId: ref, toFile: destination })}`);
    const history = (await (await app.harness.conversation(id, context)).context(context)).messages;
    const result = history.findLast((message: any) => message.role === "toolResult" && message.toolName === "decompress");
    assert.notEqual(result.isError, true);
    assert.match(textOf([result]), /Message .* written to/);
    assert.ok(readFileSync(destination, "utf8").length > 0);
});

test("decompress retains upstream empty-toFile and inline behavior without calling write", { skip }, async () => {
    const { newSession, say } = h;
    const id = await newSession(app);
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const judge = app.guard.judge;
    let writes = 0;
    app.guard.judge = async (name: string) => { if (name === "write") writes += 1; return undefined; };
    try {
        await say(app, id, `decompress-json:${JSON.stringify({ blockId: "b1", toFile: "" })}`);
        await say(app, id, "unfold");
        assert.equal(writes, 0, "normal automatic files and inline output remain upstream operations");
    } finally { app.guard.judge = judge; }
});

function scratchTool(execute?: (path: string) => unknown) {
    const paths: string[] = [];
    return {
        paths,
        tool: {
            name: "decompress", description: "test", parameters: {},
            async execute(_id: unknown, args: any) {
                paths.push(args.toFile);
                assert.equal(statSync(dirname(args.toFile)).mode & 0o777, 0o700, "restored history is in a private scratch directory");
                if (execute !== undefined) return await execute(args.toFile);
                writeFileSync(args.toFile, "EXACT_RESTORED_CONTENT");
                return { content: [{ type: "text", text: `Block b1 written to ${args.toFile}.` }], details: { marker: "retained" } };
            },
        },
    };
}

for (const outcome of ["success", "blocked", "throws", "upstream-error", "missing-content"]) {
    test(`decompress scratch cleanup: ${outcome}`, { skip }, async () => {
        const destination = join(testHome, `scratch-${outcome}-$&.txt`);
        writeFileSync(destination, "ORIGINAL");
        const fixture = scratchTool(outcome === "upstream-error" ? () => { throw new Error("UPSTREAM_FAILED"); }
            : outcome === "missing-content" ? () => ({ content: [{ type: "text", text: "Block b1 not found." }] }) : undefined);
        let writes = 0;
        const api = {
            callId: "decompress-test",
            async executeTool(name: string, args: any, _context: unknown, options: any) {
                writes += 1;
                assert.equal(name, "write");
                assert.equal(args.path, destination);
                assert.equal(args.content, "EXACT_RESTORED_CONTENT");
                assert.match(options.key, /^decompressed-file-[a-f0-9]{64}$/);
                assert.equal(readFileSync(destination, "utf8"), "ORIGINAL", "BCP never receives or writes the requested destination");
                if (outcome === "throws") throw new Error("NESTED_WRITE_ABORTED");
                if (outcome === "blocked") return { isError: true, diagnostics: [{ message: "GUARD_DENIED" }] };
                writeFileSync(destination, args.content); // stand-in for the independently tested Pocket write tool
                return { isError: false };
            },
        };
        const run = () => mod.decompressToFile(fixture.tool, { blockId: "b1", toFile: destination, full: true }, api, h.context, { ui: { notify() {} } });
        if (outcome === "throws" || outcome === "upstream-error") {
            await assert.rejects(run(), outcome === "throws" ? /NESTED_WRITE_ABORTED/ : /UPSTREAM_FAILED/);
        } else {
            const result = await run();
            if (outcome === "success") {
                assert.equal(result.content[0].text, `Block b1 written to ${destination}.`);
                assert.deepEqual(result.details, { marker: "retained" });
            } else if (outcome === "blocked") {
                assert.equal(result.isError, true);
                assert.match(result.content[0].text, /GUARD_DENIED/);
                assert.doesNotMatch(result.content[0].text, /written to/);
            } else assert.equal(result.content[0].text, "Block b1 not found.");
        }
        assert.equal(writes, outcome === "upstream-error" || outcome === "missing-content" ? 0 : 1);
        assert.equal(fixture.paths.length, 1);
        assert.equal(existsSync(dirname(fixture.paths[0])), false, "scratch text and directory are removed on every exit");
        if (outcome !== "success") assert.equal(readFileSync(destination, "utf8"), "ORIGINAL");
    });
}

test("decompress fails closed without nested tool support or for an upstream-disallowed destination", { skip }, async () => {
    const fixture = scratchTool();
    const destination = join(testHome, "unsupported-decompression.txt");
    const result = await mod.decompressToFile(fixture.tool, { blockId: "b1", toFile: destination }, { callId: "no-nested-api" }, h.context, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no guarded nested tool execution/);
    assert.equal(fixture.paths.length, 0);
    assert.equal(existsSync(destination), false);
    const forbidden = await mod.decompressToFile(fixture.tool, { blockId: "b1", toFile: "/etc/bcp-must-not-be-written" }, { executeTool() { assert.fail("must not call write"); } }, h.context, {});
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /toFile path must be under/);
    const link = join(testHome, "decompression-symlink");
    symlinkSync("/etc/hostname", link);
    const symlink = await mod.decompressToFile(fixture.tool, { blockId: "b1", toFile: link }, { executeTool() { assert.fail("must not follow an outside symlink"); } }, h.context, {});
    assert.equal(symlink.isError, true);
    assert.equal(fixture.paths.length, 0);
});

test("decompress works through a disposable HTTP Pocket server with normal approval", { skip, timeout: 20_000 }, async () => {
    const { context, newSession, owner, until } = h;
    const { createHandler } = await import(join(pocketDir!, "src/server/http.ts"));
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.2", port: 0 }, restart() {} }));
    await new Promise<void>((done) => server.listen(0, "127.0.0.2", done));
    const origin = `http://127.0.0.2:${(server.address() as { port: number }).port}`;
    const post = async (path: string, body: unknown) => {
        const response = await fetch(origin + path, {
            method: "POST",
            headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const result = await response.json();
        assert.equal(response.status, 200, JSON.stringify(result));
        return result as any;
    };
    const id = await newSession(app);
    const submit = (text: string) => post(`/api/c/${id}/submit`, { text, requestId: crypto.randomUUID() });
    const judge = app.guard.judge;
    try {
        for (const text of ["read A", "fold A"]) {
            const { submissionId } = await submit(text);
            await (await app.harness.submission(submissionId, context)).wait(context);
        }
        const destination = join(testHome, "http-decompression.txt");
        writeFileSync(destination, "WAIT_FOR_POCKET_APPROVAL");
        app.guard.judge = async (name: string, args: any) => name === "write" ? {
            subject: args.path,
            decision: { action: "ask", reason: "HTTP_DECOMPRESS_APPROVAL" },
        } : undefined;
        const requestsBefore = requestCount;
        const { submissionId } = await submit(`decompress-json:${JSON.stringify({ blockId: "b1", toFile: destination })}`);
        await until(() => app.approvals.forConversation(id).length === 1, "HTTP nested write approval");
        const [card] = app.approvals.forConversation(id);
        assert.equal(card.tool, "write");
        assert.equal(readFileSync(destination, "utf8"), "WAIT_FOR_POCKET_APPROVAL");
        await post(`/api/approvals/${encodeURIComponent(card.id)}`, { allow: true });
        await (await app.harness.submission(submissionId, context)).wait(context);
        assert.match(readFileSync(destination, "utf8"), /OLD_LOG_A/);
        assert.equal(requestCount - requestsBefore, 2, "HTTP submission needs no extra model turn");
        const history = (await (await app.harness.conversation(id, context)).context(context)).messages;
        const result = history.findLast((message: any) => message.role === "toolResult" && message.toolName === "decompress");
        assert.notEqual(result.isError, true);
        assert.match(textOf([result]), /written to/);
    } finally {
        for (const card of app.approvals.forConversation(id)) await app.answerApproval(card.id, false, owner(app));
        app.guard.judge = judge;
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
    }
});

test("a terminal Pi session's compression comes along when it continues in Pocket", { skip }, async (t) => {
    const { context, newSession, say, owner, work } = h;
    if (typeof app.piSessions?.registerCompanion !== "function") return t.skip("This Pocket version does not expose optional Pi-session companions");
    // Compression made here, then written out as Pi in the terminal keeps it: Pi's entry ids, and the state beside the file.
    const id = await newSession(app);
    const source = (await app.harness.conversation(id, context))!;
    await say(app, id, "read A");
    await say(app, id, "fold A");
    const messages = (await source.context(context)).messages.flatMap((m: any) => {
        if (m.role === "system") return [];
        if (m.role !== "toolResult" || !m.details?.[CHECKPOINT_KEY]) return [m];
        const { [CHECKPOINT_KEY]: _checkpoint, ...details } = m.details;
        return [{ ...m, details }];
    });
    const live = mod.branchEntries((await source.context(context)).messages);
    const all = (await source.context(context)).messages;
    const piId = new Map<string, string>();
    let next = 0;
    all.forEach((m: any, i: number) => {
        if (m.role !== "system") piId.set(live[i].id, `pi${String(next++).padStart(6, "0")}`);
    });
    const toPi = (raw: string) => {
        const hash = raw.indexOf("#");
        const base = piId.get(hash === -1 ? raw : raw.slice(0, hash));
        assert.ok(base, `every compressed message is in the Pi file: ${raw}`);
        return base + (hash === -1 ? "" : raw.slice(hash));
    };
    const pocketState = state(id);
    const piState = {
        ...pocketState,
        blocks: pocketState.blocks.map((b: any) => ({
            ...b,
            effectiveMessageIds: b.effectiveMessageIds.map(toPi),
            directMessageIds: b.directMessageIds.map(toPi),
        })),
        messageRefs: {
            byRaw: Object.fromEntries(Object.entries(pocketState.messageRefs.byRaw).filter(([raw]) => piId.has(raw.split("#")[0])).map(([raw, ref]) => [toPi(raw), ref])),
            byRef: Object.fromEntries(Object.entries(pocketState.messageRefs.byRef).filter(([, raw]) => piId.has(String(raw).split("#")[0])).map(([ref, raw]) => [ref, toPi(String(raw))])),
        },
        lastPassIds: [],
    };
    assert.equal(piState.blocks.length, 1);
    const folder = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "--bcp-import--");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "terminal.jsonl");
    const lines = [{ type: "session", version: 3, id: "terminal-session", timestamp: new Date(1).toISOString(), cwd: work }];
    messages.forEach((message: any, i: number) => {
        lines.push({
            type: "message",
            id: `pi${String(i).padStart(6, "0")}`,
            parentId: i === 0 ? null : `pi${String(i - 1).padStart(6, "0")}`,
            timestamp: new Date(1000 + i).toISOString(),
            message,
        } as any);
    });
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    writeFileSync(`${file}.acp.json`, JSON.stringify(piState));

    assert.deepEqual((await app.piSessions.preview(owner(app), file)).companions, ["Compression state"]);
    const continued = await app.commands.continuePiSession(owner(app), file);
    assert.deepEqual(continued.notes, ["Imported compression from Pi: 1 blocks."]);
    assert.equal(state(continued.id).blocks.length, 1);
    await say(app, continued.id, "continue");
    assert.match(textOf(lastRequest), /SUMMARY_A/);
    assert.doesNotMatch(textOf(lastRequest), /OLD_LOG_A/);
});
