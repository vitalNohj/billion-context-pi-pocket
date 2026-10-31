import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionMessageEntry["message"];
export declare function liveOnlyTail(entries: SessionEntry[], live: AgentMessage[]): AgentMessage[] | null;
/** Cached variant of liveOnlyTail keyed by session id. Behaviourally identical
 *  (same tail or null); only the prefix proof is memoized. Doubt always falls
 *  back to the full walk. */
export declare function liveOnlyTailCached(sid: string, entries: SessionEntry[], live: AgentMessage[]): AgentMessage[] | null;
/** Drop a session's alignment cache (session_shutdown for memory hygiene). */
export declare function dropLiveOnlyTailCache(sid: string): void;
export {};
