import { constants, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const contextFile = join(import.meta.dirname, 'context.mjs');
const { boundedRead, directory, sameMarker } = await import(`${pathToFileURL(contextFile).href}?sha256=${createHash('sha256').update(readFileSync(contextFile)).digest('hex')}`);

const MAX_STATE = 256 * 1024 * 1024;
export const sidecar = (root, id, epoch) => join(root, `${id}${epoch ? `.context-${epoch}` : ''}.jsonl.acp.json`);
async function stateAt(root, id, epoch) {
    if (!await directory(root, false)) return undefined;
    try { return JSON.parse(await boundedRead(sidecar(root, id, epoch), MAX_STATE, 'compression-state')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
const totals = state => ({ active: Array.isArray(state?.blocks) ? state.blocks.filter(block => block.active).length : 0, total: state?.blocks?.length ?? 0 });
async function nextEpoch(epochs, stateDir, sid, minimum) {
    let next = minimum;
    for (const [root, pattern] of [
        [stateDir, new RegExp(`^${sid}(?:\\.context-([1-9][0-9]*))?\\.jsonl(?:\\.acp\\.json)?$`)],
        [join(epochs.root, 'epochs'), new RegExp(`^${sid}\\.([0-9]+)\\.json$`)],
    ]) {
        if (!await directory(root, false)) continue;
        for (const name of await readdir(root)) {
            const match = pattern.exec(name);
            if (!match) continue;
            const value = Number(match[1] ?? 0);
            if (!Number.isSafeInteger(value)) throw new Error('Invalid archived context epoch');
            next = Math.max(next, value + 1);
        }
    }
    if (!Number.isSafeInteger(next)) throw new Error('Context epoch exhausted');
    return next;
}

/** Called with the actual after-artifact-hook request. All selection evidence is request-bounded. */
export async function selectContext({ epochs, stateDir, sid, messages, bridge, version, signal, expected, diagnostic = () => {} }) {
    const before = await epochs.read(sid);
    if (expected && !sameMarker(before, expected)) throw new Error('Context changed while preparing request; retry with current context');
    const source = await stateAt(stateDir, sid, before.epoch);
    const fit = bridge.compatibleState(source, messages);
    const entries = bridge.branchEntries(messages.filter(message => message.role !== 'system'));
    const prefix = entries.map(entry => `${entry.id}:${entry.timestamp}`);
    const instances = bridge.contextInstances(messages);
    const incompatibleLegacy = !before.proof && !before.prefixHash && source !== undefined && fit.state === undefined;
    const inheritedAnchor = before.head === undefined ? bridge.checkpointContextId(join(stateDir, `${sid}.jsonl`), messages, version) : undefined;
    let boundary = await epochs.observe(sid, inheritedAnchor ?? entries[0]?.id, false, prefix, {
        instances, legacyOrders: !before.proof && before.prefixHash ? bridge.legacyOrders(messages, source) : [], incompatibleLegacy, signal,
        allocateEpoch: minimum => nextEpoch(epochs, stateDir, sid, minimum), expected: before,
        legacyHeadProved: !before.proof && !before.prefixHash && fit.aliases?.has(before.head),
    });
    let selected = boundary.epoch === before.epoch ? source : await stateAt(stateDir, sid, boundary.epoch);
    let derived;
    let reason = boundary.epoch !== before.epoch ? 'native-context-mismatch' : fit.reason;
    if (boundary.epoch === before.epoch && fit.migrated) derived = fit.state;

    // A new native boundary is final. No archive scanning, replay or alias repair can undo it.
    if (boundary.epoch === before.epoch && !derived && boundary.boundary && !selected?.blocks?.length) {
        const markers = await epochs.archived(sid, boundary.boundary);
        for (const marker of markers) {
            if (marker.epoch === boundary.epoch || !await epochs.fits(sid, marker, instances)) continue;
            const candidate = await stateAt(stateDir, sid, marker.epoch);
            if (!candidate) continue;
            const compatible = bridge.compatibleState(candidate, messages);
            // Do not replace an established destination, even with a fitting ancestor's richer state.
            if (selected?.blocks?.length || compatible.state === undefined) {
                diagnostic({ sid, epoch: marker.epoch, reason: compatible.state === undefined ? compatible.reason : 'destination-established', ...totals(candidate) });
                continue;
            }
            derived = compatible.state;
            reason = 'same-boundary-archive';
            break; // Latest proven epoch lineage, never highest block count / newest mtime.
        }
    }

    // Pre-proof releases left no per-epoch witness. Only exact same-chat checkpoint provenance
    // plus a complete alias fit can establish such a candidate; never a parent mutable sidecar.
    if (boundary.epoch === before.epoch && !derived && !before.proof && await directory(stateDir, false)) {
        const pattern = new RegExp(`^${sid}(?:\\.context-([1-9][0-9]*))?\\.jsonl\\.acp\\.json$`);
        const candidates = (await readdir(stateDir)).flatMap(name => {
            const match = pattern.exec(name);
            return match ? [Number(match[1] ?? 0)] : [];
        }).filter(epoch => epoch < boundary.epoch).sort((a, b) => b - a);
        for (const epoch of candidates) {
            const candidate = await stateAt(stateDir, sid, epoch);
            const compatible = bridge.compatibleState(candidate, messages);
            const retainsDestination = bridge.stateIncludes(compatible.state, selected);
            if (!candidate || !compatible.migrated || !retainsDestination || !bridge.checkpointProvesState(join(stateDir, `${sid}.jsonl`), candidate, messages, version, sid, boundary.head)) {
                diagnostic({ sid, epoch, reason: 'archive-boundary-unproven', ...totals(candidate) });
                continue;
            }
            derived = compatible.state;
            reason = 'legacy-checkpoint-artifact-alias';
            break;
        }
    }
    if (boundary.epoch === before.epoch && source !== undefined && fit.state === undefined && !derived) {
        diagnostic({ sid, epoch: boundary.epoch, reason: fit.reason, ...totals(source) });
        throw new Error('Compression identity migration cannot be proved; explicit repair required (files retained)');
    }
    if (derived) {
        await directory(stateDir, true);
        const epoch = await nextEpoch(epochs, stateDir, sid, boundary.epoch + 1);
        signal?.throwIfAborted();
        const target = sidecar(stateDir, sid, epoch);
        // An exclusive unpublished destination prevents accidental replacement and is ignored until selected.
        const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await file.writeFile(JSON.stringify(derived));
            await file.sync();
            await file.close();
            boundary = await epochs.repair(sid, epoch, prefix, instances, signal, boundary);
        } catch (error) {
            await file.close().catch(() => {});
            // Keep a complete unpublished state for diagnosis; never remove an original ACP file.
            diagnostic({ sid, epoch, reason: 'repair-not-published', ...totals(derived) });
            throw error;
        }
        selected = derived;
    }
    diagnostic({ sid, epoch: boundary.epoch, sidecar: `${sid}${boundary.epoch ? `.context-${boundary.epoch}` : ''}.jsonl.acp.json`, reason, ...totals(selected) });
    return boundary;
}
