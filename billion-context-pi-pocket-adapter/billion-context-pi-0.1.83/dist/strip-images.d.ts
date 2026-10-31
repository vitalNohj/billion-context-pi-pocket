import type { StripProtocol } from "acp-kernel/wire";
/** Map pi-ai's Api id to the kernel wire dialect. Only dialects the kernel
 *  strip primitive explicitly supports are mapped; everything else returns
 *  null (= no-op), so exotic or future APIs are never mangled. */
export declare function apiToStripProtocol(api: string | undefined): StripProtocol;
export interface StripImagesOutcome {
    /** Replacement body to send, or undefined when the payload is unchanged. */
    body?: unknown;
    /** Number of image parts removed (0 = untouched). */
    removed: number;
}
/** Strip historical images from a provider request body. Pure: returns
 *  { removed: 0 } (and NO body) when disabled, the protocol is unsupported,
 *  the body is not strip-shaped, or nothing is older than keepRecent. */
export declare function applyStripImages(body: unknown, api: string | undefined, settings: {
    enabled: boolean;
    keepRecent: number;
}): StripImagesOutcome;
