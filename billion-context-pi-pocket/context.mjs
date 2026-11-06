import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, parse, resolve, sep } from 'node:path';

const EMPTY_HEAD = 'live-0000000000000000';
const HEX = /^[a-f0-9]{64}(?![\s\S])/;
const HEAD = /^live-[a-f0-9]{16}(?![\s\S])/;
const MAX_PROOF = 128 * 1024 * 1024;
export const digest = prefix => createHash('sha256').update(JSON.stringify(prefix)).digest('hex');
export const sameMarker = (a, b) => ['epoch', 'head', 'prefixLength', 'prefixHash', 'proof', 'boundary', 'generation', 'replayFloor'].every(key => a[key] === b[key]);
// Reloaded helpers/wrappers share one commit line; never publish a stale observation over a native boundary.
const lockKey = Symbol.for('billion-context-pi-pocket.context-commits');
const commits = globalThis[lockKey] ??= new Map();
async function commitLine(key, action) {
    const previous = commits.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    commits.set(key, current);
    try { await previous; return await action(); }
    finally { release(); if (commits.get(key) === current) commits.delete(key); }
}

export async function directory(path, create) {
    const absolute = resolve(path);
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        let info;
        try { info = await lstat(current); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (!create) return false;
            try { await mkdir(current, { mode: 0o700 }); }
            catch (creation) { if (creation.code !== 'EEXIST') throw creation; }
            info = await lstat(current);
        }
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe context-marker directory');
    }
    return true;
}
export async function boundedRead(target, maximum, label) {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maximum || info.nlink !== 1) throw new Error(`Unsafe ${label} file`);
        const bytes = Buffer.alloc(info.size + 1);
        let size = 0;
        while (size < bytes.length) {
            const result = await file.read(bytes, size, bytes.length - size, null);
            if (!result.bytesRead) break;
            size += result.bytesRead;
        }
        if (size > info.size) throw new Error(`Unsafe ${label} file size`);
        return bytes.subarray(0, size).toString('utf8');
    } finally { await file.close(); }
}
async function atomic(target, content, signal) {
    signal?.throwIfAborted();
    const temporary = join(dirname(target), `.context-${randomBytes(16).toString('hex')}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        await file.writeFile(content);
        await file.sync();
        await file.close();
        signal?.throwIfAborted();
        await rename(temporary, target);
    } catch (error) {
        await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
    }
}
function multiset(instances) {
    const values = new Map();
    for (const instance of instances) {
        if (!Array.isArray(instance) || instance.length !== 2 || typeof instance[0] !== 'string' || instance[0].length > 512
            || typeof instance[1] !== 'string' || instance[1].length > 512) throw new Error('Invalid context instances');
        const key = JSON.stringify(instance);
        values.set(key, (values.get(key) ?? 0) + 1);
    }
    return [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, count]) => [...JSON.parse(key), count]);
}
function contains(previous, current) {
    const present = new Map(current.map(([id, time, count]) => [JSON.stringify([id, time]), count]));
    return previous.every(([id, time, count]) => (present.get(JSON.stringify([id, time])) ?? 0) >= count);
}
const count = entries => entries.reduce((sum, entry) => sum + entry[2], 0);
function markerValue(value) {
    if (!value || ![1, 2].includes(value.format) || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !HEAD.test(value.head)) throw new Error('Invalid context marker');
    const hasProof = value.prefixLength !== undefined || value.prefixHash !== undefined;
    if (hasProof && (!Number.isSafeInteger(value.prefixLength) || value.prefixLength < 0 || !HEX.test(value.prefixHash))) throw new Error('Invalid context-prefix proof');
    if (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || value.generation < 0)) throw new Error('Invalid repair generation');
    if (value.replayFloor !== undefined && (!Number.isSafeInteger(value.replayFloor) || value.replayFloor < 0 || value.replayFloor > value.epoch)) throw new Error('Invalid context replay floor');
    if (value.format === 2 && (!HEX.test(value.proof) || !HEX.test(value.boundary))) throw new Error('Invalid context-proof pointer');
    return { epoch: value.epoch, head: value.head, ...(hasProof ? { prefixLength: value.prefixLength, prefixHash: value.prefixHash } : {}),
        ...(value.generation === undefined ? {} : { generation: value.generation }),
        ...(value.replayFloor === undefined ? {} : { replayFloor: value.replayFloor }),
        ...(value.format === 2 ? { proof: value.proof, boundary: value.boundary } : {}) };
}

/** Request-message-only boundary witness. No unbounded native-head read is treated as request provenance. */
export class ContextEpochStore {
    constructor(root) { this.root = resolve(root); }
    file(id) {
        const value = String(id);
        if (!/^[1-9][0-9]*(?![\s\S])/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid conversation ID');
        return join(this.root, `${value}.json`);
    }
    async read(id) {
        const target = this.file(id);
        if (!await directory(this.root, false)) return { epoch: 0 };
        let text;
        try { text = await boundedRead(target, 4096, 'context-marker'); }
        catch (error) { if (error.code === 'ENOENT') return { epoch: 0 }; throw error; }
        const result = markerValue(JSON.parse(text));
        if (result.proof) await this.proof(id, result); // A missing/tampered object never falls back to a head-only proof.
        return result;
    }
    async proof(id, marker) {
        if (!marker.proof) return undefined;
        if (!HEX.test(marker.proof)) throw new Error('Invalid context-proof pointer');
        const folder = join(this.root, 'proofs');
        if (!await directory(folder, false)) throw new Error('Missing context proof; explicit repair required');
        const text = await boundedRead(join(folder, `${marker.proof}.json`), MAX_PROOF, 'context-proof');
        if (createHash('sha256').update(text).digest('hex') !== marker.proof) throw new Error('Context proof hash mismatch; explicit repair required');
        const proof = JSON.parse(text);
        if (proof.format !== 1 || proof.conversationId !== String(id) || proof.epoch !== marker.epoch || proof.head !== marker.head
            || proof.boundary !== marker.boundary || proof.replayFloor !== marker.replayFloor || !Array.isArray(proof.instances) || proof.instances.some(entry => !Array.isArray(entry) || entry.length !== 3
                || typeof entry[0] !== 'string' || entry[0].length > 512 || typeof entry[1] !== 'string' || entry[1].length > 512 || !Number.isSafeInteger(entry[2]) || entry[2] <= 0)
            || new Set(proof.instances.map(([id, time]) => JSON.stringify([id, time]))).size !== proof.instances.length) throw new Error('Invalid context proof');
        return proof;
    }
    async publish(id, next, instances, signal) {
        await directory(this.root, true);
        if (instances !== undefined) {
            const proof = { format: 1, conversationId: String(id), epoch: next.epoch, head: next.head, boundary: next.boundary, instances,
                ...(next.replayFloor === undefined ? {} : { replayFloor: next.replayFloor }) };
            const text = JSON.stringify(proof);
            if (Buffer.byteLength(text) > MAX_PROOF) throw new Error('Context proof too large');
            next.proof = createHash('sha256').update(text).digest('hex');
            const folder = join(this.root, 'proofs');
            await directory(folder, true);
            const target = join(folder, `${next.proof}.json`);
            try {
                if (await boundedRead(target, MAX_PROOF, 'context-proof') !== text) throw new Error('Context proof hash mismatch');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await atomic(target, text, signal);
            }
        }
        const marker = { format: next.proof ? 2 : 1, ...next };
        const target = this.file(id);
        // Keep immutable proof objects and an epoch's last marker. No old ACP/checkpoint is ever deleted.
        const archives = join(this.root, 'epochs');
        await directory(archives, true);
        await atomic(join(archives, `${id}.${next.epoch}.json`), JSON.stringify(marker), signal);
        await atomic(target, JSON.stringify(marker) + '\n', signal); // Publish only after the proof exists.
        return next;
    }
    async archived(id, boundary) {
        this.file(id);
        const folder = join(this.root, 'epochs');
        if (!await directory(folder, false)) return [];
        const markers = [];
        for (const name of await readdir(folder)) {
            if (!new RegExp(`^${id}\\.[0-9]+\\.json$`).test(name)) continue;
            const value = JSON.parse(await boundedRead(join(folder, name), 4096, 'context-marker'));
            const marker = markerValue(value);
            if (name !== `${id}.${marker.epoch}.json`) throw new Error('Invalid archived context epoch');
            if (value.format === 2 && marker.boundary === boundary) { await this.proof(id, marker); markers.push(marker); }
        }
        return markers.sort((a, b) => b.epoch - a.epoch);
    }
    async fits(id, marker, instances) {
        const proof = await this.proof(id, marker);
        return proof !== undefined && contains(proof.instances, multiset(instances));
    }
    async observe(id, head, reset = false, prefix, options = {}) {
        return commitLine(this.file(id), () => this.observeLocked(id, head, reset, prefix, options));
    }
    async observeLocked(id, head, reset, prefix, options) {
        const previous = await this.read(id);
        if (options.expected && !sameMarker(previous, options.expected)) throw new Error('Context changed while preparing request; retry with current context');
        if (prefix !== undefined && (!Array.isArray(prefix) || prefix.some(value => typeof value !== 'string' || value.length > 512))) throw new Error('Invalid context prefix');
        if (head === undefined) {
            if (prefix === undefined) return previous;
            if (prefix.length) throw new Error('A non-empty context requires a head');
            if (previous.head === undefined && !reset) return previous;
            head = previous.head ?? EMPTY_HEAD;
        }
        if (!HEAD.test(head)) throw new Error('Invalid context identity');
        const instances = prefix === undefined ? undefined : multiset(options.instances ?? prefix.map(value => {
            const split = value.lastIndexOf(':');
            return [value.slice(0, split), value.slice(split + 1)];
        }));
        const old = await this.proof(id, previous);
        let verified = false;
        let legacyBoundary = false;
        if (!reset && instances !== undefined && old) verified = contains(old.instances, instances);
        else if (!reset && prefix !== undefined && previous.prefixLength !== undefined) {
            verified = [prefix, ...(options.legacyOrders ?? [])].some(order => order.length >= previous.prefixLength && digest(order.slice(0, previous.prefixLength)) === previous.prefixHash);
            if (!verified) {
                // Fewer instances cannot be a permutation. Otherwise retain ambiguous migration files,
                // except when a complete saved pass proves missing IDs or the user explicitly restores raw history.
                legacyBoundary = prefix.length < previous.prefixLength || options.incompatibleLegacy === true || options.allowLegacyReset === true;
                if (!legacyBoundary) throw new Error('Legacy context digest cannot be proved; explicit repair required (files retained)');
            }
        }
        else if (!reset && prefix !== undefined && previous.head !== undefined && previous.prefixLength === undefined) {
            // Head-only releases stored no counts/timestamps. Retain their compatibility fallback,
            // but require the old anchor (or its exact proven alias) to occur in the current request.
            verified = options.legacyHeadProved === true || prefix.some(value => value.startsWith(`${previous.head}:`));
        }
        const becameEmpty = instances?.length === 0 && previous.head !== undefined && (old ? count(old.instances) !== 0 : previous.prefixLength !== 0);
        const mismatch = old && instances !== undefined && !verified;
        const changedHead = previous.head !== undefined && previous.head !== head && previous.prefixLength !== 0 && !verified;
        const changed = reset || mismatch || becameEmpty || changedHead || legacyBoundary
            || (options.incompatibleLegacy === true && previous.prefixLength === undefined);
        const minimum = previous.epoch + Number(changed);
        const epoch = changed && options.allocateEpoch ? await options.allocateEpoch(minimum) : minimum;
        if (!Number.isSafeInteger(epoch) || epoch < minimum) throw new Error('Context epoch exhausted');
        const anchor = !changed && previous.head !== undefined && previous.prefixLength !== 0 ? previous.head : head;
        const proof = prefix !== undefined ? { prefixLength: prefix.length, prefixHash: digest(prefix) }
            : !changed && previous.prefixLength !== undefined ? { prefixLength: previous.prefixLength, prefixHash: previous.prefixHash } : {};
        const boundary = changed || !previous.boundary ? randomBytes(32).toString('hex') : previous.boundary;
        // A verified permutation must not churn the marker or the stable checkpoint anchor.
        if (!changed && old && instances && digest(old.instances) === digest(instances)) return previous;
        if (previous.epoch === epoch && previous.head === anchor && prefix === undefined) return previous;
        const replayFloor = changed && prefix !== undefined ? epoch : previous.replayFloor;
        return this.publish(id, { epoch, head: anchor, ...proof, ...(!changed && previous.generation !== undefined ? { generation: previous.generation } : {}),
            ...(replayFloor === undefined ? {} : { replayFloor }), ...(instances ? { boundary } : {}) }, instances, options.signal);
    }
    /** A proven derived state selects a fresh epoch but retains its native boundary witness. */
    async repair(id, epoch, prefix, instances, signal, expected) {
        return commitLine(this.file(id), () => this.repairLocked(id, epoch, prefix, instances, signal, expected));
    }
    async repairLocked(id, epoch, prefix, instances, signal, expected) {
        const previous = await this.read(id);
        if (expected && !sameMarker(previous, expected)) throw new Error('Context changed during repair; retry required');
        if (!Number.isSafeInteger(epoch) || epoch <= previous.epoch || !previous.boundary) throw new Error('Invalid context repair epoch');
        return this.publish(id, { epoch, head: previous.head, boundary: previous.boundary, prefixLength: prefix.length, prefixHash: digest(prefix),
            ...(previous.replayFloor === undefined ? {} : { replayFloor: previous.replayFloor }) }, multiset(instances), signal);
    }
}
