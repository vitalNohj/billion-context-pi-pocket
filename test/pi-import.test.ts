import { testHome } from "./env.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Import the pure bridge and exact development npm runtime without a Pocket checkout or an installed program.
// These host-only exports and the terminal session manager are unused by the import helpers in fork-host mode.
process.env.PI_ACP_FORK_HOST = "1";
process.env.ACP_AUTO_UPDATE = "0";
const stubs = new Map([
    ["@earendil-works/pi-durable", `export const AgentDoc = null, CompactionTask = null, defineExtension = null,
        defineTool = null, GenerationTask = null, hook = null, section = null, ToolTask = null;`],
    ["@earendil-works/pi-coding-agent", "export class SessionManager {}"],
]);
const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
        const source = stubs.get(specifier);
        return source === undefined
            ? nextResolve(specifier, context)
            : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    },
});
let mod: typeof import("../billion-context-pi-pocket/bridge.ts");
let deriveChildState: (state: any) => any;
try {
    mod = await import(pathToFileURL(resolve(import.meta.dirname, "../billion-context-pi-pocket/bridge.ts")).href);
    ({ deriveChildState } = await import("billion-context-pi"));
} finally {
    loader.deregister();
}
const { branchEntries, translatePiState } = mod;
const importPiState = (companion: string, entries: Parameters<typeof mod.importPiState>[1], target: string) =>
    mod.importPiState(companion, entries, target, deriveChildState);

function fixture(count = 10) {
    const ids = Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(8, "0"));
    const refs = ids.map((_, i) => `m${String(i + 1).padStart(5, "0")}`);
    const entries = ids.map((from, i) => ({
        from,
        id: i + 1,
        message: { role: "user", content: [{ type: "text", text: `Message ${i + 1}` }], timestamp: i },
    }));
    const block = {
        blockId: "b1", effectiveMessageIds: [...ids], directMessageIds: [...ids],
        directBlockIds: [], startRef: refs[0], endRef: refs.at(-1), summary: "Keep this summary.",
        active: true, generation: 1, compressCallId: "compress-1", originalTokens: 1000, compressedTokens: 10,
    };
    const state = {
        schemaVersion: 1,
        producer: { name: "billion-context-pi", version: "0.1.83" },
        blocks: [block],
        messageRefs: {
            byRaw: Object.fromEntries(ids.map((id, i) => [id, refs[i]])),
            byRef: Object.fromEntries(ids.map((id, i) => [refs[i], id])),
        },
        lastPassIds: [...ids],
        tokenSnapshot: Object.fromEntries(refs.map((ref) => [ref, 100])),
        hiddenOrphanRefs: [], liveRefOrigins: [], rules: [], nextRuleId: 1, nextBlockId: 2, nextRunId: 2,
    };
    return { ids, refs, entries, state };
}

function files(state: any) {
    const dir = mkdtempSync(join(testHome, "pi-import-"));
    const companion = join(dir, "terminal.jsonl.acp.json");
    const target = join(dir, "conversation.jsonl");
    writeFileSync(companion, JSON.stringify(state));
    return { dir, companion, target };
}

test("saved passes require the complete current context, including composite IDs outside an active block", () => {
    const { state, entries } = fixture(2);
    const messages = entries.map((entry) => entry.message);
    const translated = translatePiState(state, entries)!.state;
    const ids = branchEntries(messages).map((entry) => entry.id);
    translated.blocks[0].effectiveMessageIds = [`${ids[0]}#tool-call#part`];
    translated.lastPassIds = [`${ids[0]}#tool-call#part`, ids[1]];
    const before = structuredClone(translated);
    assert.equal(mod.stateFitsContext(translated, messages), true);
    assert.equal(mod.stateFitsContext(translated, [...messages, { role: "user", content: "another turn", timestamp: 3 }]), true);
    assert.equal(mod.stateFitsContext(translated, messages.slice(0, 1)), false,
        "an identical surviving block ID cannot hide missing messages from its saved pass");
    assert.deepEqual(translated, before, "coverage checks do not rewrite saved compression");
    const legacy = { ...translated, lastPassIds: undefined };
    assert.equal(mod.stateFitsContext(legacy, messages.slice(0, 1)), true, "legacy states keep the existing block-coverage fallback");
    assert.equal(mod.stateFitsContext(legacy, messages.slice(1)), false);
    assert.equal(mod.stateFitsContext({ ...translated, lastPassIds: "invalid" }, messages), false);
    assert.equal(mod.stateFitsContext(undefined, messages), true);
});

