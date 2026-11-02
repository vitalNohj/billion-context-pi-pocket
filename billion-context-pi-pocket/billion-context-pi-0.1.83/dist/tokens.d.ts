import { type CompressionCore, type CompressionState, type Config, type CoreMessage } from "acp-kernel";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionMessageEntry["message"];
export declare function collectCoveredMessageIds(state: {
    blocks: {
        active: boolean;
        effectiveMessageIds: string[];
    }[];
}): Set<string>;
export declare const IMAGE_TOKEN_COST = 1600;
export declare function modelSupportsImages(model: unknown): boolean;
export declare function collectImageTokens(entries: {
    id: string;
    type?: string;
    message?: AgentMessage;
}[], visionCapable: boolean): Map<string, number>;
export declare function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>, imageTokensById?: Map<string, number>): number;
export declare function sentViewTokenCount(core: CompressionCore, messages: CoreMessage[], state: CompressionState, config: Config, prelim: number, imageTokensById?: Map<string, number>, systemPromptTokens?: number): {
    viewTokens: number;
    drifted: boolean;
};
export declare function adjustedTokenCount(core: CompressionCore, messages: CoreMessage[], state: CompressionState, config: Config, prelim: number, imageTokensById?: Map<string, number>, systemPromptTokens?: number): number;
/** Per-session record of the EXACT sent view measured off the previous real
 *  processTurn output (issue #561) — replaces re-running a probe processTurn
 *  (clone + full second pass over the whole history) on every steady-state
 *  turn. */
export interface SentViewMeterRecord {
    viewTokens: number;
    blocksLen: number;
    activeBlocks: number;
    limit: number;
    /** False when the measured view may be dishonest (post-truncation output,
     *  or the record is absent) — callers must then run the full probe. */
    usable: boolean;
}
/** Signature check for adopting the previous turn's measured view (issue #561):
 *  the meter describes LAST turn's (state, config); it is only transferable
 *  when nothing structural moved — same window, same block count, same active
 *  count. Any compress/decompress/sync between turns changes one of these and
 *  forces the full probe path for a turn. Pure function, unit-testable. */
export declare function sentViewMeterMatches(meter: SentViewMeterRecord | undefined, state: CompressionState, config: Config): boolean;
export {};
