/** Owner menu. Uses only Pocket's public browser API; no copy of Preact or private application UI. */
export const pocketApi = 1;

export default function setup(pocket) {
    const { html, useEffect, useRef, useState } = pocket;
    const bytes = (value) => Number.isFinite(value) ? `${(value / 1024 / 1024).toFixed(1)} MB` : 'a few MB';

    function Settings() {
        const [source, setSource] = useState(() => pocket.conversationId());
        const [revision, setRevision] = useState(0);
        const [data, setData] = useState(null);
        const [loading, setLoading] = useState(true);
        const [busy, setBusy] = useState('');
        const [error, setError] = useState('');
        const [confirmRemove, setConfirmRemove] = useState(false);
        const [repairOffered, setRepairOffered] = useState(false);
        const [licenses, setLicenses] = useState(null);
        const lifetime = useRef(new AbortController());
        const operation = useRef(null);
        const latestSource = useRef(source);
        latestSource.current = source;

        useEffect(() => pocket.onConversation(setSource), []);
        useEffect(() => pocket.on('changed', () => setRevision(value => value + 1)), []);
        useEffect(() => pocket.onSettings(() => setRevision(value => value + 1)), []);
        useEffect(() => () => { lifetime.current.abort(); operation.current?.abort(); }, []);
        useEffect(() => {
            const stop = new AbortController();
            setLoading(true);
            setError('');
            setData(null);
            const path = source === null ? 'status' : `status/${encodeURIComponent(source)}`;
            pocket.api(path, undefined, { signal: stop.signal }).catch(failure => {
                // Private PiP and inaccessible source bindings expose no chat controls.
                if (source !== null && failure.status === 404 && !stop.signal.aborted) {
                    return pocket.api('status', undefined, { signal: stop.signal });
                }
                throw failure;
            }).then(value => {
                if (!stop.signal.aborted) setData(value);
            }, failure => {
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
                if (!stop.signal.aborted && latestSource.current === originalSource) {
                    setConfirmRemove(false);
                    if (path.startsWith('runtime/')) setRepairOffered(false);
                    setRevision(value => value + 1);
                }
            } catch (failure) {
                if (!stop.signal.aborted) {
                    setError(failure.message || String(failure));
                    if (path.startsWith('runtime/')) setRepairOffered(true);
                }
            } finally {
                if (operation.current === stop) operation.current = null;
                if (!lifetime.current.signal.aborted) setBusy('');
            }
        }
        async function showLicenses(event) {
            if (!event.currentTarget.open || licenses !== null) return;
            try { setLicenses((await pocket.api('licenses', undefined, { signal: lifetime.current.signal })).text); }
            catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message || String(failure)); }
        }

        const program = data?.runtime;
        const session = data?.session;
        const unavailable = Boolean(busy || loading || program?.busy);
        const installed = program?.installed === true;
        const action = !program?.managed ? 'Install' : program.updateAvailable ? 'Update' : 'Reinstall';
        return html`<div style=${{ padding: '16px', display: 'grid', gap: '18px' }}>
            ${error && html`<div class="error-box" role="alert">${error}</div>`}
            ${loading && html`<${pocket.Loader} label="Checking Billion context" />`}
            ${busy && html`<${pocket.Loader} label=${busy} />`}
            ${program && html`<section style=${{ display: 'grid', gap: '10px' }}>
                <h3 style=${{ margin: 0 }}>Billion context</h3>
                <p style=${{ margin: 0 }}>${installed ? `Installed: ${program.version}` : 'Not installed'}
                    ${program.state === 'legacy' ? html`<span class="muted"> · using your existing copy</span>` : null}
                </p>
                ${program.error && html`<div class="error-box">${program.error}</div>`}
                <p class="muted small" style=${{ margin: 0 }}>
                    ${action} uses reviewed version ${program.availableVersion}, not an unverified “latest”.
                    Downloads ${bytes(program.downloadBytes)} from ${program.host}.
                    Allow about ${bytes(2 * ((program.downloadBytes || 0) + (program.diskBytes || 0)))} during installation.
                    Older versions stay cached until Uninstall. No npm install scripts run.
                </p>
                <div style=${{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button class="button primary" disabled=${unavailable}
                        onClick=${() => perform('runtime/install', {}, 'Downloading and checking Billion context')}>${action}</button>
                    ${!['absent', 'uninstalled'].includes(program.state) && html`<button class="button" disabled=${unavailable}
                        onClick=${() => setConfirmRemove(true)}>Uninstall</button>`}
                    ${(program.error || repairOffered) && html`<button class="button" disabled=${unavailable}
                        onClick=${() => perform('runtime/repair', {}, 'Repairing the program; keeping your history')}>Repair installation</button>`}
                    <button class="button" disabled=${Boolean(busy)} onClick=${() => setRevision(value => value + 1)}>Refresh</button>
                </div>
                ${program.busy && !busy && html`<p class="muted small">Another installation is in progress.</p>`}
                ${confirmRemove && html`<div class="error-box" style=${{ display: 'grid', gap: '10px' }}>
                    <span>Remove the downloaded program? Your chats, ACP history, settings, and any repair backups stay. Pocket will manage context normally until you install it again.</span>
                    <div style=${{ display: 'flex', gap: '8px' }}>
                        <button class="button" disabled=${unavailable}
                            onClick=${() => perform('runtime/uninstall', {}, 'Removing the program; keeping your history')}>Confirm uninstall</button>
                        <button class="button" disabled=${Boolean(busy)} onClick=${() => setConfirmRemove(false)}>Cancel</button>
                    </div>
                </div>`}
            </section>`}
            ${session && html`<section style=${{ display: 'grid', gap: '12px', borderTop: '1px solid var(--line)', paddingTop: '16px' }}>
                <h3 style=${{ margin: 0 }}>This chat</h3>
                <${pocket.Switch} label="Billion context in this chat" on=${Boolean(session.enabled)}
                    disabled=${unavailable || (!installed && !session.enabled)}
                    onChange=${() => perform(`session/${encodeURIComponent(session.id)}`, { enabled: !session.enabled }, 'Saving chat setting')} />
                <label style=${{ display: 'grid', gap: '6px' }}>
                    <span>When switched off</span>
                    <select class="button" value=${session.usesDefaultOffBehavior ? 'default' : session.offBehavior} disabled=${unavailable}
                        onChange=${event => perform(`session/${encodeURIComponent(session.id)}`, { offBehavior: event.currentTarget.value === 'default' ? null : event.currentTarget.value }, 'Saving chat setting')}>
                        <option value="default">Use extension default (${data.defaultOffBehavior === 'keep-summaries' ? 'Keep summaries' : 'Restore original history'})</option>
                        <option value="restore-history">Restore original history — Pocket manages context</option>
                        <option value="keep-summaries">Keep summaries — stop new compression</option>
                    </select>
                </label>
                <p class="muted small" style=${{ margin: 0 }}>
                    Changes affect the next model request, not a response already streaming.
                    Neither choice deletes your saved history.
                    “Restore original history” uses your current Pocket compaction settings. It does not enable compaction or force an immediate summary.
                    Very large histories can still exceed the model’s limit. If that happens, choose Keep summaries.
                </p>
                ${!installed && html`<p class="muted small">Install the program to activate Billion context. If it is unavailable, you can still switch this chat off and choose Restore history.</p>`}
            </section>`}
            ${data && !session && html`<p class="muted small">Open this menu from a regular chat to change that chat’s on/off setting.</p>`}
            <section class="muted small" style=${{ borderTop: '1px solid var(--line)', paddingTop: '12px' }}>
                <p>Uses <a href="https://github.com/ranxianglei/billion-context-pi" target="_blank" rel="noopener noreferrer">billion-context-pi</a>
                    and <a href="https://github.com/ranxianglei/acp-kernel" target="_blank" rel="noopener noreferrer">acp-kernel</a> by ranxianglei.
                    Related project: <a href="https://github.com/ranxianglei/billion-context" target="_blank" rel="noopener noreferrer">billion-context</a>.</p>
                <p>Set the default off behavior under Menu → Extensions, in this extension’s settings. Each chat can override it here.</p>
                <details onToggle=${showLicenses}><summary>Licenses and notices</summary>
                    <pre style=${{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '320px', overflow: 'auto' }}>${licenses ?? 'Loading notices…'}</pre>
                </details>
            </section>
        </div>`;
    }
    pocket.sheet({ id: 'settings', title: 'Billion context', component: Settings });
    pocket.menu({ id: 'billion-context', label: 'Billion context', sheet: 'settings' });
}
