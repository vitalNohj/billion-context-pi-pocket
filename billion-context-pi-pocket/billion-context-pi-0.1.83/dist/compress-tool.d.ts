import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { type ToolPromptOverrides } from "./surface.js";
import { type CompressionBlock, type CompressionState } from "acp-kernel";
declare const RangeSpec: Type.TObject<{
    startId: Type.TString;
    endId: Type.TString;
    summary: Type.TString;
    topic: Type.TOptional<Type.TString>;
}>;
declare const CompressParams: Type.TObject<{
    topic: Type.TOptional<Type.TString>;
    content: Type.TUnion<[Type.TArray<Type.TObject<{
        startId: Type.TString;
        endId: Type.TString;
        summary: Type.TString;
        topic: Type.TOptional<Type.TString>;
    }>>, Type.TString]>;
    summaryMaxChars: Type.TOptional<Type.TNumber>;
}>;
type CompressArgs = Static<typeof CompressParams>;
export declare function makeCompressTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides): ToolDefinition<typeof CompressParams>;
type RangeEntry = Static<typeof RangeSpec>;
export declare function normalizeRanges(args: CompressArgs): RangeEntry[] | string;
export declare function tailRepair(s: string): string | undefined;
export declare function arrayWrapRepair(s: string): string | undefined;
/** Panel block count, or -1 for non-panels. Accepts BOTH the legacy
 *  "… B blocks)" form (0-block runs; historical transcripts replayed by
 *  index/floor-stale) and the #376 "… blocks: b3=m00044–m00097*, …" form. */
export declare function compressPanelBlocks(text: string): number;
/** Success = completed run that created >= 1 block (partial range errors
 *  still count: progress was made). A 0-block panel must NOT be success —
 *  it would reset the retry counter while the emergency nudge re-fires,
 *  looping no-op compressions (issue #6). */
export declare function isCompressSuccessText(text: string): boolean;
/** No-op = completed run that compressed nothing (0-block panel: every
 *  range skipped). Counted as a FAILED attempt by noteCompressOutcomes so
 *  the retry cap applies. Non-panels ("No ranges provided.") stay neutral. */
export declare function isCompressNoopText(text: string): boolean;
export declare function blockSpanLabel(block: CompressionBlock, state: CompressionState): string;
export declare function summaryFingerprintLine(blockId: string, summary: string): string;
export declare function tierReadyHint(state: CompressionState, config: ReturnType<AcpRuntime["configFor"]>): string;
export {};
