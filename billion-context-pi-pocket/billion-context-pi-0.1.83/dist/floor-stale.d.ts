import type { CompressionBlock } from "acp-kernel";
type UsageLike = {
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
} | null | undefined;
type AnchorEntry = {
    type: string;
    message?: {
        role?: string;
        stopReason?: string;
        usage?: UsageLike;
        toolName?: string;
        toolCallId?: string;
        isError?: boolean;
        content?: unknown;
    };
};
/** True when the last valid assistant usage anchor comes strictly BEFORE the
 *  last successful compress toolResult — the host's provider-usage number
 *  still reflects the pre-compression request. Failed/no-op compresses don't
 *  count (nothing was reclaimed). */
export declare function usageAnchorPredatesCompression(entries: AnchorEntry[]): boolean;
export interface AnchorStaleness {
    predates: boolean;
    netReclaimed: number;
}
export declare function compressionAnchorStaleness(entries: AnchorEntry[], blocks: readonly CompressionBlock[], countTokens: (text: string) => number): AnchorStaleness;
export {};
