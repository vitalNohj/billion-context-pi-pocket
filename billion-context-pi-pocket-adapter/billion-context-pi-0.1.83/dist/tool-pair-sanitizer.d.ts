import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionMessageEntry["message"];
export interface ToolPairSanitizeResult {
    messages: AgentMessage[];
    droppedResults: string[];
}
export declare function sanitizeToolPairing(messages: AgentMessage[]): ToolPairSanitizeResult;
export {};
