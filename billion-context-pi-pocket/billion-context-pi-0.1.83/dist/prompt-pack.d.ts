import { builtinSource, createDirPackSource, createPackResolver, defaultPack, isValidPackName, leanPack, sanitizePackSurface } from "acp-kernel";
import type { Pack, PackResolver, PackSource, PackSurface, PromptPackFile, Prompts } from "acp-kernel";
import type { AdapterConfig } from "./config.js";
import { type PiPromptSections } from "./system-prompt.js";
import { type AcpToolName, type NudgeSectionsConfig, type ToolPromptsConfig } from "./surface.js";
export { builtinSource, createDirPackSource, createPackResolver, defaultPack, isValidPackName, leanPack, sanitizePackSurface };
export type { Pack, PackResolver, PackSource, PackSurface, PromptPackFile };
export declare function defaultPackSources(cwd: string): PackSource[];
export declare function packResolver(cwd: string): PackResolver;
export declare function discoverPack(name: string, cwd: string): Pack | null;
export declare function resolvePackName(adapter: AdapterConfig, provider?: string, modelId?: string): string;
export declare function resolveActivePack(adapter: AdapterConfig, cwd: string, provider?: string, modelId?: string, resolver?: PackResolver): Pack;
export interface SurfaceMeta {
    pack: string;
    packVersion?: string;
    host: string;
}
/** Surface meta from an already-resolved pack (avoids double resolution
 *  when the caller already holds the active Pack). */
export declare function surfaceMetaOf(pack: Pack, requested: string): SurfaceMeta;
/** Host-declared surface facts for the kernel's status reports (acp-kernel
 *  StatusReportMeta). Which pack is active is host policy — the kernel only
 *  renders what the host declares about the active surface. */
export declare function resolveSurfaceMeta(adapter: AdapterConfig, cwd: string, provider?: string, modelId?: string, resolver?: PackResolver): SurfaceMeta;
export interface PiToolExtras {
    promptSnippet?: string;
    promptGuidelines?: string[];
}
export type PiToolExtrasConfig = Partial<Record<AcpToolName, PiToolExtras>>;
export interface PiAdapterSurface {
    promptSections: Partial<PiPromptSections>;
    toolExtras: PiToolExtrasConfig;
    delegatePrompt?: string | null;
}
/**
 * Pi-specific part of a pack. `surface.adapters.pi` is opaque to the kernel,
 * so the adapter sanitizes it here: tri-state prompt sections restricted to
 * pi's section keys, per-tool extras with malformed fields dropped.
 */
export declare function piAdapterSurface(pack: Pack): PiAdapterSurface;
export interface InlineSurface {
    prompts?: Partial<Prompts>;
    promptSections?: Partial<PiPromptSections>;
    nudgeSections?: NudgeSectionsConfig;
    toolPrompts?: ToolPromptsConfig;
    delegatePrompt?: string | null;
}
export interface MergedSurface {
    prompts: Partial<Prompts>;
    promptSections: Partial<PiPromptSections>;
    nudgeSections: NudgeSectionsConfig;
    toolPrompts: ToolPromptsConfig;
    delegatePrompt?: string | null;
}
export declare function mergeSurface(pack: Pack | null, inline: InlineSurface): MergedSurface;
export declare function readToolSurfaceWithPacks(cwd: string): ToolPromptsConfig;
