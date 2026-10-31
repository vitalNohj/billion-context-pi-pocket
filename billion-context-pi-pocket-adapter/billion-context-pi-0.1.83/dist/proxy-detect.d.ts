export declare function isBiliProxyBaseUrl(baseUrl: string | undefined): boolean;
/**
 * Shown (and logged) when the extension detects that the model's baseUrl
 * routes through the billion-context wire proxy and stands down. The proxy
 * runs compression server-side and owns the ref coordinate space, so running
 * ACP in-process on top of it would double-compress every request.
 */
export declare const PROXY_STAND_DOWN_MESSAGE: string;
/**
 * Shown (and logged) when a billion-context host-native entry owns this
 * process (issue #461): the native entry self-spawns an in-process proxy and
 * rewrites model API traffic at the fetch layer, so running ACP in-process on
 * top of it would double-compress every request. Its BILLION_CONTEXT_PROXY env
 * var is written only after the proxy is up (past the synchronous extension
 * load), and the fetch-layer rewrite keeps the configured baseUrl clean —
 * BILLION_CONTEXT_NATIVE, set synchronously at module evaluation by the native
 * entry (billion-context markNativeHost, #820/#824), is the only signal visible
 * at our checkpoints. `host` is the marker value ("pi", "opencode", …) — kept
 * in the text so a mismatched host is diagnosable from the warning alone.
 */
export declare function nativeStandDownMessage(host: string): string;
