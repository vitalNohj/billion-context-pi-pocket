import { createHash } from 'node:crypto';

// Must match the pinned runtime's messageIdentity/stableLiveId. Never change these IDs on rollout.
const REF_SOURCE = '(?:<acp\\s[^>]*>m\\d{5}</acp>|\\[m\\d{1,5}\\])';
const LEADING_REF = new RegExp(`^${REF_SOURCE}\\s?\\n?`);
const TRAILING_REF = new RegExp(`\\n*${REF_SOURCE}\\s*$`);
const stripRef = text => text.replace(LEADING_REF, '').replace(TRAILING_REF, '');
export function normalize(value, message = false) {
    if (Array.isArray(value)) return value.flatMap(item => {
        if (item?.type === 'text' && typeof item.text === 'string' && item.text !== stripRef(item.text) && stripRef(item.text) === '') return [];
        return [normalize(item)];
    });
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (message && key === 'timestamp') continue;
        const item = value[key];
        if (message && key === 'content' && typeof item === 'string') out[key] = [{ text: stripRef(item), type: 'text' }];
        else if (key === 'text' && typeof item === 'string' && value.type === 'text') out[key] = stripRef(item);
        else out[key] = normalize(item);
    }
    return out;
}
const hash = value => createHash('sha256').update(value).digest('hex');
export function branchEntries(messages) {
    const ranks = new Map();
    return messages.map(message => {
        const identity = JSON.stringify(normalize(message, true));
        const rank = ranks.get(identity) ?? 0;
        ranks.set(identity, rank + 1);
        return { type: 'message', id: `live-${hash(`${identity}\0${rank}`).slice(0, 16)}`, parentId: null, timestamp: String(message.timestamp ?? 0), message };
    });
}

/** Exactly Pocket's legacyInline presentation transform, not general tool-name normalization. */
export function artifactPresentation(message) {
    if (message.role === 'toolResult' && message.toolName === 'artifact_inline') return { ...message, toolName: 'artifact' };
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(part => part.type === 'toolCall' && part.name === 'artifact_inline'
        ? { ...part, name: 'artifact', arguments: { ...part.arguments, inline: true } } : part) };
}

/** Timestamp and duplicate count are separate from encounter-order ranks. No message text is persisted. */
export function contextInstances(messages) {
    const calls = new Set(messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'toolCall' && part.name === 'artifact_inline' && typeof part.id === 'string' && part.id.length > 0 && !Object.hasOwn(part.arguments ?? {}, 'inline')).map(part => part.id) : []));
    const paired = new Set(messages.filter(message => message.role === 'toolResult' && message.toolName === 'artifact_inline' && calls.has(message.toolCallId)).map(message => message.toolCallId));
    return messages.filter(message => message.role !== 'system').map(message => {
        const canonical = message.role === 'toolResult' && paired.has(message.toolCallId) ? artifactPresentation(message)
            : message.role === 'assistant' && Array.isArray(message.content) ? { ...message, content: message.content.map(part => part.type === 'toolCall' && part.name === 'artifact_inline' && paired.has(part.id)
                ? { ...part, name: 'artifact', arguments: { ...part.arguments, inline: true } } : part) } : message;
        return [hash(JSON.stringify(normalize(canonical, true))), String(message.timestamp ?? 0)];
    });
}

function savedRawIds(state) {
    const blocks = Array.isArray(state?.blocks) ? state.blocks : [];
    const values = [
        ...(Array.isArray(state?.lastPassIds) ? state.lastPassIds : []),
        ...blocks.flatMap(block => [...(block.directMessageIds ?? []), ...(block.effectiveMessageIds ?? [])]),
        ...Object.keys(state?.messageRefs?.byRaw ?? {}), ...Object.values(state?.messageRefs?.byRef ?? {}),
        ...(state?.liveRefOrigins ?? []).map(origin => origin.rawId),
        ...(state?.absorbed ?? []).flatMap(record => [record.callMessageId, record.resultMessageId]),
        ...(state?.imageShrinks ?? []).map(record => record.rawMessageId),
    ];
    return new Set(values.filter(value => typeof value === 'string').map(value => value.split('#', 1)[0]));
}

/** Reconstruct only the lossless, paired legacy form (no pre-existing inline argument).
 * Resolve each pair against saved result identities, not an all-or-nothing history rewrite:
 * one assistant message may contain both a renamed legacy call and an already-modern call.
 * The complete saved-pass / active-ID fit must still prove the resulting assistant identities.
 * With no state, the all-legacy candidate is usable only when a retained digest proves it.
 */
