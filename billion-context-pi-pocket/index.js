/** Owner menu. Uses only Pocket's public browser API; no copy of Preact or private application UI. */
export const pocketApi = 1;

const CREDITS = [
    ['billion-context-pi', 'https://github.com/ranxianglei/billion-context-pi'],
    ['acp-kernel', 'https://github.com/ranxianglei/acp-kernel'],
];
const MODES = [
    { value: 'default', label: 'Default' },
    { value: 'restore-history', label: 'Restore history' },
    { value: 'keep-summaries', label: 'Keep summaries' },
];
const MODE_TEXT = {
    'restore-history': 'Pi sees the original messages again, and Pocket’s own compaction settings apply.',
    'keep-summaries': 'Existing summaries stay. No new compression. Pi can still open the originals.',
};

export const bytes = (value) => Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(1)} MB` : 'a few MB';
export const tokens = (value) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value);
export function ago(time, now = Date.now()) {
    const minutes = Math.round((now - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : new Date(time).toLocaleDateString();
}

/** What the menu shows and which actions it offers, from the extension's status. Shared with the tests. */
export function model(data, failed = false) {
    const program = data?.runtime;
    const extension = data?.extension;
    const updates = data?.updates;
    if (!program) return undefined;
    const active = program.installed === true;
    const state = program.state === 'error' ? 'error' : active ? 'on' : 'off';
    const title = program.state === 'error' ? 'Needs repair'
        : active ? 'Active'
        : program.state === 'uninstalled' ? 'Uninstalled'
        : 'Not installed';
    const detail = program.state === 'error' ? program.error
        : program.state === 'uninstalled' ? 'Pocket manages context normally. Your saved history stays.'
        : !active ? `Downloads ${bytes(program.downloadBytes)} from ${program.host}. No install scripts run.`
        : program.state === 'legacy' ? 'Using the copy bundled with an older version. Install switches to the managed copy.'
        : null;
    // One primary action, named as the desktop app names it.
    const extensionUpdate = updates?.available === true && extension?.source === 'desktop';
    const primary = extensionUpdate ? { label: 'Update', path: 'updates/request', busy: 'Asking the desktop app to update' }
        : !program.managed ? { label: 'Install', path: 'runtime/install', busy: 'Downloading and checking the program' }
        : program.updateAvailable ? { label: 'Update', path: 'runtime/install', busy: 'Downloading and checking the program' }
        : { label: 'Reinstall', path: 'runtime/repair', busy: 'Reinstalling; keeping your history' };
    // Damage without a selected runtime still reports absent: a failed install offers Repair too.
    if (program.state === 'error' || failed) Object.assign(primary, { label: 'Repair', path: 'runtime/repair', busy: 'Repairing; keeping your history' });
    const canUninstall = ['installed', 'legacy', 'error'].includes(program.state);
    let update;
    if (updates?.requested !== undefined) update = { tone: 'busy', text: 'Waiting for the desktop app to update…' };
    else if (updates?.handled?.error) update = { tone: 'error', text: `Update failed: ${updates.handled.error}` };
    else if (updates?.error) update = { tone: 'error', text: `Last check failed: ${updates.error}` };
    else if (updates?.available) {
        // A new commit can keep the same BCP version: then only the extension changed.
        const bcp = updates.latest?.version;
        const next = bcp && bcp !== extension?.version ? `BCP ${bcp}` : 'An extension update';
        update = { tone: 'accent', text: extension?.source === 'desktop' ? `${next} is available.`
            : extension?.source === 'gallery' ? `${next} is in the repository. Menu → Extensions → Updates offers it after gallery review.`
            : `${next} is available. These files were copied by hand: replace them to update.` };
    } else if (updates?.checkedAt) update = { tone: 'muted', text: `Up to date · checked ${ago(updates.checkedAt)}` };
    return { program, extension, state, title, detail, primary, canUninstall, update, version: program.version ?? program.availableVersion };
}

/** The sheet's markup. `ui` holds the transient state; `on` the handlers. */
export function view(html, pocket, data, ui, on) {
    const m = model(data, ui.runtimeFailed);
    const session = data?.session;
    const stats = data?.stats;
    // A slow update check never blocks the program or chat controls. A background refresh of status that is already
    // shown does not either: disabling buttons for it drops a click that lands during the refresh.
    const locked = Boolean(ui.busy || m?.program.busy);
    const chatLocked = Boolean(ui.busy);
    const mode = session ? (session.usesDefaultOffBehavior ? 'default' : session.offBehavior) : 'default';
    const effective = session?.offBehavior ?? data?.defaultOffBehavior ?? 'restore-history';
    const saved = stats && stats.originalTokens > 0 ? Math.max(0, Math.round(100 * (1 - stats.summaryTokens / stats.originalTokens))) : 0;
    return html`<div class="bcp">
        ${ui.error && html`<div class="error-box" role="alert">${ui.error}</div>`}
        ${!m && ui.loading && html`<div class="bcp-card"><${pocket.Loader} label="Checking Billion context" /></div>`}
        ${m && html`<section class="bcp-card" aria-labelledby="bcp-program">
            <div class="bcp-head">
                <span class="bcp-dot" data-state=${m.state} aria-hidden="true"></span>
                <div class="bcp-grow">
                    <h3 id="bcp-program">${m.title}</h3>
                    <p class="muted small">billion-context-pi ${m.version}${m.extension?.source === 'desktop' ? ' · managed by the desktop app'
                        : m.extension?.source === 'gallery' ? ' · from the gallery' : ''}</p>
                </div>
            </div>
            ${m.detail && html`<p class=${m.state === 'error' ? 'bcp-note bcp-err' : 'bcp-note muted small'}>${m.detail}</p>`}
            ${ui.busy || m.program.busy ? html`<div class="bcp-busy"><${pocket.Loader} label=${ui.busy || 'Another installation is in progress'} /></div>` : null}
            ${ui.confirmRemove ? html`<div class="bcp-confirm" role="alertdialog" aria-label="Confirm uninstall">
                <p>Remove the downloaded program? Your chats, compression history, and settings stay. Pocket manages context normally until you install it again.</p>
                <div class="bcp-actions">
                    <button class="button bcp-danger" disabled=${locked} onClick=${on.uninstall}>Uninstall</button>
                    <button class="button" disabled=${Boolean(ui.busy)} onClick=${on.cancelRemove}>Cancel</button>
                </div>
            </div>` : html`<div class="bcp-actions">
                <button class="button primary" disabled=${locked} onClick=${() => on.act(m.primary.path, m.primary.busy)}>${m.primary.label}</button>
                ${m.canUninstall && html`<button class="button" disabled=${locked} onClick=${on.askRemove}>Uninstall</button>`}
                <button class="button" disabled=${Boolean(ui.checking)} onClick=${on.check}>${ui.checking ? 'Checking…' : 'Check for updates'}</button>
            </div>`}
            ${m.update && html`<p class="bcp-update small" data-tone=${m.update.tone}>${m.update.text}</p>`}
        </section>`}
        ${session && html`<section class="bcp-card" aria-labelledby="bcp-chat">
            <div class="bcp-head">
                <div class="bcp-grow">
                    <h3 id="bcp-chat">This chat</h3>
                    <p class="muted small">${session.enabled ? 'Older messages are summarized as the chat grows.' : 'Billion context is off here.'}</p>
                </div>
                <${pocket.Switch} label="Billion context in this chat" on=${Boolean(session.enabled)}
                    disabled=${chatLocked || (!m?.program.installed && !session.enabled)}
                    onChange=${() => on.session({ enabled: !session.enabled })} />
            </div>
            ${stats && stats.blocks > 0 && html`<dl class="bcp-stats">
                <div><dt>Summaries</dt><dd class="mono">${stats.blocks}</dd></div>
                <div><dt>Original</dt><dd class="mono">${tokens(stats.originalTokens)}</dd></div>
                <div><dt>Now</dt><dd class="mono">${tokens(stats.summaryTokens)}</dd></div>
                <div><dt>Saved</dt><dd class="mono">${saved}%</dd></div>
            </dl>`}
            <div class="bcp-field">
                <span class="small">When switched off</span>
                <div class="bcp-segments" role="radiogroup" aria-label="When switched off">
                    ${MODES.map((choice) => html`<label class=${mode === choice.value ? 'bcp-segment on' : 'bcp-segment'}>
                        <input type="radio" name="bcp-off" value=${choice.value} checked=${mode === choice.value} disabled=${chatLocked}
                            onChange=${() => mode !== choice.value && on.session({ offBehavior: choice.value === 'default' ? null : choice.value })} />
                        <span>${choice.label}</span>
                    </label>`)}
                </div>
                <p class="muted small">${mode === 'default' ? `Default: ${effective === 'keep-summaries' ? 'keep summaries' : 'restore history'}. ` : ''}${MODE_TEXT[effective]}</p>
            </div>
            ${!m?.program.installed && html`<p class="muted small">Install the program to turn it on. You can still switch this chat off.</p>`}
        </section>`}
        ${data && !session && html`<p class="muted small bcp-pad">Open this menu in a chat to change that chat’s settings.</p>`}
        <details class="bcp-more" onToggle=${on.toggleMore}>
            <summary class="small">About and licenses</summary>
            <div class="bcp-more-body small muted">
                <p>Uses ${CREDITS.map(([name, url], i) => html`${i ? ' and ' : ''}<a href=${url} target="_blank" rel="noopener noreferrer">${name}</a>`)} by ranxianglei.
                    The default off behavior is in Menu → Extensions, in this extension’s settings.</p>
                ${m && html`<p>Install uses reviewed version ${m.program.availableVersion}, pinned by hash. It downloads ${bytes(m.program.downloadBytes)} from ${m.program.host} and needs about ${bytes(2 * ((m.program.downloadBytes || 0) + (m.program.diskBytes || 0)))} while it installs.</p>`}
                <pre class="mono">${ui.licenses ?? 'Loading notices…'}</pre>
            </div>
        </details>
    </div>`;
}

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;
    if (typeof pocket.style === 'function') pocket.style('style.css');

    function Settings() {
        const [source, setSource] = useState(() => pocket.conversationId());
        const [revision, setRevision] = useState(0);
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [busy, setBusy] = useState('');
        const [error, setError] = useState('');
        const [confirmRemove, setConfirmRemove] = useState(false);
        const [licenses, setLicenses] = useState(null);
        const [checking, setChecking] = useState(false);
        const [runtimeFailed, setRuntimeFailed] = useState(false);
        const lifetime = useRef(new AbortController());
        const operation = useRef(null);
        const latestSource = useRef(source);
        latestSource.current = source;
        const refresh = () => setRevision((value) => value + 1);

        useEffect(() => pocket.onConversation(setSource), []);
        useEffect(() => pocket.on('changed', refresh), []);
        useEffect(() => pocket.onSettings(refresh), []);
        useEffect(() => () => { lifetime.current.abort(); operation.current?.abort(); }, []);
        useEffect(() => {
            const stop = new AbortController();
            setLoading(true);
            // Never show, or act on, another chat's controls while this chat's status loads.
            setData((value) => value?.session && String(value.session.id) !== String(source) ? null : value);
            const path = source === null ? 'status' : `status/${encodeURIComponent(source)}`;
            pocket.api(path, undefined, { signal: stop.signal }).catch((failure) => {
                // Private PiP and inaccessible source bindings expose no chat controls.
                if (source !== null && failure.status === 404 && !stop.signal.aborted) return pocket.api('status', undefined, { signal: stop.signal });
                throw failure;
            }).then((value) => {
                if (!stop.signal.aborted) setData(value);
            }, (failure) => {
                if (!stop.signal.aborted) setError(failure.message || String(failure));
            }).finally(() => {
                if (!stop.signal.aborted) setLoading(false);
            });
            return () => stop.abort();
        }, [source, revision]);

        async function perform(path, body, label) {
            if (operation.current) return;
            const stop = new AbortController();
            const originalSource = source;
            operation.current = stop;
            setError('');
            setBusy(label);
            try {
                await pocket.api(path, body, { signal: stop.signal });
                if (!stop.signal.aborted && latestSource.current === originalSource) setConfirmRemove(false);
                if (path.startsWith('runtime/')) setRuntimeFailed(false);
            } catch (failure) {
                if (!stop.signal.aborted) {
                    setError(failure.message || String(failure));
                    if (path.startsWith('runtime/')) setRuntimeFailed(true);
                }
            } finally {
                if (operation.current === stop) operation.current = null;
                if (!lifetime.current.signal.aborted) { setBusy(''); refresh(); }
            }
        }
        async function toggleMore(event) {
            if (!event.currentTarget.open || licenses !== null) return;
            try { setLicenses((await pocket.api('licenses', undefined, { signal: lifetime.current.signal })).text); }
            catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message || String(failure)); }
        }
        async function check() {
            if (checking) return;
            setChecking(true);
            setError('');
            try { await pocket.api('updates/check', {}, { signal: lifetime.current.signal }); }
            catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message || String(failure)); }
            finally { if (!lifetime.current.signal.aborted) { setChecking(false); refresh(); } }
        }
        function session(body) {
            // The sheet can follow another chat before its status loads: never change the wrong chat.
            if (!data?.session || String(data.session.id) !== String(latestSource.current)) return;
            perform(`session/${encodeURIComponent(data.session.id)}`, body, 'Saving chat setting');
        }
        return view(html, pocket, data, { busy, loading, error, confirmRemove, licenses, checking, runtimeFailed }, {
            act: (path, label) => perform(path, {}, label),
            check,
            askRemove: () => setConfirmRemove(true),
            cancelRemove: () => setConfirmRemove(false),
            uninstall: () => perform('runtime/uninstall', {}, 'Removing the program; keeping your history'),
            session,
            toggleMore,
        });
    }
    pocket.sheet({ id: 'settings', title: 'Billion context', component: Settings });
    pocket.menu({ id: 'billion-context', label: 'Billion context', sheet: 'settings' });
}
