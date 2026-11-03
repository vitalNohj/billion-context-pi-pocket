import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_UNPACKED = 64 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_SELECTION = 4096;
const DOWNLOAD_TIMEOUT = 120_000;
const IN_FLIGHT = Symbol.for('billion-context-pi-pocket.runtime-store.in-flight.v1');
const unzip = promisify(gunzip);
const utf8 = new TextDecoder('utf-8', { fatal: true });
// Use an exact end assertion. JavaScript's $ also accepts a final line terminator.
const HEX = /^[a-f0-9]{64}(?![\s\S])/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?![\s\S])/;

function operations() {
  if (!Object.hasOwn(globalThis, IN_FLIGHT)) {
    Object.defineProperty(globalThis, IN_FLIGHT, { value: new Map() });
  }
  const map = globalThis[IN_FLIGHT];
  if (!(map instanceof Map)) throw new Error('Invalid runtime operation mutex');
  return map;
}

function stableVersion(version) {
  if (typeof version !== 'string' || version.length > 128 || !VERSION.test(version)
      || version.split('.').some(part => !Number.isSafeInteger(Number(part)))) {
    throw new Error('Invalid stable runtime version');
  }
  return version;
}

/** Validate and snapshot a pin. Sizes are optional; unpackedBytes counts file payload bytes, as npm does. */
export function validatePin(pin) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('Invalid runtime pin');
  const version = stableVersion(pin.version);
  const tarball = `https://registry.npmjs.org/billion-context-pi/-/billion-context-pi-${version}.tgz`;
  if (pin.tarball !== tarball) throw new Error('Invalid runtime tarball URL');
  const integrity = pin.integrity;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
      || Buffer.from(integrity.slice(7), 'base64').toString('base64') !== integrity.slice(7)) {
    throw new Error('Invalid canonical SHA512 runtime integrity');
  }
  const result = { version, tarball, integrity };
  for (const [key, cap, minimum] of [['archiveBytes', MAX_ARCHIVE, 1], ['unpackedBytes', MAX_UNPACKED, 0]]) {
    const size = pin[key];
    if (size !== undefined) {
      if (!Number.isSafeInteger(size) || size < minimum || size > cap) throw new Error(`Invalid runtime ${key}`);
      result[key] = size;
    }
  }
  return Object.freeze(result);
}

export function fingerprint(pin) {
  return createHash('sha256').update(validatePin(pin).integrity).digest('hex');
}

function integrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function checkArchive(bytes, pin) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE) {
    throw new Error('Runtime archive exceeds the compressed size limit');
  }
  if (pin.archiveBytes !== undefined && bytes.length !== pin.archiveBytes) throw new Error('Runtime archive size mismatch');
  if (integrityOf(bytes) !== pin.integrity) throw new Error('Runtime archive integrity mismatch');
}

function textField(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some(byte => byte !== 0)) throw new Error('Invalid tar text field');
  return utf8.decode(end === -1 ? field : field.subarray(0, end));
}

