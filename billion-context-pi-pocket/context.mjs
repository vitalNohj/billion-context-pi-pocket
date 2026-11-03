import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, parse, resolve, sep } from 'node:path';

async function directory(path, create) {
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

/** Detect a native compaction/reset without reading or modifying Pocket's internal documents. */
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
        let file;
        try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if (error.code === 'ENOENT') return { epoch: 0 }; throw error; }
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > 4096 || info.nlink !== 1) throw new Error('Unsafe context-marker file');
            const bytes = Buffer.alloc(4097);
            let size = 0;
            while (size < bytes.length) {
                const result = await file.read(bytes, size, bytes.length - size, null);
                if (result.bytesRead === 0) break;
                size += result.bytesRead;
            }
            if (size > 4096) throw new Error('Unsafe context-marker file size');
            const value = JSON.parse(bytes.subarray(0, size).toString('utf8'));
            if (value.format !== 1 || !Number.isSafeInteger(value.epoch) || value.epoch < 0
                || typeof value.head !== 'string' || !/^live-[a-f0-9]{16}(?![\s\S])/.test(value.head)) {
                throw new Error('Invalid context marker');
            }
            return { epoch: value.epoch, head: value.head };
        } finally { await file.close(); }
    }

    async observe(id, head, reset = false) {
        const previous = await this.read(id);
        if (head === undefined || (previous.head === head && !reset)) return previous;
        if (!/^live-[a-f0-9]{16}(?![\s\S])/.test(head)) throw new Error('Invalid context identity');
        const epoch = previous.head === undefined && !reset ? previous.epoch : previous.epoch + 1;
        if (!Number.isSafeInteger(epoch)) throw new Error('Context epoch exhausted');
        const next = { format: 1, epoch, head };
        await directory(this.root, true);
        const target = this.file(id);
        const temporary = join(dirname(target), `.context-${randomBytes(16).toString('hex')}.tmp`);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await file.writeFile(JSON.stringify(next) + '\n');
            await file.sync();
            await file.close();
            await rename(temporary, target);
        } catch (error) {
            await file.close().catch(() => {});
            await unlink(temporary).catch(() => {});
            throw error;
        }
        return { epoch, head };
    }
}