test("inactive historical blocks do not abandon valid compression or its reference mapping", () => {
    const { state, entries } = fixture(2);
    const messages = entries.map((entry) => entry.message);
    const saved = translatePiState(state, entries)!.state;
    const ids = branchEntries(messages).map((entry) => entry.id);
    saved.blocks[0].effectiveMessageIds = [ids[0]];
    saved.blocks.push({ ...saved.blocks[0], blockId: "b2", active: false,
        effectiveMessageIds: ["live-deadbeefdeadbeef"], directMessageIds: ["live-deadbeefdeadbeef"] });
    const before = structuredClone(saved);
    assert.equal(mod.stateFitsContext(saved, messages), true, "the kernel retains inactive historical blocks");
    assert.equal(mod.stateFitsContext({ ...saved, lastPassIds: undefined }, messages), true,
        "legacy states without a saved pass still keep covered active summaries");
    assert.equal(mod.stateFitsContext(saved, messages.slice(0, 1)), false,
        "ignoring inactive blocks must not weaken complete saved-pass coverage");
    assert.equal(mod.stateFitsContext({ ...saved, blocks: saved.blocks.map((block) => ({ ...block, active: true })) }, messages), false,
        "an uncovered active block still requires a new tracking context");
    assert.deepEqual(saved, before, "adoption never rewrites blocks or their reference mapping");
});

test("all Pi IDs map without changing refs, other block fields, or the source", () => {
    const { state, entries } = fixture();
    const before = structuredClone(state);
    const live = branchEntries(entries.map((entry) => entry.message)).map((entry) => entry.id);
    const result = translatePiState(state, entries)!;
    assert.equal(result.mapped, 10);
    assert.equal(result.total, 10);
    assert.deepEqual(result.state.blocks, [{ ...state.blocks[0], effectiveMessageIds: live, directMessageIds: live }]);
    assert.deepEqual(result.state.lastPassIds, live);
    assert.deepEqual(result.state.messageRefs, {
        byRaw: Object.fromEntries(live.map((id, i) => [id, state.messageRefs.byRaw[entries[i].from]])),
        byRef: Object.fromEntries(Object.keys(state.messageRefs.byRef).map((ref, i) => [ref, live[i]])),
    });
    assert.deepEqual(result.state.tokenSnapshot, state.tokenSnapshot);
    assert.deepEqual(state, before);
});

test("missing IDs leave the rest of a block and remove both ref mappings and empty blocks", () => {
    const { state, entries, ids, refs } = fixture();
    state.blocks.push({ ...state.blocks[0], blockId: "b2", effectiveMessageIds: [ids[0]], directMessageIds: [ids[0]] });
    const before = structuredClone(state);
    const kept = entries.slice(1);
    const live = branchEntries(kept.map((entry) => entry.message)).map((entry) => entry.id);
    const result = translatePiState(state, kept)!;
    assert.equal(result.total, 10, "IDs shared by blocks count only once");
    assert.equal(result.mapped, 9);
    assert.deepEqual(result.state.blocks, [{ ...state.blocks[0], effectiveMessageIds: live, directMessageIds: live }]);
    assert.equal(Object.keys(result.state.messageRefs.byRaw).length, 9);
    assert.equal(Object.keys(result.state.messageRefs.byRef).length, 9);
    assert.equal(ids[0] in result.state.messageRefs.byRaw, false);
    assert.equal(refs[0] in result.state.messageRefs.byRef, false);
    assert.deepEqual(result.state.lastPassIds, live);
    assert.deepEqual(result.state.tokenSnapshot, state.tokenSnapshot, "ref-keyed snapshots stay unchanged");
    assert.deepEqual(state, before);
});

