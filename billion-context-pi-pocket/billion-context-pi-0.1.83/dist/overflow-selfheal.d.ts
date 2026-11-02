export declare const OVERFLOW_MARKER: RegExp;
export interface OverflowInfo {
    isOverflow: boolean;
    /** The real context window, when the provider stated it in the error. */
    window?: number;
    message: string;
}
export declare function inspectOverflowMessage(haystack: string | undefined | null): OverflowInfo;
export declare const NO_BODY_4XX_MARKER: RegExp;
export declare function isNoBody4xxError(haystack: string | undefined | null): boolean;
/** Corroboration threshold for arming on an ambiguous no-body 4xx: the
 *  calibrated sent-view estimate must be at least this fraction of the
 *  effective limit (same basis as the turn log's `pct`). */
export declare const NO_BODY_ARM_RATIO = 0.5;
/** Decision returned by OverflowEpisode.onNoBody4xx(). */
export interface NoBodyDecision {
    arm: boolean;
    /** Consecutive no-body 4xx errors since the last successful assistant turn. */
    consecutive: number;
    /** Recorded sent-view estimate / effective limit, when both were seen. */
    ratio: number | null;
}
/** Default cap on the output-headroom reservation, as a fraction of the
 *  context window (issue #207). Reserving the FULL registered max output
 *  capability halves the effective input budget on models whose maxTokens is a
 *  large share of the window (e.g. 131072 on a 262144 window → the 75% force-
 *  compress band fires at ~37% of the full window), while real per-turn
 *  replies rarely approach that. Capping at 25% keeps the guarantee where it
 *  matters — any single-turn reply up to the reserved amount still fits at the
 *  95% emergency threshold — while bounding the budget loss. A reply longer
 *  than the reservation overflows once; the overflow self-heal (learned window
 *  + armed emergency) recovers it on the next turn. */
export declare const DEFAULT_OUTPUT_HEADROOM_MAX_PCT = 0.25;
/** Resolve the user's `outputHeadroomMaxPct` (ratio or "N%" string) to a
 *  numeric cap, falling back to DEFAULT_OUTPUT_HEADROOM_MAX_PCT when unset.
 *  Shared by every headroom call site (context transform, /acp, acp_status)
 *  so they all measure against the SAME capped limit (issue #207/#267). */
export declare function resolveOutputHeadroomCap(value: number | string | undefined): number;
/**
 * Reserve the model's output budget from the context window, so the kernel's
 * nudge/truncate bands sit below (window - reserved) and the context leaves
 * room for the model's reply. This prevents the "context + output > window"
 * overflow on a small window (agents routinely set a large max output).
 *
 * `capPct` bounds the reservation as a fraction of the window: reserved =
 * min(maxOutput, capPct * window). The default (1) preserves the original
 * full-capability reservation; the adapter passes DEFAULT_OUTPUT_HEADROOM_MAX_PCT
 * (or the user's `outputHeadroomMaxPct`) so oversized registered capabilities
 * no longer eat most of the input budget (issue #207). capPct semantics:
 *   - 0            → no reservation (window returned unchanged)
 *   - (0, 1)       → reservation capped at capPct * window
 *   - >= 1         → legacy behavior (full maxOutput reserved)
 *   - non-finite   → legacy behavior (treated as "not provided")
 * Returns the window unchanged when maxOutput is not usable (non-positive,
 * non-finite, or >= window — a maxOutput >= window request is degenerate and is
 * left to the overflow self-heal).
 */
export declare function reserveOutputHeadroom(window: number, maxOutput: number, capPct?: number): number;
/**
 * Whether the OUTPUT budget should be reserved from the context window at
 * all. Anthropic's Messages API enforces the input limit INDEPENDENTLY of
 * max_tokens (the output budget is separate — input up to the window works
 * with any max_tokens), so reserving the model's output capability would
 * shift the nudge/truncate bands down by maxTokens on every session with no
 * safety gain (e.g. a 200k model with a 64k output budget would start
 * compressing around 136k). The OpenAI-family APIs count output against the
 * window, so the reservation is only needed there. Unknown APIs reserve
 * (conservative — a missed reservation at worst overflows once and the
 * self-heal corrects it).
 */
export declare function shouldReserveOutputHeadroom(api: string | undefined): boolean;
/**
 * Apply the output-headroom reservation to a resolved config's modelContextLimit
 * (see reserveOutputHeadroom / shouldReserveOutputHeadroom). Returns a NEW config
 * (never mutates the input) so the shared resolved config stays untouched. Used
 * by BOTH the live context transform and the read-only panel surfaces (/acp,
 * acp_status) so every percentage is measured against the SAME real request
 * limit — otherwise the panel reports against the full window while the nudge
 * bands run against (window − maxOutput) (issue #267).
 *
 * `capPct` bounds the reservation as a fraction of the window (see
 * reserveOutputHeadroom); callers pass resolveOutputHeadroomCap(
 * adapter.outputHeadroomMaxPct) so the panel and the nudge bands share the
 * same capped limit (issue #207). The default (1) preserves the legacy
 * full-capability reservation for callers that don't pass a cap.
 */
export declare function applyOutputHeadroom<T extends {
    modelContextLimit: number;
}>(config: T, model: {
    maxTokens?: number;
    api?: string;
} | undefined, capPct?: number): T;
export declare class OverflowEpisode {
    /** Real windows learned from overflow errors, keyed by model id. A learned
     *  window is model-specific: switching to a bigger model mid-session must
     *  not inherit the smaller model's learned limit (that would re-center the
     *  bands below the new model's real window → premature compression). */
    private learned;
    learnedWindowFor(modelId: string): number | null;
    setLearnedWindow(modelId: string, window: number): void;
    /** When true, the next context event forces usage >=95% (emergency). Kept
     *  session-scoped (not per-model): the context did not shrink, so the next
     *  turn needs the emergency regardless of which model answers it. */
    armed: boolean;
    /** Sent-view estimate + effective limit recorded by the context event —
     *  the numbers of the request that just ended. */
    private sentTokens;
    private sentLimit;
    /** Consecutive no-body 4xx errors since the last successful assistant
     *  turn. 0 at session start (the episode is created per session). */
    private noBody4xx;
    noteSentView(tokens: number, limit: number): void;
    /** A successful assistant turn unwedged the request loop: the consecutive
     *  no-body count restarts from zero. */
    noteSuccess(): void;
    /**
     * Record one ambiguous no-body 4xx and decide whether it corroborates a
     * probable context overflow. Guards against the false positive (the same
     * text serves non-overflow 4xx): arm only when the current sent-view
     * estimate is >= NO_BODY_ARM_RATIO of the effective limit, OR this is the
     * >=2nd consecutive no-body since the last success. The consecutive guard
     * recovers the dead-loop even at a low ratio (the incident ran at ~24%:
     * the estimate under-reported vs the input+max_tokens cap) — a genuine
     * overflow fails identically while the context is unchanged, so repeated
     * no-body errors with no successful turn in between are size-dependent by
     * construction. No window can be parsed from a bodyless error, so when
     * this arms, the emergency uses the already-resolved effective limit (no
     * window is learned).
     */
    onNoBody4xx(): NoBodyDecision;
    reset(): void;
}
