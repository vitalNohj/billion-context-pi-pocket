import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
declare const RuleParams: Type.TObject<{
    rule: Type.TOptional<Type.TString>;
}>;
export declare function makeRuleTool(runtime: AcpRuntime): ToolDefinition<typeof RuleParams>;
export {};