function octal(field, label) {
  const text = field.toString('ascii');
  if (!/^[ 0-7]*[\0 ]*(?![\s\S])/.test(text) || field.some(byte => byte > 127)) throw new Error(`Invalid tar ${label}`);
  const digits = text.replace(/[\0 ]+$/g, '').trim();
  const number = digits === '' ? 0 : Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid tar ${label}`);
  return number;
}

function safePath(name, directory, requirePackage = true) {
  if (typeof name !== 'string' || name.length === 0 || Buffer.byteLength(name) > 4096
      || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) throw new Error('Unsafe tar path');
  const normalized = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || /^[A-Za-z]:/.test(part)
      || Buffer.byteLength(part) > 255) || path.posix.normalize(normalized) !== normalized) {
    throw new Error('Unsafe tar path');
  }
  if (requirePackage && (parts[0] !== 'package' || (!directory && parts.length === 1))) {
    throw new Error('Tar entries must have the package/ prefix');
  }
  return requirePackage ? parts.slice(1).join('/') : normalized;
}

function paxFields(bytes) {
  const result = new Map();
  const harmless = new Set(['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'charset']);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 9) throw new Error('Invalid PAX record length');
    const digits = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(digits)) throw new Error('Invalid PAX record length');
    const length = Number(digits);
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) {
      throw new Error('Invalid PAX record length');
    }
    const record = utf8.decode(bytes.subarray(space + 1, end - 1));
    const equal = record.indexOf('=');
    if (equal < 1) throw new Error('Invalid PAX record');
    const key = record.slice(0, equal);
    const value = record.slice(equal + 1);
    if (result.has(key)) throw new Error('Duplicate PAX field');
    if (key !== 'path' && key !== 'size' && !harmless.has(key)) throw new Error(`Unsupported PAX field: ${key}`);
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid PAX value');
    if (key === 'size' && (!/^(0|[1-9][0-9]*)$/.test(value)
        || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_FILE)) throw new Error('Invalid PAX size');
    result.set(key, value);
    offset = end;
  }
  return result;
}

async function parseArchive(archive, maxEntries = MAX_ENTRIES) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 16384) {
    throw new Error('Invalid runtime archive entry limit: expected an integer from 1 to 16384');
  }
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > MAX_ARCHIVE) {
    throw new Error('Runtime archive exceeds the compressed size limit');
  }
  const tar = await unzip(archive, { maxOutputLength: MAX_UNPACKED });
  if (tar.length % 512 !== 0) throw new Error('Truncated tar archive');
  const files = new Map();
  const directories = new Set();
  const seen = new Set();
  let pending = null;
  let offset = 0;
  let entries = 0;
  let fileBytes = 0;
  let ended = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) throw new Error('Invalid tar end marker');
      ended = true;
      break;
    }
    if (++entries > maxEntries) throw new Error(`Runtime archive exceeds ${maxEntries} entries`);
    const expected = octal(header.subarray(148, 156), 'checksum');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) throw new Error('Invalid tar checksum');
    const magic = header.subarray(257, 263);
    if (!magic.every(byte => byte === 0) && !magic.equals(Buffer.from('ustar\0'))
        && !magic.equals(Buffer.from('ustar '))) throw new Error('Unsupported tar format');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    if (!['0', '5', 'x'].includes(type)) throw new Error(`Unsupported tar entry type: ${type}`);
    if (textField(header, 157, 100) !== '') throw new Error('Tar links are not permitted');
    const prefix = textField(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${textField(header, 0, 100)}`;
    // PAX headers are metadata, not extracted entries. Their own names must still be safe.
    safePath(name, type === '5', type !== 'x');
    let size = octal(header.subarray(124, 136), 'size');
    if (size > MAX_FILE) throw new Error('Tar entry exceeds the per-file size limit');
    if (type === 'x' && pending !== null) throw new Error('Consecutive PAX headers are not supported');
    if (type !== 'x' && pending?.has('size')) size = Number(pending.get('size'));
    if (size > MAX_FILE) throw new Error('Tar entry exceeds the per-file size limit');
    const start = offset + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    if (next > tar.length || tar.subarray(end, next).some(byte => byte !== 0)) throw new Error('Truncated or invalid tar payload');
    const payload = tar.subarray(start, end);
    offset = next;
    if (type === 'x') {
      pending = paxFields(payload);
      continue;
    }
    const relative = safePath(pending?.get('path') ?? name, type === '5');
    pending = null;
    if (seen.has(relative)) throw new Error('Duplicate tar entry');
    seen.add(relative);
    if (type === '5' && size !== 0) throw new Error('Tar directory has a payload');
    if (type === '0') {
      if (directories.has(relative)) throw new Error('Tar file/directory conflict');
      files.set(relative, payload);
      fileBytes += size;
    } else if (relative) {
      if (files.has(relative)) throw new Error('Tar file/directory conflict');
      directories.add(relative);
    }
    const parts = relative.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (files.has(parent)) throw new Error('Tar file/directory conflict');
      directories.add(parent);
    }
    // Include inferred directories in the filesystem work limit, not only explicit tar headers.
    if (files.size + directories.size > maxEntries) throw new Error(`Runtime archive exceeds ${maxEntries} filesystem entries`);
  }
  if (!ended || pending !== null) throw new Error('Incomplete tar archive');
  return { files, directories, fileBytes };
}

/** Return unchanged file payloads relative to package/. Author-side inspection can raise the bounded entry limit. */
export async function unpackArchive(archive, { maxEntries = MAX_ENTRIES } = {}) {
  return (await parseArchive(archive, maxEntries)).files;
}

function checkMetadata(parsed, pin) {
  const bytes = parsed.files.get('package.json');
  if (!bytes) throw new Error('Runtime package.json is missing');
  let metadata;
  try { metadata = JSON.parse(utf8.decode(bytes)); } catch { throw new Error('Invalid runtime package.json'); }
  if (!metadata || metadata.name !== 'billion-context-pi' || metadata.version !== pin.version) {
    throw new Error('Runtime package metadata mismatch');
  }
  if (pin.unpackedBytes !== undefined && parsed.fileBytes !== pin.unpackedBytes) throw new Error('Runtime unpacked size mismatch');
}

function aborted(signal) {
  signal?.throwIfAborted();
}

