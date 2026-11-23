import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadArchive, validatePin } from '../billion-context-pi-pocket/runtime.mjs';

// This is test data, not an extension installer. A clean checkout has no pin-generation cache.
// Acquire the reviewed archive once before tests replace fetch to count owner-action downloads.
const pending = new Map();

function verify(bytes, pin) {
    assert.equal(bytes.length, pin.archiveBytes, 'Pinned test archive size does not match the reviewed pin');
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pin.integrity,
        'Pinned test archive integrity does not match the reviewed pin');
    return bytes;
}

async function acquire(pin, cacheDir, fetcher) {
    const digest = pin.integrity.slice('sha512-'.length);
    const cache = join(cacheDir, `${Buffer.from(digest, 'base64').toString('hex')}.tgz`);
    try {
        return verify(await readFile(cache), pin);
    } catch (error) {
        // Do not hide corruption, permission failures, or unexpected cache objects.
        if (error.code !== 'ENOENT') throw error;
    }
    return downloadArchive(pin, { fetcher, signal: AbortSignal.timeout(30_000) });
}

/** Read a verified pin-generation cache, or fetch the same immutable test archive on a clean machine. */
export async function pinnedTestArchive(input, { cacheDir, fetcher = globalThis.fetch }) {
    const pin = validatePin(input);
    assert.ok(pin.archiveBytes, 'Test archive must have a reviewed size');
    const key = JSON.stringify([cacheDir, pin.tarball, pin.integrity, pin.archiveBytes]);
    let promise = pending.get(key);
    if (!promise) {
        promise = acquire(pin, cacheDir, fetcher);
        pending.set(key, promise);
    }
    try {
        // A fixture must not be able to corrupt the archive used by another fixture.
        return Buffer.from(await promise);
    } catch (error) {
        if (pending.get(key) === promise) pending.delete(key);
        throw error;
    }
}
