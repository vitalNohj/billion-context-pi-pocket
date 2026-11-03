import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    const response = await fetcher(pin.tarball, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `Pinned test archive request failed: HTTP ${response.status}`);
    assert.ok(response.body, 'Pinned test archive response has no body');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        assert.ok(size <= pin.archiveBytes, 'Pinned test archive response exceeds the reviewed size');
        chunks.push(Buffer.from(chunk));
    }
    return verify(Buffer.concat(chunks, size), pin);
}

/** Read a verified pin-generation cache, or fetch the same immutable test archive on a clean machine. */
export async function pinnedTestArchive(pin, { cacheDir, fetcher = globalThis.fetch }) {
    assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.ok(Number.isSafeInteger(pin.archiveBytes) && pin.archiveBytes > 0);
    assert.equal(new URL(pin.tarball).protocol, 'https:');
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
