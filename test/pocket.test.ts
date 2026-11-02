/**
 * The adapter loaded the way Pi Pocket loads it: a drop-in in a test app's data folder, turned on, with a scripted
 * model (nothing reaches a provider). Needs a Pi Pocket checkout: `PI_POCKET_CHECKOUT=/path/to/pi-pocket npm test`.
 */
import { testHome } from "./env.ts";
import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const repo = resolve(import.meta.dirname, "..");
const ADAPTER = "billion-context-pi-pocket.ts";
const BUNDLE = "billion-context-pi-pocket";
const SETTINGS = "billion-context-pi-pocket.json";
const LEGACY_SETTINGS = "billion-context-pi-pocket-adapter.json";
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
const CHECKPOINT_KEY = "pocketBcpCheckpoint";

/** A drop-in folder with the adapter, its settings, and Pi Pocket's packages, as Pi Pocket makes it. */
function dropInFolder(folder: string, settings: Record<string, string> = {}, includeBundle = true, settingsFile = SETTINGS): string {
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(repo, ADAPTER), join(folder, ADAPTER));
    if (includeBundle) cpSync(join(repo, BUNDLE), join(folder, BUNDLE), { recursive: true });
    writeFileSync(join(folder, settingsFile), JSON.stringify(settings));
    return join(folder, ADAPTER);
}

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
        lastRequest = request.messages;
        const { role, text } = lastText(request);
        const call = (name: string, args: any) =>
            fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
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
    mod = await import(pathToFileURL(dropin).href);
    after(async () => {
        await app.close();
        cleanUp();
    });
}

const stateFile = (id: unknown) => join(dataDir, "billion-context-pi", `${id}.jsonl.acp.json`);
const state = (id: unknown) => JSON.parse(readFileSync(stateFile(id), "utf8"));
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
        extension.tools.every((t: any) => t.annotations?.readOnlyHint === true),
        "its tools only change what the model sees: marked read-only",
    );
});

test("compression keeps working in plan mode, where Pi Pocket lets read-only tools run", { skip }, async () => {
    const { context, newSession, say, owner, modelTexts } = h;
    if (!readFileSync(join(pocketDir!, "src/server/host.ts"), "utf8").includes("readOnlyTool(")) {
        return; // A Pi Pocket from before read-only tools in plan mode blocks compress there.
    }
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
        system.some((m: any) => /compress/.test(m.sections?.billion_context ?? "")),
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
    const output = await generation.beforeRequest({ messages }, fakeApi("no-checkpoints"), context);
    assert.equal(state("no-checkpoints").blocks.length, 1);
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
    assert.ok(existsSync(join(folder, "bcp")));
});

test("a missing bundle says to copy the helper folder, without a separate pi install", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "missing-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, {}, false);
    await assert.rejects(import(pathToFileURL(file).href), /Copy the billion-context-pi-pocket\/ folder/);
});

test("legacy package paths cannot override the pinned bundle", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "legacy-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { billionContextPi: join(folder, "not-installed") });
    const configured = await import(pathToFileURL(file).href);
    const manifest = JSON.parse(readFileSync(join(folder, BUNDLE, "bundle.json"), "utf8"));
    assert.equal(configured.BCP_VERSION, manifest.version);
    assert.equal(configured.default({ dataDir: folder, notice() {} }).tools.length, 5);
});

test("a version update reloads the entry and its relative child imports", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "reload-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder);
    const first = await import(pathToFileURL(file).href);
    assert.equal(first.BCP_VERSION, mod.BCP_VERSION);
    const nextVersion = "999.0.0";
    const runtime = join(folder, BUNDLE, `billion-context-pi-${nextVersion}`);
    mkdirSync(join(runtime, "dist"), { recursive: true });
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "billion-context-pi", version: nextVersion, type: "module" }));
    writeFileSync(join(runtime, "dist", "child.js"), 'export const marker = "NEW_BUNDLED_CHILD_LOADED";');
    writeFileSync(join(runtime, "dist", "index.js"), 'import { marker } from "./child.js"; throw new Error(marker);');
    writeFileSync(join(folder, BUNDLE, "bundle.json"), JSON.stringify({ package: "billion-context-pi", version: nextVersion }));
    await assert.rejects(import(`${pathToFileURL(file).href}?updated`), /NEW_BUNDLED_CHILD_LOADED/);
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
    assert.ok(existsSync(join(folder, "current-state")));
});

test("an invalid new settings file cannot silently use legacy settings", { skip }, async () => {
    const folder = mkdtempSync(join(testHome, "invalid-settings-"));
    symlinkSync(join(pocketDir!, "node_modules"), join(folder, "node_modules"), "dir");
    const file = dropInFolder(folder, { stateDir: "bcp", extensionName: "bcp-adapter" }, true, LEGACY_SETTINGS);
    writeFileSync(join(folder, SETTINGS), "[]");
    await assert.rejects(import(pathToFileURL(file).href), /billion-context-pi-pocket\.json must hold a JSON object/);
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
