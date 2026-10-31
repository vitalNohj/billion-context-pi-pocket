export interface ExportOptions {
    output?: string;
    full?: boolean;
}
export interface SessionSummary {
    id: string;
    title?: string;
    label?: string;
    savedAt?: number;
    contextTokens?: number;
    blocks: number;
}
export declare function listSessions(sessionDir: string): Promise<SessionSummary[]>;
export declare function exportSession(selector: string | undefined, opts: ExportOptions, sessionDir: string): Promise<string>;
export declare function parseExportArgs(args: string): {
    selector?: string;
    full: boolean;
    output?: string;
    error?: string;
};
