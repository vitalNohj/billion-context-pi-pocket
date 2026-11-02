import type { SessionEntry } from "@earendil-works/pi-coding-agent";
/** Parse a session jsonl into entries — mirrors pi's own loadEntriesFromFile
 *  (JSON.parse per line; blank and malformed lines skipped). */
export declare function parseSessionLog(text: string): SessionEntry[];
/** Read-only lookup of entries in ANCESTOR sessions (issue #531): a derived
 *  child session (Prime RLM inline) inherits blocks whose message ids exist
 *  only in the parent's session log, so decompress must fall back up the
 *  parentSession header chain. Walks upward from `sessionFile` (nearest
 *  ancestor first), cycle-safe and depth-capped like state inheritance, and
 *  returns entries whose base id is in `wantedBaseIds`. The starting session
 *  itself is never included; nearest-ancestor entries win on duplicate ids. */
export declare function loadAncestorEntries(sessionFile: string | undefined, wantedBaseIds: Set<string>): Promise<SessionEntry[]>;
/** Read-only content recovery for content-addressed `live-*` refs (issue
 *  #579): fork hosts alias not-yet-persisted tail messages with `live-*` ids
 *  (runtime.ts mergeLiveEntries); those aliases appear in NO jsonl, so the
 *  entry-id lookup above can never find them. The rawId→identity bridge lives
 *  in each session's OWN sidecar (liveRefOrigins). Walks the chain — itself
 *  first, then ancestors, same depth/cycle rules as loadAncestorEntries — and
 *  at each level pairs that level's declared origins with that same level's
 *  log entries matched by messageIdentity. First matching entry wins per rawId
 *  (identical identities are interchangeable: identity covers full normalized
 *  content). Never writes any sidecar. */
export declare function loadLiveRefEntries(sessionFile: string | undefined, wantedRawIds: Set<string>): Promise<Map<string, SessionEntry>>;