test("composite IDs translate only their base in every field and coverage counts distinct full IDs", () => {
    const { state, entries, ids } = fixture(2);
    const fullIds = [ids[0], `${ids[0]}#toolu_X`, `${ids[0]}#toolu_Y#suffix`, `${ids[1]}#toolu_Z`];
    const refs = fullIds.map((_, i) => `m${String(i + 1).padStart(5, "0")}`);
    state.blocks[0] = { ...state.blocks[0], effectiveMessageIds: fullIds, directMessageIds: fullIds, endRef: refs.at(-1) };
    state.blocks.push({ ...state.blocks[0], blockId: "b2", effectiveMessageIds: [fullIds[1]], directMessageIds: [fullIds[1]] });
    state.messageRefs = {
        byRaw: Object.fromEntries(fullIds.map((id, i) => [id, refs[i]])),
        byRef: Object.fromEntries(fullIds.map((id, i) => [refs[i], id])),
    };
    state.lastPassIds = [...fullIds];
    state.tokenSnapshot = Object.fromEntries(refs.map((ref) => [ref, 100]));
    const before = structuredClone(state);
    const live = branchEntries(entries.map((entry) => entry.message));
    const expected = [live[0].id, `${live[0].id}#toolu_X`, `${live[0].id}#toolu_Y#suffix`, `${live[1].id}#toolu_Z`];
    const result = translatePiState(state, entries)!;
    assert.equal(result.mapped, 4);
    assert.equal(result.total, 4, "full IDs stay distinct, even when bases repeat or blocks share IDs");
    assert.deepEqual(result.state.blocks, [
        { ...state.blocks[0], effectiveMessageIds: expected, directMessageIds: expected },
        { ...state.blocks[1], effectiveMessageIds: [expected[1]], directMessageIds: [expected[1]] },
    ]);
    assert.deepEqual(result.state.messageRefs, {
        byRaw: Object.fromEntries(expected.map((id, i) => [id, refs[i]])),
        byRef: Object.fromEntries(expected.map((id, i) => [refs[i], id])),
    });
    assert.deepEqual(result.state.lastPassIds, expected);
    assert.deepEqual(result.state.tokenSnapshot, state.tokenSnapshot);
    assert.deepEqual(state, before);
    const { companion, target } = files(state);
    assert.deepEqual(importPiState(companion, entries, target), { blocks: 2, mapped: 4, total: 4 });
    const imported = JSON.parse(readFileSync(`${target}.acp.json`, "utf8"));
    assert.deepEqual(imported.blocks, result.state.blocks);
    assert.deepEqual(imported.messageRefs, result.state.messageRefs);

    const missing = translatePiState(state, entries.slice(0, 1))!;
    assert.equal(missing.mapped, 3);
    assert.equal(missing.total, 4);
    assert.deepEqual(missing.state.blocks[0].effectiveMessageIds, expected.slice(0, 3));
    assert.deepEqual(missing.state.blocks[0].directMessageIds, expected.slice(0, 3));
    assert.deepEqual(missing.state.lastPassIds, expected.slice(0, 3));
    assert.equal(fullIds[3] in missing.state.messageRefs.byRaw, false);
    assert.equal(refs[3] in missing.state.messageRefs.byRef, false);
});

test("live ranks include Pocket-made messages and only the first item from each Pi entry maps", () => {
    const { state } = fixture(1);
    const message = { role: "user", content: "duplicate" };
    const entries = [
        { id: 1, message },
        { from: "00000001", id: 2, message },
        { from: "00000001", id: 3, message },
    ];
    const live = branchEntries(entries.map((entry) => entry.message));
    const result = translatePiState(state, entries)!;
    assert.deepEqual(result.state.blocks[0].effectiveMessageIds, [live[1].id]);
    assert.equal(result.state.messageRefs.byRaw[live[1].id], "m00001");
    assert.equal(result.total, 1);
    assert.equal(result.mapped, 1);
});

test("translation declines absent, empty, or incomplete compression state", () => {
    const { state, entries } = fixture();
    for (const invalid of [undefined, null, {}, { blocks: {} }, { ...state, blocks: [] },
        { ...state, messageRefs: undefined }, { ...state, messageRefs: { byRaw: {} } },
        { ...state, messageRefs: { byRef: {} } }]) {
        assert.equal(translatePiState(invalid, entries), undefined);
    }
});

