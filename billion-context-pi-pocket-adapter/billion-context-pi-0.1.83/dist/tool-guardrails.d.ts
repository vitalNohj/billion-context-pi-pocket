import { type ExtensionAPI, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
export type BashToolResultEvent = Extract<ToolResultEvent, {
    toolName: "bash";
}>;
export declare function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent;
export declare function resolveBashTimeout(input: {
    timeout?: number;
}, defaultTimeout: number | undefined): number | undefined;
export declare function capToolOutput(content: ToolResultEvent["content"], maxBytes: number | undefined, fullPath?: string): ToolResultEvent["content"] | undefined;
export declare function detectBashTimeout(content: ToolResultEvent["content"]): number | undefined;
export declare function appendTimeoutNotice(content: ToolResultEvent["content"], secs: number): ToolResultEvent["content"];
export declare function canonicalStringify(value: unknown): string;
export declare function repetitionFingerprint(toolName: string, input: unknown): string;
export type RepetitionAction = "none" | "warn" | "abort";
export interface RepetitionDecision {
    action: RepetitionAction;
    count: number;
    fingerprint: string;
    toolName: string;
}
export declare class RepetitionTracker {
    private readonly thresholds;
    private lastFp;
    private count;
    constructor(thresholds: {
        warn: number;
        abort: number;
    });
    note(toolName: string, input: unknown): RepetitionDecision;
    reset(): void;
}
export declare function wireToolGuardrails(pi: ExtensionAPI, runtime: AcpRuntime): void;
