import { Type } from "typebox";
import type { ExtensionContext, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { type ToolPromptOverrides } from "./surface.js";
import { type CacheSample } from "acp-kernel";
declare const CacheParams: Type.TObject<{
    detail: Type.TOptional<Type.TUnion<[Type.TLiteral<"summary">, Type.TLiteral<"full">]>>;
}>;
export declare function cacheSamples(entries: SessionEntry[]): CacheSample[];
export declare function cacheReportText(runtime: AcpRuntime, ctx: ExtensionContext, detail?: "summary" | "full"): Promise<string>;
export declare function makeCacheTool(runtime: AcpRuntime, overrides?: ToolPromptOverrides): ToolDefinition<typeof CacheParams>;
export {};
