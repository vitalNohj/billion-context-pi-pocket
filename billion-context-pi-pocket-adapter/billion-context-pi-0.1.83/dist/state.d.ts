import { type CompressionState } from "acp-kernel";
export declare const STATE_SUFFIX = ".acp.json";
export interface LiveRefOrigin {
    rawId: string;
    identity: string;
}
/** One-time marker persisted in a child sidecar when deriveChildState ran
 *  (#364): proves this session's state was explicitly derived from a parent,
 *  so later loads never re-derive. */
export interface DerivedFrom {
    parentSessionId: string;
    derivedAt: number;
}
export declare function readParentSessionPath(sessionFile: string): Promise<string | undefined>;
export declare class SessionStateStore {
    private cache;
    load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState>;
    /** Stamp the effective prompt pack for the live session (audit trail:
     *  persisted into the sidecar on the next save). */
    setActivePack(sessionFile: string | undefined, sessionId: string, activePack: string): void;
    getActivePack(sessionFile: string | undefined, sessionId: string): string | undefined;
    save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void>;
    getLiveRefOrigins(sessionFile: string | undefined, sessionId: string): LiveRefOrigin[];
    setLiveRefOrigins(sessionFile: string | undefined, sessionId: string, origins: LiveRefOrigin[]): void;
    getDerivedFrom(sessionFile: string | undefined, sessionId: string): DerivedFrom | null;
    setDerivedFrom(sessionFile: string | undefined, sessionId: string, mark: DerivedFrom | null): void;
    invalidate(): void;
    private tryLoadParentState;
}
/** #364: derive an INLINE child session's compression state from its parent's
 *  (same-process sub-sessions, e.g. Prime RLM). Inherits exactly what makes
 *  inherited blocks usable — blocks (deep-copied: they carry mutable fields),
 *  message refs, the per-message token snapshot, the id counters so new
 *  child blocks cannot collide with inherited ids, and the persistent
 *  acp_rule reminders (kernel cloneState precedent: never silently drop
 *  model-set rules) — and resets every rhythm ledger (nudge cadence
 *  baseline, stats counters, absorb records) so the
 *  child starts its own clock. Separate-process pi-native delegates must NOT
 *  use this: their session files carry a parentSession header that already
 *  inherits the parent state verbatim. */
export declare function deriveChildState(parent: CompressionState): CompressionState;
export declare function parseLiveRefOrigins(value: unknown): LiveRefOrigin[];
