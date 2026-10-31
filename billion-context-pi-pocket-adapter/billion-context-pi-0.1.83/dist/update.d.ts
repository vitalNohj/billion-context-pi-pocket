export declare const readOnlyMarkerFile: (extDir: string) => string;
export type NpmRunner = (args: string[], opts: {
    cwd?: string;
    timeout: number;
}) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
export declare const runNpm: NpmRunner;
export declare function setRunNpmForTest(impl: NpmRunner): void;
export type NodeRunner = (args: string[], opts: {
    timeout: number;
}) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
export declare const runNode: NodeRunner;
export declare function setRunNodeForTest(impl: NodeRunner): void;
export declare function setInstalledSpecForTest(spec: string | null): void;
export declare function isAutoUpdatableSpec(spec: string): boolean;
/**
 * Registry dist-tag the auto-updater should track for a spec.
 * - `stable`, `dev`, `pr-327`, `latest` → that dist-tag
 * - ranges (`^1.2.3`, `>=1.0.0`, `*`) → `latest`
 * - exact pins / non-registry specs → undefined (never auto-update)
 * - exact *prerelease* versions → `latest`: npm records tag installs
 *   (`@pr-N`, `@dev`) as the resolved exact version, so without this
 *   fallback those users would freeze on a stale PR/dev build forever
 */
export declare function specUpdateTag(spec: string): string | undefined;
export declare function isVersionNewer(latest: string, current: string): boolean;
export declare function findNpmRoot(extDir: string): string | undefined;
export declare function findExtensionDir(): Promise<string | undefined>;
export type InstallOutcome = "ok" | "failed" | "rolled-back" | "read-only";
export declare function verifyInstall(npmDir: string, latest: string): Promise<{
    ok: boolean;
    reason?: string;
}>;
export declare function autoInstallLatest(latest: string, extDirOverride?: string): Promise<InstallOutcome>;
export declare function checkForUpdate(autoUpdate: boolean, notify?: (msg: string) => void): Promise<void>;
export declare function resetUpdateStateForTest(): void;
