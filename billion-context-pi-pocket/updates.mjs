/**
 * Update checks for the extension's own files. Only an owner's click, or the desktop app acting as the owner, calls
 * check(). It reads public data from GitHub (api.github.com, raw.githubusercontent.com) and sends no user data.
 * The extension never replaces its own files: the gallery, the desktop app, or the owner does that.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const REPOSITORY = 'vitalNohj/billion-context-pi-pocket';
const BRANCH = 'main';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CHECK_TIMEOUT = 20_000;

/** Shared by every loaded copy of this module, so a check left running by a reloaded version cannot race the new one. */
const SHARED = globalThis[Symbol.for('billion-context-pi-pocket.updates')] ??= new Map();
const shared = (file) => {
  let value = SHARED.get(file);
  if (!value) SHARED.set(file, value = { queue: Promise.resolve(), running: undefined });
  return value;
};

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
};

/** Who installed these files decides who can update them. */
export function installedSource({ entryDir, helperDir, name, version }) {
  const gallery = readJson(join(entryDir, `${name}.gallery.json`));
  const galleryCommit = gallery?.entry?.source?.commit;
  if (typeof galleryCommit === 'string' && COMMIT.test(galleryCommit)) return { version, source: 'gallery', commit: galleryCommit };
  const desktop = readJson(join(helperDir, '.pi-pocket-gui.json'));
  if (typeof desktop?.commit === 'string' && COMMIT.test(desktop.commit)) return { version, source: 'desktop', commit: desktop.commit };
  return { version, source: 'manual' };
}

/** Wait for `work`, but let this caller stop waiting without cancelling it for the others. */
function waitFor(work, signal) {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export class UpdateState {
  #file;
  #fetch;
  #timeout;

  constructor({ root, fetcher = globalThis.fetch, timeout = CHECK_TIMEOUT }) {
    this.#file = join(root, 'updates.json');
    this.#fetch = fetcher;
    this.#timeout = timeout;
  }

  read() {
    const value = readJson(this.#file);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  /** Every write reads the newest state inside one queue, so a check never drops a request or its report. */
  #mutate(change) {
    const slot = shared(this.#file);
    const next = slot.queue.then(async () => {
      const value = change(this.read());
      if (value === undefined) return undefined;
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${randomUUID()}.next`;
      try {
        await writeFile(temporary, `${JSON.stringify(value.state, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, this.#file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return value.result;
    });
    slot.queue = next.catch(() => {});
    return next;
  }

  /** What the menu and the desktop app show. `installed` is installedSource(). */
  view(installed) {
    const saved = this.read();
    const latest = saved.latest && COMMIT.test(saved.latest.commit ?? '') ? saved.latest : undefined;
    const available = latest !== undefined && (installed.commit === undefined
      ? latest.version !== undefined && latest.version !== installed.version
      : latest.commit !== installed.commit);
    return {
      ...(typeof saved.checkedAt === 'number' ? { checkedAt: saved.checkedAt } : {}),
      ...(latest ? { latest } : {}),
      available,
      ...(typeof saved.error === 'string' ? { error: saved.error } : {}),
      ...(typeof saved.requested === 'number' ? { requested: saved.requested } : {}),
      ...(typeof saved.handled?.at === 'number' ? { handled: saved.handled } : {}),
    };
  }

  async #get(url, accept, signal) {
    const response = await this.#fetch(url, { headers: { accept, 'user-agent': 'billion-context-pi-pocket' }, redirect: 'follow', signal });
    if (!response.ok) {
      throw new Error(response.status === 403 || response.status === 429
        ? 'GitHub is limiting requests from this network. Try again later.'
        : `GitHub answered HTTP ${response.status}.`);
    }
    return response;
  }

  async #lookup() {
    const signal = AbortSignal.timeout(this.#timeout);
    try {
      const sha = (await (await this.#get(`https://api.github.com/repos/${REPOSITORY}/commits/${BRANCH}`, 'application/vnd.github.sha', signal)).text()).trim();
      if (!COMMIT.test(sha)) throw new Error('GitHub did not return a valid commit.');
      // Hand-copied files compare versions, so a check without the version is incomplete.
      const lock = await (await this.#get(`https://raw.githubusercontent.com/${REPOSITORY}/${sha}/billion-context-pi-pocket/runtime-lock.json`, 'application/json', signal)).json();
      if (typeof lock?.current !== 'string' || !VERSION.test(lock.current)) throw new Error('The newest version has no valid runtime-lock.json.');
      return { commit: sha, version: lock.current };
    } catch (error) {
      throw signal.aborted ? new Error('GitHub did not answer in time. Try again later.') : error;
    }
  }

  /** One check at a time, with its own time limit. A caller that stops waiting does not cancel it. */
  check(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    const slot = shared(this.#file);
    slot.running ??= (async () => {
      try {
        const latest = await this.#lookup();
        await this.#mutate(({ error: _old, ...saved }) => ({ state: { ...saved, checkedAt: Date.now(), latest } }));
      } catch (error) {
        const message = error?.message ?? String(error);
        await this.#mutate((saved) => ({ state: { ...saved, checkedAt: Date.now(), error: message } }));
        throw error;
      }
    })().finally(() => { slot.running = undefined; });
    // A caller that stopped waiting must not leave a failure unhandled.
    slot.running.catch(() => {});
    return waitFor(slot.running, signal);
  }

  /** Ask the desktop app, which installed these files, to update them. A new click is a new request. */
  request() {
    return this.#mutate((saved) => {
      const requested = Math.max(Date.now(), (saved.requested ?? 0) + 1);
      return { state: { ...saved, requested }, result: requested };
    });
  }

  /** The desktop app reports the end of a requested update. A stale report changes nothing. */
  async handled(requested, error) {
    return (await this.#mutate((saved) => {
      if (saved.requested !== requested) return undefined;
      const { requested: _done, ...rest } = saved;
      return { state: { ...rest, handled: { at: Date.now(), requested, ...(error ? { error } : {}) } }, result: true };
    })) === true;
  }
}
