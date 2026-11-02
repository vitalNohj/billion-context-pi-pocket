import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionMessageEntry["message"];
/** [#336] Config for dropping oversized reasoning (thinking) parts from
 *  historical `compress` tool calls — exact alignment with opencode-acp #377.
 *  `compress` calls are hard-exempt from compression (their tool results are
 *  the anchors that keep block summaries addressable), so their thinking
 *  rides along every request as an unreclaimable context floor. This pass
 *  removes `thinking` parts at request time (persisted history is never
 *  modified) from closed-round compress messages whose total reasoning length
 *  exceeds `threshold`. A round is closed on ROUND EVIDENCE, not on user
 *  messages: the compress tool result must have arrived and at least one
 *  message must exist after it. The in-flight round (result still missing or
 *  still the last message) is never touched [#348]. */
export interface CompressReasoningConfig {
    /** Master switch. Default: true. `drop: false` disables the pass entirely
     *  (kill-switch; also the recipe for providers whose thinking items are
     *  opaque and must round-trip unmodified, e.g. set it per-provider under
     *  `compress.providers.<name>`). */
    drop?: boolean;
    /** Single-thinking size gate (chars): a closed-turn compress message's
     *  total reasoning length (summed across parts of that message) must
     *  STRICTLY EXCEED this to be dropped. Small thinkings are kept; lengths
     *  are NOT accumulated across messages. Default: 2048. `0` drops any
     *  non-empty reasoning (only zero-length reasoning survives). */
    threshold?: number;
}
export declare const DEFAULT_COMPRESS_REASONING: Required<CompressReasoningConfig>;
export declare function resolveReasoningDrop(cfg?: CompressReasoningConfig): Required<CompressReasoningConfig>;
/** [#361] Strict-echo thinking upstreams (DeepSeek thinking mode) require
 *  `reasoning_content` to round-trip verbatim across tool-call turns; a rebuilt
 *  request whose closed-round assistant messages lost their reasoning is rejected
 *  with HTTP 400 ("reasoning_content ... must be passed back"). Detect statically
 *  from the model's configured origin/name so the request-time drop pass stands
 *  down. Mirrors the proxy-side billion-context#690 detector, adapted to pi's
 *  signal sources: the in-process adapter does not own the HTTP layer, so there
 *  is no learn-on-400 self-heal here — see CONFIGURATION.md for the manual
 *  `drop:false` escape hatch (GLM-thinking / QwQ / self-hosted mirrors). */
export declare function isStrictReasoningEcho(provider?: string, baseUrl?: string): boolean;
/** [#361] Force the drop pass off on a strict-echo upstream so its reasoning
 *  round-trips unmodified. Pure: returns cfg unchanged when not strict-echo or
 *  already disabled. Cost-free for non-thinking models on those hosts — they emit
 *  no `thinking` parts, so the pass would be a no-op regardless. */
export declare function applyStrictReasoningGate(cfg: Required<CompressReasoningConfig>, provider?: string, baseUrl?: string): Required<CompressReasoningConfig>;
export declare function countThinkingChars(messages: AgentMessage[]): number;
/** Request-time pass aligned with opencode-acp #377: remove `thinking` parts
 *  from a message only when ALL gates hold —
 *  1. closed round [#348]: EVERY `compress` toolCall in the message has its
 *     tool-result message (role `toolResult`, matching `toolCallId`) at a
 *     later index, and at least one message exists after that result (the
 *     round has demonstrably moved on). A compress call without a result, or
 *     whose result is still the last message, is in flight and never touched
 *     — no user message is required, so long agentic sessions do close
 *     rounds; a synthetic nudge pushed later cannot retroactively close one;
 *  2. selector: the message carries a `toolCall` part with name "compress"
 *     (only compress; other protected tools would need their own explicit
 *     config);
 *  3. size: the message's total reasoning length strictly exceeds
 *     `threshold` chars (summed across parts, never across messages).
 *  Pure: never mutates the input; idempotent; fail-safe (any error returns
 *  the input unchanged). */
export declare function dropCompressReasoning(messages: AgentMessage[], cfg?: CompressReasoningConfig): AgentMessage[];
export {};
