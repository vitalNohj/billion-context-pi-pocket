import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
interface WidgetRun {
    runId: string;
    agent: string;
    task: string;
    startedAt: number;
}
type RunsSnapshot = () => WidgetRun[];
export declare function formatShortcutLabel(shortcut: string): string;
export declare const delegateStatusWidget: {
    setContext(ctx: ExtensionContext, snapshot: RunsSnapshot, shortcut?: string): void;
    dispose(): void;
    poke(): void;
};
export {};
