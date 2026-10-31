import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
/** Which session-entry source API the host exposes (same precedence as readContextEntries). */
export type EntrySourceKind = "buildContextEntries" | "getBranch";
export declare function entrySourceOf(sm: ExtensionContext["sessionManager"]): EntrySourceKind | null;
/**
 * Whether the host declared itself a Pi-compatible fork via environment.
 *
 * The SessionManager shape alone cannot distinguish e.g. Prime from OMP — both are
 * Pi forks exposing `getBranch()` but not `buildContextEntries()` — so an
 * unsupported shape requires an explicit declaration before the adapter runs.
 * Read at call time so hosts can set it per-launch. See docs/host-adapter.md.
 */
export declare function isDeclaredForkHost(): boolean;
/** Unsupported host: not Pi-shaped and not declared as a fork. OMP stays blocked by default. */
export declare function isUnsupportedHost(sm: ExtensionContext["sessionManager"]): boolean;