function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function download(pin, fetcher, callerSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(callerSignal.reason);
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error('Runtime download timed out after 120 seconds')), DOWNLOAD_TIMEOUT);
  timer.unref();
  let reader;
  let received;
  try {
    aborted(controller.signal);
    const request = Promise.resolve(fetcher(pin.tarball, { redirect: 'error', signal: controller.signal })).then(response => {
      if (controller.signal.aborted) {
        try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* Preserve the abort reason. */ }
        aborted(controller.signal);
      }
      return response;
    });
    const response = await abortable(request, controller.signal);
    received = response;
    if (response.status !== 200 || response.redirected || (response.url && response.url !== pin.tarball)) {
      throw new Error('Runtime download did not return the pinned URL with status 200');
    }
    const lengthHeader = response.headers.get('content-length');
    let declared;
    if (lengthHeader !== null) {
      if (!/^(0|[1-9][0-9]*)$/.test(lengthHeader)) throw new Error('Invalid runtime Content-Length');
      declared = Number(lengthHeader);
      if (!Number.isSafeInteger(declared) || declared > MAX_ARCHIVE
          || (pin.archiveBytes !== undefined && declared !== pin.archiveBytes)) throw new Error('Runtime archive size mismatch');
    }
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Runtime download body is missing');
    reader = response.body.getReader();
    // One bounded allocation also prevents millions of tiny chunks from growing a chunk array.
    const storage = Buffer.allocUnsafe(pin.archiveBytes ?? MAX_ARCHIVE);
    let total = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), controller.signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid runtime download chunk');
      if (value.byteLength > storage.length - total) throw new Error('Runtime archive exceeds the compressed size limit');
      storage.set(value, total);
      total += value.byteLength;
    }
    if (declared !== undefined && total !== declared) throw new Error('Interrupted runtime download');
    const bytes = storage.subarray(0, total);
    checkArchive(bytes, pin);
    return bytes;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
    try {
      if (reader) Promise.resolve(reader.cancel()).catch(() => {});
      else if (received?.body) Promise.resolve(received.body.cancel()).catch(() => {});
    } catch { /* Cancellation must not hide the download error. */ }
    if (reader) {
      try { reader.releaseLock(); } catch { /* A canceled read can still be settling. */ }
    }
  }
}

