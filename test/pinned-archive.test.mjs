import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinnedTestArchive } from './pinned-archive.mjs';

async function fixture(t) {
    const base = await mkdtemp(join(tmpdir(), 'bcp-archive-fixture-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const bytes = Buffer.from('the exact reviewed archive bytes');
    const digest = createHash('sha512').update(bytes).digest();
    const pin = {
        tarball: 'https://registry.npmjs.org/bcp-fixture/-/bcp-fixture-1.0.0.tgz',
        integrity: `sha512-${digest.toString('base64')}`,
        archiveBytes: bytes.length,
    };
    const cacheDir = join(base, 'cache');
    const file = join(cacheDir, `${digest.toString('hex')}.tgz`);
    return { bytes, pin, cacheDir, file };
}

const unexpectedFetch = async () => { throw new Error('UNEXPECTED_NETWORK_REQUEST'); };

test('a cold test-data cache fetches and verifies only the reviewed archive without creating cache files', async t => {
    const f = await fixture(t);
    let requests = 0;
    const fetcher = async (url, options) => {
        requests++;
        assert.equal(url, f.pin.tarball);
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.signal.aborted, false);
        return new Response(f.bytes);
    };
    assert.deepEqual(await pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher }), f.bytes);
    assert.equal(requests, 1);
    await assert.rejects(access(f.cacheDir), { code: 'ENOENT' });
});

test('a valid warm test-data cache works offline without a fetch', async t => {
    const f = await fixture(t);
    await mkdir(f.cacheDir);
    await writeFile(f.file, f.bytes);
    assert.deepEqual(await pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher: unexpectedFetch }), f.bytes);
});

test('concurrent fixtures fetch once and receive separate copies of verified bytes', async t => {
    const f = await fixture(t);
    let requests = 0;
    const fetcher = async () => { requests++; return new Response(f.bytes); };
    const values = await Promise.all([
        pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher }),
        pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher }),
    ]);
    assert.equal(requests, 1);
    assert.deepEqual(values[0], f.bytes);
    assert.deepEqual(values[1], f.bytes);
    assert.notEqual(values[0], values[1]);
    values[0][0] ^= 0xff;
    assert.deepEqual(values[1], f.bytes);
    assert.deepEqual(await pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher: unexpectedFetch }), f.bytes);
});

test('corrupt cached archives fail rather than hide the corruption with a network fallback', async t => {
    for (const kind of ['size', 'integrity']) {
        await t.test(kind, async t => {
            const f = await fixture(t);
            const bad = Buffer.from(f.bytes);
            bad[0] ^= 0xff;
            await mkdir(f.cacheDir);
            await writeFile(f.file, kind === 'size' ? bad.subarray(1) : bad);
            let requests = 0;
            const fetcher = async () => { requests++; throw new Error('UNEXPECTED_FALLBACK'); };
            await assert.rejects(pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher }), /does not match the reviewed pin/);
            assert.equal(requests, 0);
        });
    }
});

test('unverified downloaded data never becomes reusable test data', async t => {
    for (const kind of ['short', 'integrity']) {
        await t.test(kind, async t => {
            const f = await fixture(t);
            const bad = Buffer.from(f.bytes);
            bad[0] ^= 0xff;
            const fetcher = async () => new Response(kind === 'short' ? bad.subarray(1) : bad);
            await assert.rejects(pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher }), /does not match the reviewed pin/);
        });
    }
});

test('an oversized archive stream is cancelled before buffering beyond the reviewed size', async t => {
    const f = await fixture(t);
    let cancelled = false;
    const stream = new ReadableStream({
        start(controller) { controller.enqueue(Buffer.alloc(f.pin.archiveBytes + 1)); },
        cancel() { cancelled = true; },
    });
    await assert.rejects(pinnedTestArchive(f.pin, {
        cacheDir: f.cacheDir, fetcher: async () => new Response(stream),
    }), /exceeds the reviewed size/);
    assert.equal(cancelled, true);
});

test('HTTP errors are reported instead of treated as archive bytes', async t => {
    const f = await fixture(t);
    await assert.rejects(pinnedTestArchive(f.pin, {
        cacheDir: f.cacheDir, fetcher: async () => new Response('unavailable', { status: 503 }),
    }), /HTTP 503/);
});

test('a failed fixture download can be retried and successful bytes are then reused offline', async t => {
    const f = await fixture(t);
    await assert.rejects(pinnedTestArchive(f.pin, {
        cacheDir: f.cacheDir, fetcher: async () => { throw new Error('OFFLINE'); },
    }), /OFFLINE/);
    let requests = 0;
    assert.deepEqual(await pinnedTestArchive(f.pin, {
        cacheDir: f.cacheDir, fetcher: async () => { requests++; return new Response(f.bytes); },
    }), f.bytes);
    assert.equal(requests, 1);
    assert.deepEqual(await pinnedTestArchive(f.pin, { cacheDir: f.cacheDir, fetcher: unexpectedFetch }), f.bytes);
});

test('invalid archive pins are rejected before fetching', async t => {
    for (const change of [
        { integrity: 'sha256-not-a-reviewed-sha512' },
        { archiveBytes: 0 },
        { archiveBytes: 1.5 },
        { tarball: 'http://registry.npmjs.org/not-https.tgz' },
    ]) {
        await t.test(JSON.stringify(change), async t => {
            const f = await fixture(t);
            let requests = 0;
            await assert.rejects(pinnedTestArchive({ ...f.pin, ...change }, {
                cacheDir: f.cacheDir, fetcher: async () => { requests++; throw new Error('UNEXPECTED_FETCH'); },
            }));
            assert.equal(requests, 0);
        });
    }
});
