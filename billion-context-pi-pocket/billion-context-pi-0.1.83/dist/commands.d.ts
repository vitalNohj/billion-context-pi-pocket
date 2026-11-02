import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
export declare function makeCommands(runtime: AcpRuntime, pi?: ExtensionAPI): Array<{
    name: string;
    options: CommandOptions;
}>;
export {};
