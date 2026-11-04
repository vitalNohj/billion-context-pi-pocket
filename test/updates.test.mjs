import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UpdateState, installedSource, REPOSITORY } from "../billion-context-pi-pocket/updates.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
function folder(t) {
    const root = mkdtempSync(join(tmpdir(), "bcp-updates-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}
function github(commit, version, urls = []) {
    return async (url) => {
        urls.push(url);
        if (url === `https://api.github.com/repos/${REPOSITORY}/commits/main`) return new Response(commit);
        if (url === `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/billion-context-pi-pocket/runtime-lock.json`) return Response.json({ current: version });
        return new Response(null, { status: 404 });
    };
}

test("installedSource prefers gallery provenance, then the desktop marker, else manual", (t) => {
    const root = folder(t);
    const helper = join(root, "billion-context-pi-pocket");
    mkdirSync(helper);
    const base = { entryDir: root, helperDir: helper, name: "billion-context-pi-pocket", version: "0.1.83" };
    assert.deepEqual(installedSource(base), { version: "0.1.83", source: "manual" });
    writeFileSync(join(helper, ".pi-pocket-gui.json"), JSON.stringify({ commit: A }));
    assert.deepEqual(installedSource(base), { version: "0.1.83", source: "desktop", commit: A });
    writeFileSync(join(root, "billion-context-pi-pocket.gallery.json"), JSON.stringify({ entry: { source: { commit: B } } }));
    assert.deepEqual(installedSource(base), { version: "0.1.83", source: "gallery", commit: B });
});

test("a check saves the newest commit and its pinned version; no request before a check", async (t) => {
    const urls = [];
    const state = new UpdateState({ root: folder(t), fetcher: github(B, "0.1.84", urls) });
    assert.deepEqual(state.view({ version: "0.1.83", commit: A }), { available: false });
    assert.equal(urls.length, 0);
    await state.check();
    const shown = state.view({ version: "0.1.83", commit: A });
    assert.equal(shown.available, true);
    assert.deepEqual(shown.latest, { commit: B, version: "0.1.84" });
    assert.equal(typeof shown.checkedAt, "number");
    assert.equal(state.view({ version: "0.1.84", commit: B }).available, false);
    // Hand-copied files have no commit: only a newer version counts.
    assert.equal(state.view({ version: "0.1.84" }).available, false);
    assert.equal(state.view({ version: "0.1.83" }).available, true);
});

test("a failed check keeps the last result and records the error", async (t) => {
    const root = folder(t);
    await new UpdateState({ root, fetcher: github(B, "0.1.84") }).check();
    const failing = new UpdateState({ root, fetcher: async () => new Response(null, { status: 429 }) });
    await assert.rejects(failing.check(), /limiting requests/);
    const shown = failing.view({ version: "0.1.83", commit: A });
    assert.equal(shown.latest.commit, B);
    assert.match(shown.error, /limiting/);
    const noLock = new UpdateState({ root, fetcher: async (url) => url.includes("/commits/") ? new Response("c".repeat(40)) : new Response(null, { status: 404 }) });
    await assert.rejects(noLock.check(), /HTTP 404/);
    assert.equal(noLock.view({ version: "0.1.83" }).latest.commit, B, "an incomplete check keeps the last verified result");
    await new UpdateState({ root, fetcher: github(B, "0.1.84") }).check();
    assert.equal(failing.view({ version: "0.1.83", commit: A }).error, undefined);
});

test("an update request is handled once; a stale report changes nothing", async (t) => {
    const state = new UpdateState({ root: folder(t), fetcher: github(B, "0.1.84") });
    const first = await state.request();
    const second = await state.request();
    assert.ok(second > first);
    assert.equal(state.view({ version: "0.1.83" }).requested, second);
    assert.equal(await state.handled(first, "stale"), false);
    assert.equal(state.view({ version: "0.1.83" }).requested, second);
    assert.equal(await state.handled(second, "offline"), true);
    const shown = state.view({ version: "0.1.83" });
    assert.equal(shown.requested, undefined);
    assert.equal(shown.handled.error, "offline");
});

test("concurrent checks, requests, and reports never lose each other's writes", async (t) => {
    let release;
    const gate = new Promise((done) => { release = done; });
    const slow = async (url) => { await gate; return github(B, "0.1.84")(url); };
    const state = new UpdateState({ root: folder(t), fetcher: slow });
    const checking = state.check();
    const requested = await state.request();
    release();
    await checking;
    const shown = state.view({ version: "0.1.83", commit: A });
    assert.equal(shown.requested, requested, "a check finishing later keeps the request");
    assert.equal(shown.latest.commit, B);
    await Promise.all([state.handled(requested), state.check(), state.check()]);
    const after = state.view({ version: "0.1.83", commit: A });
    assert.equal(after.requested, undefined, "a later check never restores a handled request");
    assert.equal(after.handled.requested, requested);
});

test("one caller that stops waiting does not cancel a shared check; a hung check times out", async (t) => {
    let release;
    const gate = new Promise((done) => { release = done; });
    const state = new UpdateState({ root: folder(t), fetcher: async (url) => { await gate; return github(B, "0.1.84")(url); } });
    const stop = new AbortController();
    const first = state.check(stop.signal);
    const second = state.check();
    stop.abort();
    await assert.rejects(first);
    release();
    await second;
    assert.equal(state.view({ version: "0.1.83", commit: A }).latest.commit, B);
    const hung = new UpdateState({ root: folder(t), timeout: 50, fetcher: (_url, { signal }) => new Promise((_done, fail) => signal.addEventListener("abort", () => fail(signal.reason))) });
    await assert.rejects(hung.check(), /did not answer in time/);
});

test("a reloaded copy shares the queue and the running check; an aborted caller starts nothing", async (t) => {
    const root = folder(t);
    let release;
    let lookups = 0;
    const gate = new Promise((done) => { release = done; });
    const fetcher = async (url) => { if (url.includes("/commits/")) lookups++; await gate; return github(B, "0.1.84")(url); };
    const old = new UpdateState({ root, fetcher });
    const replacement = new UpdateState({ root, fetcher });
    const checking = old.check();
    const joined = replacement.check();
    const requested = await replacement.request();
    release();
    await Promise.all([checking, joined]);
    assert.equal(lookups, 1);
    assert.equal(replacement.view({ version: "0.1.83", commit: A }).requested, requested);
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(replacement.check(stop.signal));
    assert.equal(lookups, 1);
});
