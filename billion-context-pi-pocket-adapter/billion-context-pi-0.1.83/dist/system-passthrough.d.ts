import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
type AgentMessage = SessionMessageEntry["message"];
export declare function carryHostSystemMessages(rebuilt: AgentMessage[], input: AgentMessage[]): AgentMessage[];
export {};