export function artifactIdentityCandidate(messages, state) {
    const calls = new Set(messages.flatMap(message => message.role === 'assistant' && Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'toolCall' && part.name === 'artifact' && typeof part.id === 'string' && part.id.length > 0 && part.arguments?.inline === true).map(part => part.id) : []));
    const paired = new Set(messages.filter(message => message.role === 'toolResult' && message.toolName === 'artifact' && calls.has(message.toolCallId)).map(message => message.toolCallId));
    const reconstruct = pairs => messages.map(message => {
        if (message.role === 'toolResult' && message.toolName === 'artifact' && pairs.has(message.toolCallId)) return { ...message, toolName: 'artifact_inline' };
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
        return { ...message, content: message.content.map(part => {
            if (part.type !== 'toolCall' || part.name !== 'artifact' || part.arguments?.inline !== true || !pairs.has(part.id)) return part;
            const { inline: _inline, ...args } = part.arguments;
            return { ...part, name: 'artifact_inline', arguments: args };
        }) };
    });
    const current = branchEntries(messages);
    let originals = reconstruct(paired);
    if (state !== undefined) {
        const saved = savedRawIds(state);
        const inverse = branchEntries(originals);
        const provenPairs = new Set();
        messages.forEach((message, i) => {
            if (message.role !== 'toolResult' || !paired.has(message.toolCallId)) return;
            const legacy = saved.has(inverse[i].id);
            const modern = saved.has(current[i].id);
            if (legacy && modern) throw new Error('Ambiguous artifact pair identities; explicit repair required');
            if (legacy) provenPairs.add(message.toolCallId);
        });
        originals = reconstruct(provenPairs);
    }
    // Prove every other field, including timestamps, IDs, result bodies and details, is unchanged.
    if (JSON.stringify(normalize(originals.map(artifactPresentation))) !== JSON.stringify(normalize(messages.map(artifactPresentation)))) throw new Error('Unproven artifact presentation migration');
    const old = branchEntries(originals);
    const aliases = new Map(old.flatMap((entry, i) => entry.id === current[i].id ? [] : [[entry.id, current[i].id]]));
    if (new Set(aliases.values()).size !== aliases.size) throw new Error('Ambiguous artifact identity migration');
    const origins = new Map(old.flatMap((entry, i) => entry.id === current[i].id ? [] : [[entry.id, {
        before: JSON.stringify(normalize(originals[i], true)), after: JSON.stringify(normalize(messages[i], true)),
    }]]));
    return { messages: originals, entries: old, aliases, origins };
}

/** Complete typed translation: no dropping unmapped history, ref labels, blocks or composite tails. */
export function translateStateIds(state, aliases, origins = new Map()) {
    if (state === undefined || aliases.size === 0) return state;
    const next = structuredClone(state);
    const id = value => {
        if (typeof value !== 'string') throw new Error('Invalid state message identity');
        const split = value.indexOf('#');
        const base = split < 0 ? value : value.slice(0, split);
        return (aliases.get(base) ?? base) + (split < 0 ? '' : value.slice(split));
    };
    for (const block of next.blocks) for (const field of ['directMessageIds', 'effectiveMessageIds']) {
        if (block[field] !== undefined) block[field] = block[field].map(id);
    }
    if (next.lastPassIds !== undefined) next.lastPassIds = next.lastPassIds.map(id);
    if (next.messageRefs?.byRaw) {
        const pairs = Object.entries(next.messageRefs.byRaw).map(([raw, ref]) => [id(raw), ref]);
        if (new Set(pairs.map(([raw]) => raw)).size !== pairs.length) throw new Error('Ambiguous migrated message refs');
        next.messageRefs.byRaw = Object.fromEntries(pairs);
    }
    if (next.messageRefs?.byRef) next.messageRefs.byRef = Object.fromEntries(Object.entries(next.messageRefs.byRef).map(([ref, raw]) => [ref, id(raw)]));
    if (next.absorbed !== undefined) next.absorbed = next.absorbed.map(record => ({ ...record,
        callMessageId: id(record.callMessageId), resultMessageId: id(record.resultMessageId),
    }));
    if (next.imageShrinks !== undefined) next.imageShrinks = next.imageShrinks.map(record => ({ ...record, rawMessageId: id(record.rawMessageId) }));
    if (next.liveRefOrigins !== undefined) next.liveRefOrigins = next.liveRefOrigins.map(origin => {
        const base = typeof origin.rawId === 'string' ? origin.rawId.split('#', 1)[0] : undefined;
        const proven = origins.get(base);
        if (aliases.has(base) && (!proven || origin.identity !== proven.before)) throw new Error('Unproven migrated live ref origin');
        return { ...origin,
            ...(origin.rawId === undefined ? {} : { rawId: id(origin.rawId) }),
            ...(proven ? { identity: proven.after } : {}),
        };
    });
    return next;
}

/** Candidate old orders must still verify the original digest; saved-pass order is not trusted alone. */
export function legacyOrders(messages, state) {
    const current = branchEntries(messages.filter(message => message.role !== 'system'));
    const old = artifactIdentityCandidate(messages.filter(message => message.role !== 'system'), state).entries;
    const candidates = [current, old];
    if (Array.isArray(state?.lastPassIds)) {
        const ids = [...new Set(state.lastPassIds.map(id => id.split('#', 1)[0]))];
        const saved = new Set(ids);
        for (const entries of [current, old]) {
            const byId = new Map(entries.map(entry => [entry.id, entry]));
            if (ids.every(id => byId.has(id))) candidates.push([...ids.map(id => byId.get(id)), ...entries.filter(entry => !saved.has(entry.id))]);
        }
    }
    return candidates.map(entries => entries.map(entry => `${entry.id}:${entry.timestamp}`));
}