test("a matching import writes derived state atomically and retains the terminal sidecar", () => {
    const { state, entries } = fixture();
    const { dir, companion, target } = files(state);
    const original = readFileSync(companion, "utf8");
    const before = Date.now();
    assert.deepEqual(importPiState(companion, entries, target), { blocks: 1, mapped: 10, total: 10 });
    const imported = JSON.parse(readFileSync(`${target}.acp.json`, "utf8"));
    const translated = translatePiState(state, entries)!.state;
    assert.deepEqual(imported.blocks, translated.blocks);
    assert.deepEqual(imported.messageRefs, translated.messageRefs);
    assert.deepEqual(imported.tokenSnapshot, state.tokenSnapshot);
    assert.equal(imported.schemaVersion, state.schemaVersion);
    assert.deepEqual(imported.producer, state.producer);
    assert.equal(imported.derivedFrom.piSession, companion.slice(0, -".acp.json".length));
    assert.ok(imported.derivedFrom.derivedAt >= before && imported.derivedFrom.derivedAt <= Date.now());
    assert.deepEqual(imported.liveRefOrigins, []);
    assert.equal(statSync(`${target}.acp.json`).mode & 0o777, 0o600);
    assert.equal(readFileSync(companion, "utf8"), original);
    assert.deepEqual(readdirSync(dir).sort(), ["conversation.jsonl.acp.json", "terminal.jsonl.acp.json"]);
});

test("exactly 90 percent mapping is accepted", () => {
    const { state, entries } = fixture();
    const { companion, target } = files(state);
    assert.deepEqual(importPiState(companion, entries.slice(1), target), { blocks: 1, mapped: 9, total: 10 });
});

test("below 90 percent mapping writes nothing", () => {
    const { state, entries } = fixture();
    const { dir, companion, target } = files(state);
    assert.equal(importPiState(companion, entries.slice(2), target), undefined);
    assert.equal(existsSync(`${target}.acp.json`), false);
    assert.deepEqual(readdirSync(dir), ["terminal.jsonl.acp.json"]);
    const previous = '{"blocks":[],"untouched":true}\n';
    writeFileSync(`${target}.acp.json`, previous);
    assert.equal(importPiState(companion, entries.slice(2), target), undefined);
    assert.equal(readFileSync(`${target}.acp.json`, "utf8"), previous);
});

test("a state with blocks but no effective IDs writes nothing", () => {
    const { state } = fixture();
    state.blocks[0] = { ...state.blocks[0], effectiveMessageIds: [], directMessageIds: [] };
    state.messageRefs = { byRaw: {}, byRef: {} };
    state.lastPassIds = [];
    const { dir, companion, target } = files(state);
    assert.equal(translatePiState(state, [])!.total, 0);
    assert.equal(importPiState(companion, [], target), undefined);
    assert.equal(existsSync(`${target}.acp.json`), false);
    assert.deepEqual(readdirSync(dir), ["terminal.jsonl.acp.json"]);
    const previous = '{"blocks":[],"untouched":true}\n';
    writeFileSync(`${target}.acp.json`, previous);
    assert.equal(importPiState(companion, [], target), undefined);
    assert.equal(readFileSync(`${target}.acp.json`, "utf8"), previous);
});

test("an existing target with blocks is not overwritten", () => {
    const { state, entries } = fixture();
    const { dir, companion, target } = files(state);
    const previous = '{"blocks":[{"blockId":"existing"}],"untouched":true}\n';
    writeFileSync(`${target}.acp.json`, previous);
    assert.equal(importPiState(companion, entries, target), undefined);
    assert.equal(readFileSync(`${target}.acp.json`, "utf8"), previous);
    assert.deepEqual(readdirSync(dir).sort(), ["conversation.jsonl.acp.json", "terminal.jsonl.acp.json"]);
});

test("missing, invalid JSON, or empty companion state writes nothing", () => {
    const { state, entries } = fixture();
    const { dir, companion, target } = files(state);
    assert.equal(importPiState(join(dir, "missing.acp.json"), entries, target), undefined);
    for (const value of ["{invalid", "null", "{}", '{"blocks":[]}', JSON.stringify({ blocks: state.blocks })]) {
        writeFileSync(companion, value);
        assert.equal(importPiState(companion, entries, target), undefined);
        assert.equal(existsSync(`${target}.acp.json`), false);
    }
    assert.deepEqual(readdirSync(dir), ["terminal.jsonl.acp.json"]);
});

test("import errors other than a missing file or JSON syntax propagate", () => {
    const { state, entries } = fixture();
    const { dir, target } = files(state);
    assert.throws(() => importPiState(dir, entries, target), { code: "EISDIR" });
    assert.equal(existsSync(`${target}.acp.json`), false);
});
