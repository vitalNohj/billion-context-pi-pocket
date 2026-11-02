import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionMessageEntry["message"];
/** [#351] Character-level degenerate-repeat guard. Models occasionally
 *  degenerate into long single-codepoint runs (observed in the wild: a
 *  5968-char thinking block ending in 4655 consecutive 「【」, escalating over
 *  turns until the turn aborts). This is distinct from `repetitionGuard`
 *  (issue #308), which breaks byte-identical TOOL-CALL loops; here the
 *  attractor is inside the generated text/thinking itself.
 *
 *  Why the adapter must act: pi replays prior assistant thinking back to the
 *  provider on every subsequent request (openai-completions sends it as
 *  `reasoning_content`, or as plain text when `requiresThinkingAsText`), and
 *  an aborted turn's partial message persists in the session log. A
 *  degenerated tail therefore rides along every later prompt, where the model
 *  sees its own previous output ending in thousands of repeated characters —
 *  a continuation bias that re-triggers the same degeneration, aborting the
 *  next turn too. The session dies in an abort loop with no recovery path.
 *
 *  The pass below collapses runs >= minRun in assistant text/thinking of the
 *  OUTGOING view (persisted history is never modified) and appends a one-shot
 *  recovery notice while the degenerated message is the most recent assistant
 *  turn. Position-based self-limiting: a fresh model turn makes the old
 *  message non-last, so the notice stops appearing without any persistent
 *  state (and cannot accumulate — #223 lesson). */
export interface DegenerationGuardConfig {
    /** Master switch. Default: true. `false` disables the pass entirely
     *  (kill-switch). */
    enabled?: boolean;
    /** Minimum length of a single-codepoint run (counted in codepoints) before
     *  it is treated as degeneration. Legitimate single-char runs in coding
     *  sessions (markdown hrules, dotted leaders, comment banners) stay well
     *  under this; observed pre-degeneration drift maxed at ~60 before the
     *  catastrophic 4655×「【」 run. Default: 200. Values below 8 are raised to
     *  8: the collapse marker must stay shorter than any detectable run, and a
     *  sub-8 threshold would start matching ordinary dotted leaders/hrules. */
    minRun?: number;
}
export declare const DEFAULT_DEGENERATION_GUARD: Required<DegenerationGuardConfig>;
/** Resolve the guard config, handling the boolean shorthand (`false`
 *  disables). Invalid minRun values (< 2 or non-numeric) fall back to the
 *  default with a logged warning — they never fail the session. Valid values
 *  below MIN_VALID_MIN_RUN are raised to it. */
export declare function resolveDegenerationGuard(cfg?: boolean | DegenerationGuardConfig): Required<DegenerationGuardConfig>;
/** One maximal run of a repeated codepoint. */
export interface DegenerateRun {
    /** The repeated codepoint (string of length 1 or 2 — surrogate pairs kept whole). */
    char: string;
    /** Run length in codepoints. */
    count: number;
    /** UTF-16 index of the run start in the original string. */
    index: number;
}
/** Find maximal runs of a single repeated codepoint with length >= minRun.
 *  Codepoint-safe: surrogate pairs count as one unit, so a run of astral
 *  characters is detected like any other. Returns [] for empty input or
 *  minRun < 2 (a "run" shorter than 2 carries no signal). */
export declare function findDegenerateRuns(text: string, minRun: number): DegenerateRun[];
/** Collapse every degenerate run in `text` into a short marker that names the
 *  character and its original count. Pure, idempotent, fail-safe. Returns the
 *  input unchanged when there is nothing to collapse. */
export declare function collapseDegenerateRuns(text: string, minRun: number): string;
/** Evidence of one rewritten message: which blocks changed and what was collapsed. */
export interface CollapseEvidence {
    /** Index of the rewritten message in the input array. */
    msgIndex: number;
    /** Block kinds rewritten ("content" for string content, else "text"/"thinking"). */
    blocks: string[];
    /** Runs collapsed across those blocks. */
    runs: DegenerateRun[];
}
/** Request-time pass: collapse degenerate single-codepoint runs in ASSISTANT
 *  messages' text/thinking blocks (string content included). Every position is
 *  scanned — including the current turn's partial assistant message, which is
 *  exactly the one pi will replay back to the provider on the next request.
 *  Tool-call arguments are never touched (rewriting them would desync the
 *  model's view from the call that actually executed). Pure: returns the same
 *  array reference when nothing changed; idempotent; fail-safe (any error
 *  returns the input unchanged). Persisted history is never modified. */
export declare function collapseAssistantDegeneration(messages: AgentMessage[], cfg?: boolean | DegenerationGuardConfig): {
    messages: AgentMessage[];
    evidence: CollapseEvidence[];
};
/** Scan backward for the LAST assistant message and collect its degenerate
 *  runs. Call it with the PERSISTED originals in session order (not the
 *  outgoing view): thinking-only aborted turns never reach the outgoing view
 *  (projectMessage drops them), yet they are still "the previous turn".
 *  Returns null when absent or clean. Gates the recovery notice: because the
 *  notice fires only while the degenerated message is the most recent
 *  assistant turn, it self-limits — once the model produces a new turn the
 *  old message is no longer last and the notice disappears on the next
 *  rebuild (no persistent state needed). */
export declare function lastAssistantRuns(messages: AgentMessage[], minRun: number): DegenerateRun[] | null;
/** One-shot recovery notice appended while a degenerated assistant message is
 *  the most recent turn: tells the model the repeated segment carries no
 *  information and was truncated, and to resume from the last valid step
 *  instead of continuing the attractor. */
export declare function degenerationNotice(runs: DegenerateRun[]): AgentMessage;
export {};
