export declare function countUnicodeEscapes(s: string): number;
export declare function decodeUnicodeEscapes(s: string): string;
export declare const UNESCAPE_THRESHOLD = 20;
export declare function sanitizeSummary(s: string): {
    text: string;
    unescaped: boolean;
};
export declare function findUnverifiableUserQuote(summary: string): string | null;
