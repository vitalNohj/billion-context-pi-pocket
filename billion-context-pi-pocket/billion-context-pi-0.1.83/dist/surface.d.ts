import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AdapterConfig } from "./config.js";
export interface ToolPromptOverrides {
    description?: string;
    paramDescriptions?: Record<string, string>;
    promptSnippet?: string;
    promptGuidelines?: string | string[];
}
export type AcpToolName = "compress" | "decompress" | "search_context" | "acp_status" | "acp_cache";
export type ToolPromptsConfig = Partial<Record<AcpToolName, ToolPromptOverrides>>;
export type NudgeSectionsConfig = Partial<Record<"efficiencyNote" | "emergencyHeader" | "t2Guidance" | "t3Guidance", string | null>>;
export declare function sanitizeToolPrompts(raw: unknown): ToolPromptsConfig;
export declare function sanitizeNudgeSections(raw: unknown): NudgeSectionsConfig;
export declare function applyToolPromptOverrides<TParams extends TSchema>(def: ToolDefinition<TParams>, overrides?: ToolPromptOverrides): ToolDefinition<TParams>;
export declare function readToolSurfaceSync(cwd: string): ToolPromptsConfig;
export declare function sanitizeSurfaceConfig(adapter: AdapterConfig): AdapterConfig;
