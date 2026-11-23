import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { branchEntries, contextInstances } from '../billion-context-pi-pocket/identity.mjs';
import { freezeJson, longContext } from './long-context.mjs';

// Uncached implementation from before memoization. Keep it independent of the production helpers.
const REF_SOURCE = '(?:<acp\\s[^>]*>m\\d{5}</acp>|\\[m\\d{1,5}\\])';
const LEADING_REF = new RegExp(`^${REF_SOURCE}\\s?\\n?`);
const TRAILING_REF = new RegExp(`\\n*${REF_SOURCE}\\s*$`);
const stripRef = text => text.replace(LEADING_REF, '').replace(TRAILING_REF, '');
const hash = value => createHash('sha256').update(value).digest('hex');
function uncachedNormalize(value, message = false) {
    if (Array.isArray(value)) return value.flatMap(item => {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text !== stripRef(item.text) && stripRef(item.text) === '') return [];
        return [uncachedNormalize(item)];
    });
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (message && key === 'timestamp') continue;
        const item = value[key];
        if (message && key === 'content' && typeof item === 'string') out[key] = [{ text: stripRef(item), type: 'text' }];
        else if (key === 'text' && typeof item === 'string' && value.type === 'text') out[key] = stripRef(item);
        else out[key] = uncachedNormalize(item);
    }
    return out;
}
function uncachedEntries(messages) {
    const ranks = new Map();
    return messages.map(message => {
        const identity = JSON.stringify(uncachedNormalize(message, true));
        const rank = ranks.get(identity) ?? 0;
        ranks.set(identity, rank + 1);
        return { type: 'message', id: `live-${hash(`${identity}\0${rank}`).slice(0, 16)}`, parentId: null, timestamp: String(message.timestamp ?? 0), message };
    });
}
function uncachedInstances(messages) {
    const calls = new Set(messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'toolCall' && part.name === 'artifact_inline' && typeof part.id === 'string' && part.id.length > 0 && !Object.hasOwn(part.arguments ?? {}, 'inline')).map(part => part.id) : []));
    const paired = new Set(messages.filter(message => message.role === 'toolResult' && message.toolName === 'artifact_inline' && calls.has(message.toolCallId)).map(message => message.toolCallId));
    return messages.filter(message => message.role !== 'system').map(message => {
        const canonical = message.role === 'toolResult' && message.toolName === 'artifact_inline' && paired.has(message.toolCallId) ? { ...message, toolName: 'artifact' }
            : message.role === 'assistant' && Array.isArray(message.content) ? { ...message, content: message.content.map(part => part.type === 'toolCall' && part.name === 'artifact_inline' && paired.has(part.id)
                ? { ...part, name: 'artifact', arguments: { ...part.arguments, inline: true } } : part) } : message;
        return [hash(JSON.stringify(uncachedNormalize(canonical, true))), String(message.timestamp ?? 0)];
    });
}

function check(messages) {
    const entries = branchEntries(messages);
    const instances = contextInstances(messages);
    assert.deepEqual(entries, uncachedEntries(messages));
    assert.deepEqual(instances, uncachedInstances(messages));
    return { entries, instances };
}

test('cold, appended and reordered long contexts keep the exact uncached IDs and proof hashes', () => {
    const history = longContext();
    const system = freezeJson({ role: 'system', content: '[m00001]\nRetry the check.' });
    const original = [system, ...history];
    const cold = check(original);
    // Reuse one object at two ranks, in addition to distinct objects with duplicate identities.
    const grown = [...original, history[0], freezeJson({ role: 'user', content: 'Continue.' })];
    const warm = check(grown);
    assert.deepEqual(warm.entries.slice(0, original.length), cold.entries);
    assert.deepEqual(warm.instances.slice(0, history.length), cold.instances);
    assert.notEqual(warm.entries[original.length].id, cold.entries[1].id);
    assert.deepEqual(warm.instances[history.length], cold.instances[0]);
    assert.equal(warm.entries[original.length].message, history[0]);
    check(grown.slice(1).reverse());
    check(original);
});

test('canonical artifact identity follows which results are paired in this request', () => {
    const call = id => ({ type: 'toolCall', id, name: 'artifact_inline', arguments: { content: `Body ${id}` } });
    const assistant = freezeJson({ role: 'assistant', content: [call('a'), call('b')], timestamp: 1 });
    const result = id => freezeJson({ role: 'toolResult', toolName: 'artifact_inline', toolCallId: id, content: [{ type: 'text', text: 'Saved' }], timestamp: 2 });
    const a = result('a'), b = result('b');
    const unpaired = check([assistant]);
    const onlyA = check([assistant, a]);
    const onlyB = check([assistant, b]);
    const both = check([assistant, a, b]);
    assert.equal(new Set([unpaired, onlyA, onlyB, both].map(value => value.instances[0][0])).size, 4);
    assert.ok([onlyA, onlyB, both].every(value => value.entries[0].id === unpaired.entries[0].id));
    check([assistant, a]);
    check([assistant]);
});

test('mutable messages and shallow freezes cannot hide same-length nested edits or a new timestamp', () => {
    const assistant = Object.freeze({ role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'artifact_inline', arguments: { content: 'Old' } }], timestamp: 1 });
    const result = { role: 'toolResult', toolName: 'artifact_inline', toolCallId: 'a', content: [{ type: 'text', text: 'Red' }], details: { color: 'red' }, timestamp: 2 };
    const messages = [assistant, result];
    const before = check(messages);
    assistant.content[0].arguments.content = 'New';
    result.content[0].text = 'Tan';
    result.details.color = 'tan';
    const edited = check(messages);
    for (let i = 0; i < messages.length; i++) {
        assert.notEqual(edited.entries[i].id, before.entries[i].id);
        assert.notEqual(edited.instances[i][0], before.instances[i][0]);
    }
    result.timestamp++;
    const retimed = check(messages);
    assert.equal(retimed.entries[1].id, edited.entries[1].id);
    assert.deepEqual(retimed.instances[1], [edited.instances[1][0], '3']);
});

test('a frozen getter is not immutable JSON', () => {
    let text = 'red';
    const message = Object.freeze({ role: 'user', get content() { return text; }, timestamp: 1 });
    const before = check([message]);
    text = 'tan';
    const after = check([message]);
    assert.notEqual(after.entries[0].id, before.entries[0].id);
    assert.notEqual(after.instances[0][0], before.instances[0][0]);
});

test('the fallback still presents assistant content that is not an enumerable field', () => {
    const content = freezeJson([{ type: 'text', text: 'Visible in the proof.' }]);
    const hidden = Object.freeze(Object.defineProperty({ role: 'assistant' }, 'content', { value: content }));
    const ordinary = freezeJson({ role: 'assistant', content });
    const before = check([hidden]);
    const after = check([ordinary]);
    assert.notEqual(before.entries[0].id, after.entries[0].id);
    assert.deepEqual(before.instances, after.instances);
});
