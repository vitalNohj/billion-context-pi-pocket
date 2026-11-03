/** Exercise the shipped client handlers using Pocket's actual Preact/htm and public component contract. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import setup from "../billion-context-pi-pocket/index.js";

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
function view({ enabled = true, installed = true, programState } = {}) {
    const calls = [];
    const state = {
        defaultOffBehavior: "restore-history",
        runtime: { installed, managed: installed, state: programState ?? (installed ? "installed" : "absent"), version: "0.1.83",
            availableVersion: "0.1.83", downloadBytes: 100, diskBytes: 200, host: "registry.npmjs.org" },
        session: { id: 3, enabled, offBehavior: "restore-history", usesDefaultOffBehavior: true },
    };
    let component;
    let cursor = 0;
    const pocket = {
        html, Switch() {}, Loader() {},
        conversationId: () => 3,
        useState(initial) {
            const slot = cursor++;
            const value = slot === 2 ? state : slot === 3 ? false : typeof initial === "function" ? initial() : initial;
            return [value, () => {}];
        },
        useRef: (current) => ({ current }),
        useEffect() {},
        sheet: (spec) => { component = spec.component; },
        menu() {},
        api: async (path, body) => { calls.push({ path, body }); return {}; },
    };
    setup(pocket);
    return { calls, tree: component(), pocket };
}

test("Pocket Switch's void callback sends a boolean, not its click event", { skip }, async (t) => {
    for (const enabled of [true, false]) {
        await t.test(enabled ? "On to Off" : "Off to On", async () => {
            const result = view({ enabled });
            const control = find(result.tree, (node) => node.type === result.pocket.Switch);
            assert.ok(control);
            await control.props.onChange({ type: "click", isTrusted: true });
            assert.deepEqual(result.calls, [{ path: "session/3", body: { enabled: !enabled } }]);
        });
    }
});
test("an unavailable program permits Off but not On", { skip }, () => {
    for (const enabled of [true, false]) {
        const result = view({ enabled, installed: false });
        const control = find(result.tree, (node) => node.type === result.pocket.Switch);
        assert.equal(control.props.disabled, !enabled);
    }
});
test("the Install click sends only an explicit empty owner action", { skip }, async () => {
    const result = view({ installed: false });
    assert.deepEqual(result.calls, []);
    const install = find(result.tree, (node) => node.type === "button" && node.props.children === "Install");
    assert.ok(install);
    await install.props.onClick();
    assert.deepEqual(result.calls, [{ path: "runtime/install", body: {} }]);
});
test("an uninstalled program offers Install without a redundant Uninstall action", { skip }, () => {
    const result = view({ installed: false, programState: "uninstalled" });
    assert.ok(find(result.tree, (node) => node.type === "button" && node.props.children === "Install"));
    assert.equal(find(result.tree, (node) => node.type === "button" && node.props.children === "Uninstall"), undefined);
});
test("Use extension default sends null, not a frozen mode", { skip }, async () => {
    const result = view();
    const control = find(result.tree, (node) => node.type === "select");
    assert.ok(control);
    await control.props.onChange({ currentTarget: { value: "default" } });
    assert.deepEqual(result.calls, [{ path: "session/3", body: { offBehavior: null } }]);
});