async function statIfPresent(location) {
  try { return await fs.lstat(location); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameObject(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

/** Check every ancestor before using a controlled path. Never use recursive mkdir or recursive rm. */
async function directory(location, create = false) {
  const absolute = path.resolve(location);
  const base = path.parse(absolute).root;
  let current = base;
  for (const part of absolute.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat = await statIfPresent(current);
    if (!stat && create) {
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await fs.lstat(current);
    }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe runtime directory: ${current}`);
  }
  return true;
}

async function readFile(location, limit) {
  if (!await directory(path.dirname(location))) throw new Error(`Missing runtime directory: ${path.dirname(location)}`);
  const before = await fs.lstat(location);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error(`Unsafe runtime file: ${location}`);
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameObject(before, stat) || stat.size > limit) throw new Error(`Unsafe runtime file: ${location}`);
    const storage = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(storage, total, Math.min(64 * 1024, storage.length - total), null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit || total > stat.size) throw new Error(`Runtime file changed size while reading: ${location}`);
    }
    return { bytes: storage.subarray(0, total), stat };
  } finally { await handle.close(); }
}

async function ownDirectory(location, ledger) {
  await directory(path.dirname(location));
  await fs.mkdir(location, { mode: 0o700 });
  ledger.push({ location, stat: await fs.lstat(location), type: 'directory' });
}

async function ownFile(location, bytes, ledger) {
  if (!await directory(path.dirname(location))) throw new Error('Missing staging directory');
  const handle = await fs.open(location, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    ledger.push({ location, stat: await handle.stat(), type: 'file' });
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

async function ownLink(location, target, ledger) {
  if (!await directory(path.dirname(location))) throw new Error('Missing staging directory');
  await fs.symlink(target, location, process.platform === 'win32' ? 'junction' : 'dir');
  ledger.push({ location, stat: await fs.lstat(location), type: 'link', target });
}

function sameLinkTarget(actual, expected) {
  if (process.platform !== 'win32') return actual === expected;
  return path.isAbsolute(actual) && path.isAbsolute(expected)
    && path.toNamespacedPath(path.resolve(actual)) === path.toNamespacedPath(path.resolve(expected));
}

async function materializeBundle(bundlePath, parsed, nodeModules, ledger, signal) {
  aborted(signal);
  await ownDirectory(bundlePath, ledger);
  const packageDir = path.join(bundlePath, 'package');
  await ownDirectory(packageDir, ledger);
  for (const relative of [...parsed.directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
    aborted(signal);
    await ownDirectory(path.join(packageDir, relative), ledger);
  }
  for (const [relative, content] of parsed.files) {
    aborted(signal);
    await ownFile(path.join(packageDir, relative), content, ledger);
  }
  aborted(signal);
  await ownLink(path.join(bundlePath, 'node_modules'), nodeModules, ledger);
}

async function removeOwned(ledger) {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const entry = ledger[i];
    if (!await directory(path.dirname(entry.location))) continue;
    const stat = await statIfPresent(entry.location);
    if (!stat) continue;
    if (!sameObject(stat, entry.stat)) throw new Error(`Refusing to remove a changed runtime object: ${entry.location}`);
    if (entry.type === 'directory') {
      if (!stat.isDirectory()) throw new Error('Changed runtime directory');
      await fs.rmdir(entry.location);
    } else if (entry.type === 'link') {
      if (!stat.isSymbolicLink() || !sameLinkTarget(await fs.readlink(entry.location), entry.target)) throw new Error('Changed runtime peer link');
      await fs.unlink(entry.location);
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Changed runtime file');
      await fs.unlink(entry.location);
    }
  }
}

function parseSelection(bytes) {
  let selection;
  try { selection = JSON.parse(utf8.decode(bytes)); } catch { throw new Error('Invalid runtime selection'); }
  if (!selection || Array.isArray(selection) || selection.format !== 1) throw new Error('Invalid runtime selection');
  const keys = Object.keys(selection).sort().join(',');
  if (selection.state === 'uninstalled' && keys === 'format,state') return { format: 1, state: 'uninstalled' };
  if (selection.state !== 'installed' || keys !== 'fingerprint,format,state,version'
      || typeof selection.fingerprint !== 'string' || !HEX.test(selection.fingerprint)) throw new Error('Invalid runtime selection');
  stableVersion(selection.version);
  return { format: 1, state: 'installed', version: selection.version, fingerprint: selection.fingerprint };
}

async function selectionSnapshot(root) {
  if (!await directory(root)) return { selection: null, bytes: null, stat: null };
  const location = path.join(root, 'selection.json');
  if (!await statIfPresent(location)) return { selection: null, bytes: null, stat: null };
  const { bytes, stat } = await readFile(location, MAX_SELECTION);
  return { selection: parseSelection(bytes), bytes, stat };
}

async function replaceSelection(root, selection, previous, signal) {
  const ledger = [];
  const temporary = path.join(root, `.selection-${randomBytes(16).toString('hex')}.json`);
  try {
    aborted(signal);
    await ownFile(temporary, Buffer.from(`${JSON.stringify(selection)}\n`), ledger);
    const current = await selectionSnapshot(root);
    if (Boolean(current.stat) !== Boolean(previous.stat)
        || (current.stat && (!sameObject(current.stat, previous.stat) || !current.bytes.equals(previous.bytes)))) {
      throw new Error('Runtime selection changed during the operation');
    }
    aborted(signal);
    // This is the commit point. Do not perform fallible work after this rename.
    await fs.rename(temporary, path.join(root, 'selection.json'));
  } catch (error) {
    try { await removeOwned(ledger); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime selection write and cleanup failed'); }
    throw error;
  }
}

async function inspectBundle(bundle, parsed, nodeModules) {
  if (!await directory(bundle)) throw new Error('Runtime package directory is missing');
  const ledger = [{ location: bundle, stat: await fs.lstat(bundle), type: 'directory' }];
  const top = await fs.opendir(bundle, { bufferSize: 8 });
  let topCount = 0;
  for await (const entry of top) {
    if (++topCount > 2 || !['package', 'node_modules'].includes(entry.name)) throw new Error('Unexpected runtime cache object');
  }
  if (topCount !== 2) throw new Error('Runtime package or peer link is missing');
  const peer = path.join(bundle, 'node_modules');
  const peerStat = await fs.lstat(peer);
  if (!peerStat.isSymbolicLink() || !sameLinkTarget(await fs.readlink(peer), nodeModules)) throw new Error('Runtime peer link target mismatch');
  if (!(await fs.stat(nodeModules)).isDirectory()) throw new Error('Runtime peer dependency target is not a directory');
  ledger.push({ location: peer, stat: peerStat, type: 'link', target: nodeModules });
  const packageDir = path.join(bundle, 'package');
  if (!await directory(packageDir)) throw new Error('Runtime package directory is missing');
  ledger.push({ location: packageDir, stat: await fs.lstat(packageDir), type: 'directory' });
  let fileCount = 0;
  let directoryCount = 0;
  async function walk(location, prefix) {
    if (!await directory(location)) throw new Error('Missing runtime package directory');
    const entries = await fs.opendir(location, { bufferSize: 16 });
    for await (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(location, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Runtime package contains a link');
      if (stat.isDirectory()) {
        if (!parsed.directories.has(relative) || ++directoryCount > parsed.directories.size) throw new Error('Unexpected runtime package directory');
        ledger.push({ location: absolute, stat, type: 'directory' });
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error('Runtime package contains a hard link');
        const expected = parsed.files.get(relative);
        if (!expected || ++fileCount > parsed.files.size) throw new Error('Unexpected runtime package file');
        const actual = await readFile(absolute, expected.length);
        if (!actual.bytes.equals(expected)) throw new Error(`Runtime package file mismatch: ${relative}`);
        ledger.push({ location: absolute, stat: actual.stat, type: 'file' });
      } else {
        throw new Error('Unsupported runtime package object');
      }
    }
  }
  await walk(packageDir, '');
  if (fileCount !== parsed.files.size || directoryCount !== parsed.directories.size) throw new Error('Runtime package files are missing');
  return ledger;
}

const RECOVERY_OBJECTS = ['packages', 'archives', 'selection.json'];

function unchangedObject(before, after) {
  return before === null ? after === null : after !== null && sameObject(before, after)
    && before.size === after.size && before.nlink === after.nlink
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function checkRecoveryGuards(guards) {
  for (const { location, stat } of guards) {
    if (!await directory(location) || !sameObject(stat, await fs.lstat(location))) {
      throw new Error(`Runtime recovery directory changed: ${location}`);
    }
  }
}

/** Rename the object itself, including a symlink. Never inspect its target or overwrite an unowned destination. */
async function moveRecoveryObject(source, destination, expected, guards) {
  const reservation = [];
  await checkRecoveryGuards(guards);
  if (!await directory(path.dirname(source)) || !await directory(path.dirname(destination))) {
    throw new Error('Missing runtime recovery directory');
  }
  const current = await statIfPresent(source);
  if (!current || !sameObject(expected, current)) throw new Error(`Runtime recovery object changed: ${source}`);
  try {
    if (expected.isDirectory()) await ownDirectory(destination, reservation);
    else await ownFile(destination, Buffer.alloc(0), reservation);
    await checkRecoveryGuards(guards);
    const sourceNow = await statIfPresent(source);
    const destinationNow = await statIfPresent(destination);
    if (!sourceNow || !sameObject(expected, sourceNow)
        || !destinationNow || !sameObject(reservation[0].stat, destinationNow)) {
      throw new Error('Runtime recovery source or destination changed');
    }
    // The destination is an exclusive, empty reservation. This does not follow a final symlink.
    await fs.rename(source, destination);
  } catch (error) {
    try { await removeOwned(reservation); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Runtime recovery move and reservation cleanup failed');
    }
    throw error;
  }
}

/** Stage first, retain the three reserved objects, publish caches, then commit the pointer last. */
async function recoverStore(root, prepare, signal) {
  aborted(signal);
  await directory(root, true);
  const rootGuard = { location: root, stat: await fs.lstat(root) };
  const previous = [];
  for (const name of RECOVERY_OBJECTS) {
    previous.push({ name, location: path.join(root, name), stat: await statIfPresent(path.join(root, name)) });
  }
  const ledger = [];
  const workspace = await fs.mkdtemp(path.join(root, '.recovery-'));
  const workspaceGuard = { location: workspace, stat: await fs.lstat(workspace), type: 'directory' };
  ledger.push(workspaceGuard);
  const guards = [rootGuard, workspaceGuard];
  const candidate = path.join(workspace, 'candidate');
  const quarantine = path.join(workspace, 'previous');
  const moved = [];
  const published = [];
  try {
    await ownDirectory(candidate, ledger);
    guards.push(ledger.at(-1));
    await ownDirectory(quarantine, ledger);
    guards.push(ledger.at(-1));
    const prepared = await prepare(candidate, ledger);
    await checkRecoveryGuards(guards);
    for (const entry of previous) {
      if (!unchangedObject(entry.stat, await statIfPresent(entry.location))) {
        throw new Error(`Runtime recovery object changed: ${entry.location}`);
      }
    }
    aborted(signal);
    for (const entry of previous) {
      await checkRecoveryGuards(guards);
      if (!unchangedObject(entry.stat, await statIfPresent(entry.location))) {
        throw new Error(`Runtime recovery object changed: ${entry.location}`);
      }
      if (!entry.stat) continue;
      aborted(signal);
      const saved = path.join(quarantine, entry.name);
      await moveRecoveryObject(entry.location, saved, entry.stat, guards);
      moved.push({ ...entry, saved });
    }
    for (const entry of prepared.objects.filter(entry => entry.name !== 'selection.json')) {
      aborted(signal);
      const destination = path.join(root, entry.name);
      await moveRecoveryObject(entry.location, destination, entry.stat, guards);
      published.push({ ...entry, destination });
    }
    if (prepared.verify) await prepared.verify();
    aborted(signal);
    const pointer = prepared.objects.find(entry => entry.name === 'selection.json');
    // No fallible work follows this commit. The private workspace retains the previous objects.
    await moveRecoveryObject(pointer.location, path.join(root, 'selection.json'), pointer.stat, guards);
    return prepared.result;
  } catch (error) {
    const failures = [error];
    for (const entry of [...published].reverse()) {
      try { await moveRecoveryObject(entry.destination, entry.location, entry.stat, guards); }
      catch (rollbackError) { failures.push(rollbackError); }
    }
    for (const entry of moved.filter(entry => entry.name !== 'selection.json')) {
      try { await moveRecoveryObject(entry.saved, entry.location, entry.stat, guards); }
      catch (rollbackError) { failures.push(rollbackError); }
    }
    // Do not restore a pointer if cache rollback failed. Keep all remaining objects for owner recovery.
    const pointer = moved.find(entry => entry.name === 'selection.json');
    if (pointer && failures.length === 1) {
      try { await moveRecoveryObject(pointer.saved, pointer.location, pointer.stat, guards); }
      catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length === 1) {
      try { await checkRecoveryGuards(guards); await removeOwned(ledger); }
      catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, `Runtime recovery failed; retained files at ${workspace}`);
    throw error;
  }
}

/** A disk-backed pinned runtime store. allowedPins is an array of pins. */
export class RuntimeStore {
  #root;
  #nodeModules;
  #fetcher;

  constructor({ root, nodeModules, fetcher = globalThis.fetch }) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')
        || path.resolve(root) === path.parse(root).root) throw new Error('Runtime root must be a dedicated absolute directory');
    if (typeof nodeModules !== 'string' || !path.isAbsolute(nodeModules) || nodeModules.includes('\0')) {
      throw new Error('Runtime nodeModules must be an absolute directory');
    }
    if (typeof fetcher !== 'function') throw new Error('Runtime fetcher must be a function');
    this.#root = path.resolve(root);
    this.#nodeModules = path.resolve(nodeModules);
    this.#fetcher = fetcher;
  }

  async #operation(callback) {
    const map = operations();
    if (map.has(this.#root)) throw new Error('Runtime store is busy');
    const token = Symbol();
    map.set(this.#root, token);
    try { return await callback(); } finally { if (map.get(this.#root) === token) map.delete(this.#root); }
  }

  async #layout(create = false) {
    if (!await directory(this.#root, create)) return false;
    await directory(path.join(this.#root, 'packages'), create);
    await directory(path.join(this.#root, 'archives'), create);
    return true;
  }

  #installed(pin, busy = operations().has(this.#root)) {
    const id = fingerprint(pin);
    return { state: 'installed', installed: true, version: pin.version, fingerprint: id,
      packageDir: path.join(this.#root, 'packages', id, 'package'), busy };
  }

  async selection() {
    return (await selectionSnapshot(this.#root)).selection;
  }

  async status(allowedPins) {
    return this.resolve(allowedPins);
  }

  async resolve(allowedPins) {
    const selection = await this.selection();
    const busy = operations().has(this.#root);
    if (!selection) return { state: 'absent', installed: false, busy };
    if (selection.state === 'uninstalled') return { state: 'uninstalled', installed: false, busy };
    if (!Array.isArray(allowedPins)) throw new Error('allowedPins must be an array of runtime pins');
    const pins = allowedPins.map(validatePin);
    const pin = pins.find(candidate => candidate.version === selection.version && fingerprint(candidate) === selection.fingerprint);
    if (!pin) throw new Error('Selected runtime is not an allowed pin');
    await this.#layout();
    const archive = await readFile(path.join(this.#root, 'archives', `${selection.fingerprint}.tgz`), MAX_ARCHIVE);
    checkArchive(archive.bytes, pin);
    const parsed = await parseArchive(archive.bytes);
    checkMetadata(parsed, pin);
    await inspectBundle(path.join(this.#root, 'packages', selection.fingerprint), parsed, this.#nodeModules);
    return this.#installed(pin);
  }

  async install(input, { signal, validate } = {}) {
    const pin = validatePin(input);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid runtime abort signal');
    if (validate !== undefined && typeof validate !== 'function') throw new Error('Invalid runtime validator');
    return this.#operation(async () => {
      aborted(signal);
      await this.#layout(true);
      const previous = await selectionSnapshot(this.#root);
      const id = fingerprint(pin);
      const archivePath = path.join(this.#root, 'archives', `${id}.tgz`);
      const bundlePath = path.join(this.#root, 'packages', id);
      const archiveExists = Boolean(await statIfPresent(archivePath));
      const bundleExists = Boolean(await statIfPresent(bundlePath));
      const bytes = archiveExists ? (await readFile(archivePath, MAX_ARCHIVE)).bytes : await download(pin, this.#fetcher, signal);
      checkArchive(bytes, pin);
      aborted(signal);
      const parsed = await parseArchive(bytes);
      checkMetadata(parsed, pin);
      aborted(signal);
      if (bundleExists) await inspectBundle(bundlePath, parsed, this.#nodeModules);
      const staged = [];
      let stage;
      let bundle;
      let stageArchive;
      try {
        if (!archiveExists || !bundleExists) {
          stage = await fs.mkdtemp(path.join(this.#root, '.stage-'));
          staged.push({ location: stage, stat: await fs.lstat(stage), type: 'directory' });
          stageArchive = path.join(stage, 'archive.tgz');
          await ownFile(stageArchive, bytes, staged);
        }
        if (!bundleExists) {
          bundle = path.join(stage, 'bundle');
          aborted(signal);
          await materializeBundle(bundle, parsed, this.#nodeModules, staged, signal);
          aborted(signal);
        }
        const candidate = bundleExists ? bundlePath : bundle;
        await inspectBundle(candidate, parsed, this.#nodeModules);
        aborted(signal);
        if (validate) await validate(path.join(candidate, 'package'), pin);
        aborted(signal);
        // A validator must not change the staged or cached package.
        await inspectBundle(candidate, parsed, this.#nodeModules);
        const retained = await readFile(archiveExists ? archivePath : stageArchive, MAX_ARCHIVE);
        checkArchive(retained.bytes, pin);
        if (!archiveExists) {
          aborted(signal);
          await directory(path.dirname(archivePath));
          // link is exclusive: it cannot replace an unexpected archive object.
          await fs.link(stageArchive, archivePath);
        }
        if (!bundleExists) {
          aborted(signal);
          const final = [];
          try {
            // Materialize exclusively from validated bytes. Never rename over a reserved directory.
            await materializeBundle(bundlePath, parsed, this.#nodeModules, final, signal);
            await inspectBundle(bundlePath, parsed, this.#nodeModules);
            // A complete, verified cache can survive cancellation before the selection commit.
            final.length = 0;
          } catch (error) {
            try { await removeOwned(final); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime publication and cleanup failed'); }
            throw error;
          }
        } else {
          await inspectBundle(bundlePath, parsed, this.#nodeModules);
        }
        await removeOwned(staged);
        staged.length = 0;
        aborted(signal);
        const result = this.#installed(pin, false);
        await replaceSelection(this.#root, { format: 1, state: 'installed', version: pin.version, fingerprint: id }, previous, signal);
        return result;
      } catch (error) {
        try { await removeOwned(staged); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Runtime installation and staging cleanup failed'); }
        throw error;
      }
    });
  }

  async repair(input, { signal, validate } = {}) {
    const pin = validatePin(input);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('Invalid runtime abort signal');
    if (validate !== undefined && typeof validate !== 'function') throw new Error('Invalid runtime validator');
    return this.#operation(() => recoverStore(this.#root, async (candidate, ledger) => {
      const packages = path.join(candidate, 'packages');
      const archives = path.join(candidate, 'archives');
      await ownDirectory(packages, ledger);
      const packagesStat = ledger.at(-1).stat;
      await ownDirectory(archives, ledger);
      const archivesStat = ledger.at(-1).stat;
      const id = fingerprint(pin);
      let cachedBytes;
      try {
        // The strict reader checks every ordinary parent and rejects a final archive symlink.
        const cached = await readFile(path.join(this.#root, 'archives', `${id}.tgz`), MAX_ARCHIVE);
        checkArchive(cached.bytes, pin);
        cachedBytes = cached.bytes;
      } catch {
        // A missing, corrupt, or unsafe cache is not a repair blocker. The staging store can download the pin.
      }
      aborted(signal);
      if (cachedBytes) await ownFile(path.join(archives, `${id}.tgz`), cachedBytes, ledger);
      const staged = new RuntimeStore({ root: candidate, nodeModules: this.#nodeModules, fetcher: this.#fetcher });
      await staged.install(pin, { signal, validate });
      const archive = await readFile(path.join(archives, `${id}.tgz`), MAX_ARCHIVE);
      checkArchive(archive.bytes, pin);
      const parsed = await parseArchive(archive.bytes);
      checkMetadata(parsed, pin);
      ledger.push(...await inspectBundle(path.join(packages, id), parsed, this.#nodeModules));
      ledger.push({ location: path.join(archives, `${id}.tgz`), stat: archive.stat, type: 'file' });
      const pointer = await selectionSnapshot(candidate);
      if (pointer.selection?.state !== 'installed' || pointer.selection.version !== pin.version
          || pointer.selection.fingerprint !== id) throw new Error('Staged runtime selection mismatch');
      ledger.push({ location: path.join(candidate, 'selection.json'), stat: pointer.stat, type: 'file' });
      return {
        objects: [
          { name: 'packages', location: packages, stat: packagesStat },
          { name: 'archives', location: archives, stat: archivesStat },
          { name: 'selection.json', location: path.join(candidate, 'selection.json'), stat: pointer.stat },
        ],
        verify: async () => {
          const retained = await readFile(path.join(this.#root, 'archives', `${id}.tgz`), MAX_ARCHIVE);
          checkArchive(retained.bytes, pin);
          await inspectBundle(path.join(this.#root, 'packages', id), parsed, this.#nodeModules);
        },
        result: this.#installed(pin, false),
      };
    }, signal));
  }

  async uninstall({ recover = false } = {}) {
    if (typeof recover !== 'boolean') throw new Error('Invalid runtime uninstall recovery option');
    return this.#operation(async () => {
      if (recover) {
        return recoverStore(this.#root, async (candidate, ledger) => {
          const location = path.join(candidate, 'selection.json');
          await ownFile(location, Buffer.from('{"format":1,"state":"uninstalled"}\n'), ledger);
          return {
            objects: [{ name: 'selection.json', location, stat: ledger.at(-1).stat }],
            result: { state: 'uninstalled', installed: false, busy: false },
          };
        });
      }
      await directory(this.#root, true);
      const previous = await selectionSnapshot(this.#root);
      // Commit the opt-out before cleanup. Never restore a pointer after partial deletion.
      await replaceSelection(this.#root, { format: 1, state: 'uninstalled' }, previous);
      await this.#layout();
      const packages = path.join(this.#root, 'packages');
      const archives = path.join(this.#root, 'archives');
      if (await directory(packages)) {
        const entries = await fs.opendir(packages, { bufferSize: 8 });
        for await (const entry of entries) {
          if (!HEX.test(entry.name)) throw new Error('Unexpected object in runtime packages');
          const archivePath = path.join(archives, `${entry.name}.tgz`);
          const archive = await readFile(archivePath, MAX_ARCHIVE);
          const { parsed } = await this.#ownedArchive(archive.bytes, entry.name);
          const ledger = await inspectBundle(path.join(packages, entry.name), parsed, this.#nodeModules);
          await removeOwned(ledger);
          await removeOwned([{ location: archivePath, stat: archive.stat, type: 'file' }]);
        }
        await fs.rmdir(packages);
      }
      if (await directory(archives)) {
        const entries = await fs.opendir(archives, { bufferSize: 8 });
        for await (const entry of entries) {
          if (!/^[a-f0-9]{64}\.tgz(?![\s\S])/.test(entry.name)) throw new Error('Unexpected object in runtime archives');
          const location = path.join(archives, entry.name);
          const archive = await readFile(location, MAX_ARCHIVE);
          await this.#ownedArchive(archive.bytes, entry.name.slice(0, -4));
          await removeOwned([{ location, stat: archive.stat, type: 'file' }]);
        }
        await fs.rmdir(archives);
      }
      return { state: 'uninstalled', installed: false, busy: false };
    });
  }

  async #ownedArchive(bytes, id) {
    const parsed = await parseArchive(bytes);
    const metadataBytes = parsed.files.get('package.json');
    if (!metadataBytes) throw new Error('Runtime package.json is missing');
    const metadata = JSON.parse(utf8.decode(metadataBytes));
    const pin = validatePin({ version: metadata.version,
      tarball: `https://registry.npmjs.org/billion-context-pi/-/billion-context-pi-${metadata.version}.tgz`, integrity: integrityOf(bytes) });
    if (fingerprint(pin) !== id) throw new Error('Runtime cache fingerprint mismatch');
    checkMetadata(parsed, pin);
    return { pin, parsed };
  }
}
