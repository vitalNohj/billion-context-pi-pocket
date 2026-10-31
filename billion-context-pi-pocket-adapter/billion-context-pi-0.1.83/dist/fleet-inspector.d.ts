import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type FleetRunView } from "./delegate-tool.js";
export interface InspectorTheme {
    fg(color: string, text: string): string;
    bold(text: string): string;
    bg(color: string, text: string): string;
    italic?(text: string): string;
    underline?(text: string): string;
    strikethrough?(text: string): string;
}
export declare function formatDuration(ms: number): string;
export declare function statusIcon(status: FleetRunView["status"]): string;
export declare function usageSummary(usage: FleetRunView["usage"]): string | undefined;
export interface ListRow {
    run: FleetRunView;
    label: string;
    detail: string;
}
export declare function buildListRows(runs: FleetRunView[], now: number): ListRow[];
/** Last maxBytes of a file as utf8; a partial leading line is dropped so the
 *  tail always starts on a line boundary. Missing/unreadable → "". */
export declare function readTailSync(file: string | undefined, maxBytes: number): string;
/** First maxBytes of a file as utf8. Missing/unreadable → "". */
export declare function readHeadSync(file: string | undefined, maxBytes: number): string;
export interface TranscriptBlock {
    kind: "user" | "thinking" | "text" | "toolCall" | "toolResult" | "meta";
    name?: string;
    text: string;
    isError?: boolean;
    args?: unknown;
}
/** Pi-style one-line summary of a tool call (mirrors pi's formatToolCall). */
export declare function formatToolLabel(name: string, args: unknown): string;
/** Parse a pi session .jsonl into display blocks (conversation + thinking + tools). */
export declare function parseSessionJsonl(raw: string): TranscriptBlock[];
export declare function renderListBody(rows: ListRow[], selIdx: number, theme: InspectorTheme, innerW: number): string[];
export declare function renderTranscriptBlocks(blocks: TranscriptBlock[], theme: InspectorTheme, innerW: number): string[];
/** Plain-text snapshot for non-TUI hosts (rpc/print/json). */
export declare function buildSnapshotText(runs: FleetRunView[], now: number): string;
/** Open the live fleet inspector: bordered TUI overlay in interactive mode,
 *  plain-text snapshot notification elsewhere. Resolves when the user closes it. */
export declare function openFleetInspector(ctx: ExtensionContext): Promise<void>;
