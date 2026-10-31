export type HostConfigSurface = {
    CONFIG_DIR_NAME?: unknown;
    getAgentDir?: unknown;
};
/** Pi's name — the fallback, and what releases before fork-host resolution used on every host. */
export declare const PI_CONFIG_DIR_NAME = ".pi";
/**
 * Config directory name, resolved from the host package the extension runs under.
 *
 * Every path in this adapter is `<home|cwd>/<name>/…`, with the agent dir at
 * `~/<name>/agent` — Pi's layout, where CONFIG_DIR_NAME is ".pi". Resolution order:
 * 1. the host's CONFIG_DIR_NAME, if it is a single directory name (Pi);
 * 2. the parent of the host's getAgentDir(), if that is `~/<name>/agent` — Pi forks
 *    that do not re-export CONFIG_DIR_NAME, or export it with other semantics (Prime:
 *    CONFIG_DIR_NAME ".prime/agent", getAgentDir() ~/.prime/agent → ".prime");
 * 3. ".pi".
 * The namespace import is deliberate: a missing named export fails at link time
 * under plain Node ESM→CJS interop and as `undefined` under loader aliasing (#364).
 * It is the ONLY value import from the pi package. See docs/host-adapter.md §4.
 */
export declare function resolveConfigDirName(host: HostConfigSurface, home: string): string;
export declare const CONFIG_DIR_NAME: string;
/**
 * `<root>/<name>/<segments>` for a user-authored file (acp.json, prompt packs). When
 * `name` is not ".pi", an existing `<root>/.pi/<segments>` is still used while the
 * host's own path does not exist: earlier releases read ".pi" on every host, and Prime
 * users were told to put acp.json there (#467).
 */
export declare function userConfigPathIn(name: string, root: string, ...segments: string[]): string;
export declare function userConfigPath(root: string, ...segments: string[]): string;
/** Global then project acp.json; later entries override earlier ones. */
export declare function acpJsonFiles(cwd: string): string[];
