/** Exercise the shipped client markup and handlers using Pocket's actual Preact/htm and public component contract. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import setup, { model, view } from "../billion-context-pi-pocket/index.js";

const checkout = process.env.PI_POCKET_CHECKOUT;
const skip = checkout && existsSync(join(checkout, "package.json")) ? false : "set PI_POCKET_CHECKOUT to a Pi Pocket checkout";
if (process.env.CI && skip !== false) throw new Error(`Browser contract tests must not skip in CI: ${skip}`);
let h;
let html;
if (skip === false) {
    const require = createRequire(join(checkout, "package.json"));
    h = require("preact").h;
    html = require("htm").bind(h);
}
function find(node, predicate) {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = find(child, predicate);
            if (found) return found;
        }
    } else if (node && typeof node === "object") {
        if (predicate(node)) return node;
        return find(node.props?.children, predicate);
    }
}
const text = (node) => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : node == null || node === false ? "" : String(node);
const button = (tree, label) => find(tree, (node) => node.type === "button" && text(node) === label);

function status({ state = "installed", installed = state === "installed" || state === "legacy", managed = state === "installed", enabled = true,
    source = "desktop", updates = {}, session = true, stats } = {}) {
    return {
        defaultOffBehavior: "restore-history",
        runtime: { installed, managed, state, version: "0.1.83", availableVersion: "0.1.83", updateAvailable: false,
            downloadBytes: 100, diskBytes: 200, host: "registry.npmjs.org", busy: false, ...(state === "error" ? { error: "broken cache" } : {}) },
        extension: { version: "0.1.83", source, ...(source === "manual" ? {} : { commit: "a".repeat(40) }) },
        updates: { available: false, ...updates },
        ...(session ? { session: { id: 3, enabled, offBehavior: "restore-history", usesDefaultOffBehavior: true } } : {}),
        ...(stats ? { stats } : {}),
    };
}
function draw(data, ui = {}) {
    const calls = [];
    const pocket = { Switch() {}, Loader() {} };
    const on = {
        act: (path) => calls.push(path), check: () => calls.push("updates/check"), askRemove: () => calls.push("ask"),
        cancelRemove: () => calls.push("cancel"), uninstall: () => calls.push("runtime/uninstall"),
        session: (body) => calls.push(body), toggleMore() {},
    };
    return { calls, pocket, tree: view(html, pocket, data, { busy: "", loading: false, error: "", confirmRemove: false, licenses: null, ...ui }, on) };
}

test("the same three actions as the desktop app: install, uninstall, check for updates", { skip }, () => {
    const absent = draw(status({ state: "absent", installed: false, managed: false }));
    assert.ok(button(absent.tree, "Install"));
    assert.equal(button(absent.tree, "Uninstall"), undefined);
    assert.ok(button(absent.tree, "Check for updates"));
    const active = draw(status());
    assert.ok(button(active.tree, "Reinstall"));
    assert.ok(button(active.tree, "Uninstall"));
    button(active.tree, "Reinstall").props.onClick();
    button(active.tree, "Check for updates").props.onClick();
    assert.deepEqual(active.calls, ["runtime/repair", "updates/check"]);
});
test("an uninstalled program offers Install without a redundant Uninstall action", { skip }, () => {
    const result = draw(status({ state: "uninstalled", installed: false, managed: false }));
    assert.ok(button(result.tree, "Install"));
    assert.equal(button(result.tree, "Uninstall"), undefined);
    button(result.tree, "Install").props.onClick();
    assert.deepEqual(result.calls, ["runtime/install"]);
});
test("uninstall asks first and keeps history", { skip }, () => {
    const first = draw(status());
    button(first.tree, "Uninstall").props.onClick();
    assert.deepEqual(first.calls, ["ask"]);
    const confirm = draw(status(), { confirmRemove: true });
    assert.match(text(confirm.tree), /compression history, and settings stay/);
    button(confirm.tree, "Uninstall").props.onClick();
    assert.deepEqual(confirm.calls, ["runtime/uninstall"]);
});
test("a desktop-managed extension update asks the desktop app; others point to their own path", { skip }, () => {
    const desktop = draw(status({ updates: { available: true, latest: { commit: "b".repeat(40), version: "0.1.84" } } }));
    button(desktop.tree, "Update").props.onClick();
    assert.deepEqual(desktop.calls, ["updates/request"]);
    assert.match(text(desktop.tree), /BCP 0\.1\.84 is available/);
    // A new commit with the same BCP version is an extension update, not a BCP one.
    const same = draw(status({ updates: { available: true, latest: { commit: "b".repeat(40), version: "0.1.83" } } }));
    assert.match(text(same.tree), /An extension update is available/);
    assert.doesNotMatch(text(same.tree), /BCP 0\.1\.83 is available/);
    const gallery = draw(status({ source: "gallery", updates: { available: true, latest: { commit: "b".repeat(40) } } }));
    assert.equal(button(gallery.tree, "Update"), undefined);
    assert.match(text(gallery.tree), /after gallery review/);
    assert.equal(model(status({ updates: { requested: 5 } })).update.tone, "busy");
    assert.match(model(status({ updates: { handled: { at: 1, requested: 5, error: "offline" } } })).update.text, /Update failed: offline/);
});
test("a background status refresh keeps shown buttons usable, so a click is not dropped", { skip }, () => {
    const { tree } = draw(status(), { loading: true });
    for (const label of ["Reinstall", "Uninstall", "Check for updates"]) assert.equal(button(tree, label).props.disabled, false, label);
});
test("an error offers Repair and shows why", { skip }, () => {
    const result = draw(status({ state: "error", installed: false, managed: false }));
    assert.ok(button(result.tree, "Repair"));
    assert.ok(button(result.tree, "Uninstall"));
    assert.match(text(result.tree), /broken cache/);
});
test("Pocket Switch's void callback sends a boolean, not its click event", { skip }, async (t) => {
    for (const enabled of [true, false]) {
        await t.test(enabled ? "On to Off" : "Off to On", () => {
            const result = draw(status({ enabled }));
            const control = find(result.tree, (node) => node.type === result.pocket.Switch);
            control.props.onChange({ type: "click", isTrusted: true });
            assert.deepEqual(result.calls, [{ enabled: !enabled }]);
        });
    }
});
test("an unavailable program permits Off but not On", { skip }, () => {
    for (const enabled of [true, false]) {
        const result = draw(status({ enabled, state: "absent", installed: false, managed: false }));
        const control = find(result.tree, (node) => node.type === result.pocket.Switch);
        assert.equal(control.props.disabled, !enabled);
    }
});
test("Default sends null, not a frozen mode, and the current choice sends nothing", { skip }, () => {
    const data = status();
    data.session.usesDefaultOffBehavior = false;
    const result = draw(data);
    const radio = (value) => find(result.tree, (node) => node.type === "input" && node.props.value === value);
    assert.equal(radio("restore-history").props.checked, true);
    assert.equal(radio("restore-history").props.type, "radio", "native radios give arrow-key navigation");
    for (const value of ["default", "restore-history", "keep-summaries"]) radio(value).props.onChange();
    assert.deepEqual(result.calls, [{ offBehavior: null }, { offBehavior: "keep-summaries" }]);
});
test("a slow update check leaves the program and chat controls usable", { skip }, () => {
    const result = draw(status(), { checking: true });
    assert.equal(button(result.tree, "Checking…").props.disabled, true);
    assert.equal(button(result.tree, "Reinstall").props.disabled, false);
    assert.equal(find(result.tree, (node) => node.type === result.pocket.Switch).props.disabled, false);
});
test("a failed program action offers Repair, even when status says absent", { skip }, () => {
    const result = draw(status({ state: "absent", installed: false, managed: false }), { runtimeFailed: true });
    button(result.tree, "Repair").props.onClick();
    assert.deepEqual(result.calls, ["runtime/repair"]);
});
test("chat counts show only with saved summaries", { skip }, () => {
    assert.doesNotMatch(text(draw(status()).tree), /Summaries/);
    const shown = text(draw(status({ stats: { blocks: 3, originalTokens: 100000, summaryTokens: 5000 } })).tree);
    assert.match(shown, /Summaries3/);
    assert.match(shown, /95%/);
});
test("the sheet renders with Pocket's Preact, and loads its stylesheet", { skip }, () => {
    const styles = [];
    let component;
    setup({ html, style: (path) => styles.push(path), sheet: (spec) => { component = spec.component; }, menu() {}, ...hooksFor() });
    assert.deepEqual(styles, ["style.css"]);
    assert.ok(component);
    assert.ok(readFileSync(new URL("../billion-context-pi-pocket/style.css", import.meta.url), "utf8").includes(".bcp-card"));
    assert.ok(find(draw(status()).tree, (node) => node.props?.class === "bcp-card"));
});
function hooksFor() {
    return { useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}], useRef: (current) => ({ current }), useEffect() {} };
}
