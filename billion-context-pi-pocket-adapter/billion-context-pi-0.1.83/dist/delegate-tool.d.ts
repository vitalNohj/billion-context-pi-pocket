import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type DelegatePolicy, type DelegateRoleConfig } from "./config.js";
import { type Usage } from "./delegate-events.js";
export declare const OUT_DIR: string;
export declare function delegateStdinText(resumeFrom: boolean, task: string | undefined): string;
export declare function delegateSpawnOptions(cwd: string, env: NodeJS.ProcessEnv): SpawnOptions;
/** Child process env for a nested delegate: depth increments by one, and the
 *  resolved maxDepth rides along so the cap binds the whole delegation tree
 *  even when the child loads a different project acp.json. */
export declare function delegateChildEnv(parentDepth: number, maxDepth: number): NodeJS.ProcessEnv;
/** Resolve the pi CLI entry for delegate child processes.
 *  argv[1] is only the pi CLI under a CLI host; embedded hosts (e.g. pi-web)
 *  run the SDK inside another node process, so probe instead. Non-pi hosts
 *  (omp) keep argv[1] untouched. */
export declare function resolvePiCliEntry(argv1: string, env?: NodeJS.ProcessEnv, piHost?: boolean): string;
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
interface DelegateRun {
    runId: string;
    agent: string;
    task: string;
    cwd: string;
    startedAt: number;
    finishedAt?: number;
    status: RunStatus;
    exitCode?: number | null;
    /** Exit signal when the child died by signal (exit code null), e.g. "SIGTERM". */
    exitSignal?: NodeJS.Signals;
    child?: ChildProcess;
    result?: {
        code: number | null;
        file: string;
        body: string;
    };
    /** Live activity log path (async json-stream runs only). */
    activityFile?: string;
    /** runId of the run this run resumed from (resumeFrom). */
    resumedFrom?: string;
    consumed?: boolean;
    /** True once the close handler injected the result as a system
     *  notification (sendUserMessage succeeded). Lets a later wait() avoid
     *  re-delivering the same payload. */
    injected?: boolean;
    /** Watchdog reason string when the run was force-terminated ("no output for
     *  5m", "30m limit"); surfaced in completion headers as "(timed out: ...)". */
    timedOut?: string;
    waiter?: () => void;
    /** Accumulated LLM usage from the delegate (from message_end events). */
    usage?: Usage;
    /** True once a wait/cancel tool has returned usage — prevents double-count. */
    usageReported?: boolean;
    /** True once agent_settled fired; a watchdog kill after this is stuck teardown, not a timeout. */
    agentSettled?: boolean;
    /** True while the run sits in the coalescing notification queue (scheduled
     *  for the next batched flush, not yet delivered). */
    notifyQueued?: boolean;
    /** When the model successfully read this run's result file (read tool, or a
     *  bash command referencing it). A read at/after finishedAt means the model
     *  already saw the final result — the completion notification is then
     *  suppressed (notifyIfRead: "skip"). */
    readAt?: number;
    /** True when the completion notification was suppressed because the model
     *  had already read the result file. Treated as delivered (injected=true)
     *  so wait/recovery never re-surface the result. */
    readSuppressed?: boolean;
}
export declare function addDelegateUsage(u: Usage): void;
export declare function getDelegateUsage(): Usage | undefined;
export declare function resetDelegateUsage(): void;
export declare function setDelegateDisplayUsage(mode: "merged" | "separate"): void;
export declare function setDelegatePolicy(policy: DelegatePolicy): void;
export declare class ConcurrencyGate {
    private active;
    private queue;
    private readonly capacityOf;
    constructor(capacityOf: () => number);
    private get capacity();
    get unlimited(): boolean;
    get activeCount(): number;
    get queuedCount(): number;
    /** Start `launch` immediately when a slot is free and nothing waits ahead;
     *  otherwise hold it in the FIFO queue. True when it started right away. */
    launchOrQueue(runId: string, launch: () => void): boolean;
    cancelQueued(runId: string): boolean;
    /** A live child hit a terminal state: free its slot, then start waiting
     *  launches FIFO (skipping any cancelled while queued). */
    release(): void;
}
export declare function setDelegateDefaults(d: {
    thinkingLevel?: string;
    agents?: Record<string, DelegateRoleConfig>;
} | undefined): void;
export declare function resetDelegateDefaults(): void;
declare const VALID_THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export declare function isValidThinkingLevel(v: unknown): v is (typeof VALID_THINKING_LEVELS)[number];
export declare function setDelegateNotifyIfRead(mode: "skip" | "always"): void;
/** Mark the run whose result file the model just read (via the `read` tool).
 *  Returns true when a run matched. A read of the final result file after the
 *  run finished means the model already saw the result — the completion
 *  notification is then suppressed (notifyIfRead: "skip"). */
export declare function markDelegateResultRead(filePath: string): boolean;
/** Mark runs referenced by a bash command (e.g. `cat <result file>`).
 *  Matches runIds appearing anywhere in the command string; only existing
 *  runs are affected, so task text that merely contains "del_..." is inert. */
export declare function markDelegateRunReadByCommand(command: string): boolean;
/** Snapshot of currently-running delegate runs, for the TUI status widget. */
export declare function runningRunsSnapshot(): {
    runId: string;
    agent: string;
    task: string;
    startedAt: number;
}[];
export interface FleetRunView {
    runId: string;
    agent: string;
    task: string;
    cwd: string;
    startedAt: number;
    finishedAt?: number;
    status: RunStatus;
    exitLabel: string;
    timedOut?: string;
    resumedFrom?: string;
    /** Streamed reply text (always retained, even for cancelled runs). */
    replyFile: string;
    /** Live tool-activity log (async json-stream runs only). */
    activityFile?: string;
    sessionFile?: string;
    usage?: Usage;
}
/** Running first (oldest spawn on top), then recently finished (newest first,
 *  capped) — the order the fleet inspector list shows. */
export declare function orderRunsForFleet(all: DelegateRun[]): DelegateRun[];
/** Display-safe snapshot of every delegate run known this session, for the
 *  fleet inspector (/acp-fleet). In-memory only: runs from previous pi
 *  processes are not listed (their files remain under OUT_DIR). */
export declare function fleetRunsSnapshot(): FleetRunView[];
/** Minimal writable surface accepted by makeEventApplier — real WriteStreams
 *  in production, in-memory collectors in tests. */
export interface EventApplierWriters {
    reply: {
        write(chunk: string): void;
    };
    activity: {
        write(chunk: string): void;
    } | null;
}
export interface EventApplier {
    handleEventLine(line: string): void;
    getReplyText(): string;
    /** omp fallback: `-p` prints the plain reply as raw stdout; append it
     *  straight through (no event parsing). */
    appendRaw(text: string): void;
}
/** Applies parsed delegate JSON-event lines to the live reply/activity files.
 *  Extracted from the spawn closure so the write logic is unit-testable.
 *
 *  reply-delta (text_delta) is streamed to the reply file as it arrives;
 *  reply-complete (text_end) carries the authoritative full content of the
 *  text block — any portion not already written is appended (tracked via
 *  msgWritten) so a final answer that arrives without preceding deltas is
 *  never lost from the file. */
export declare function makeEventApplier(opts: {
    showThinking: boolean;
    onUsage?: (usage: Usage) => void;
    onSettled?: () => void;
}, writers: EventApplierWriters): EventApplier;
/** Resolve a wait timeout to ms. Agents frequently pass seconds (e.g. 180)
 *  instead of milliseconds; values below the 1s floor make no sense as a wait
 *  duration, so rescale them to seconds before clamping — otherwise 180 clamps
 *  to 1000ms and the wait times out in 1s. */
export declare function resolveWaitTimeoutMs(raw: number | undefined): number;
/** Resolve a per-call timeout override (minutes) to ms. Absent/invalid values
 *  fall back to the configured default (fallbackMs); valid values are clamped
 *  to MAX_PER_CALL_TIMEOUT_MINUTES. */
export declare function resolvePerCallTimeoutMs(raw: number | undefined, fallbackMs: number | null): number | null;
declare const DelegateParams: Type.TObject<{
    agent: Type.TString;
    task: Type.TOptional<Type.TString>;
    resumeFrom: Type.TOptional<Type.TString>;
    cwd: Type.TOptional<Type.TString>;
    model: Type.TOptional<Type.TString>;
    thinkingLevel: Type.TOptional<Type.TString>;
    async: Type.TOptional<Type.TBoolean>;
    showThinking: Type.TOptional<Type.TBoolean>;
    timeoutMinutes: Type.TOptional<Type.TNumber>;
}>;
type DelegateArgs = Static<typeof DelegateParams>;
declare const CancelParams: Type.TObject<{
    runId: Type.TString;
}>;
declare const WaitParams: Type.TObject<{
    runId: Type.TString;
    timeout: Type.TOptional<Type.TInteger>;
}>;
export declare function accumulateUsage(a: Usage | undefined, b: Usage): Usage;
export declare function makeDelegateTool(pi: ExtensionAPI): ToolDefinition<typeof DelegateParams>;
export declare function formatRunResult(run: DelegateRun): string;
/** "exit 0" / "exit 1" / "exit SIGTERM" (signal shown when the child was
 *  killed and has no exit code) / "exit ?" (unknown). */
export declare function exitLabel(code: number | null, signal?: NodeJS.Signals | null): string;
/** Shared note for cancelled runs: their files are retained, so point the
 *  model at the partial output and offer a resume. */
export declare function cancelledFileNote(runId: string, file: string): string;
/** Runs that reached a terminal state but whose result never reached the
 *  model: no parked waiter, not consumed by a tool result, never injected
 *  as a notification, and not sitting in the coalescing queue (a scheduled
 *  batch is not a lost delivery). The model was promised a notification
 *  ("do NOT keep waiting"), so these must eventually be recovered, or a
 *  failed delegate stays invisible until the very end of the task. */
export declare function findUndeliveredRuns(all: DelegateRun[], excludeRunId?: string): DelegateRun[];
/** Compute the recovery notice for undelivered runs WITHOUT marking them
 *  delivered. The caller commits the marking (covered[].injected = true) only
 *  after the carrier message is actually sent: if the send throws, the runs
 *  must stay undelivered so a later carrier can recover them. */
export declare function buildRecoveryNotice(all: DelegateRun[], excludeRunId?: string): {
    text: string;
    covered: DelegateRun[];
};
/** Build a recovery notice for undelivered runs and mark each covered run
 *  injected=true (this notice IS its delivery) so it is never re-notified and
 *  a later wait dedups instead of re-delivering the payload. For carriers the
 *  host owns (delegate tool results); injectResult commits the marking itself
 *  only after its send succeeds (see buildRecoveryNotice). */
export declare function undeliveredNoticeFrom(all: DelegateRun[], excludeRunId?: string): string;
/** Queue a finished run's completion notification for coalesced delivery.
 *  The flush timer is re-armed (trailing edge) on every call so runs that
 *  finish together share one message; see NOTIFY_COALESCE_MS. */
export declare function scheduleRunNotification(pi: ExtensionAPI, run: DelegateRun): void;
/** Deliver every undelivered terminal run (queued + any earlier lost ones) as
 *  a single injected message. Runs that gained a waiter or were consumed
 *  while queued are skipped — their result is owned by the wait/cancel path.
 *  On send failure nothing is marked delivered, so a later carrier recovers
 *  the batch via the normal undelivered-notice mechanism. */
export declare function flushDelegateNotifications(): void;
/** One per-run section of a batched notification: status header + task +
 *  result file (+ error excerpt for failed runs). */
export declare function formatBatchRunSection(run: DelegateRun): string;
/** If the delegate already delivered its result via a system notification
 *  (the close handler injected before this wait was called), return a short
 *  "already delivered" message pointing at the result file, so the model
 *  never sees the same result twice (once via the injected notification,
 *  once via this tool result). Returns null when the run was NOT injected,
 *  in which case the caller delivers the full payload via formatRunResult(). */
export declare function injectedWaitMessage(run: {
    injected?: boolean;
    readSuppressed?: boolean;
    result?: {
        file: string;
    };
}, runId: string, remainingLine: string): string | null;
/** Build usage-aware return payload. Sets usageReported=true so subsequent
 *  waits on the same run skip usage. */
export declare function buildWaitResult(run: DelegateRun, content: string, mode?: "merged" | "separate", contentType?: "text"): {
    details: undefined;
    content: {
        type: "text";
        text: string;
    }[];
    usage?: AgentToolResult<unknown>["usage"];
};
/** Build usage-aware result for cancel tool. */
export declare function buildCancelResult(run: DelegateRun, content: string, mode?: "merged" | "separate"): {
    details: undefined;
    content: {
        type: "text";
        text: string;
    }[];
    usage?: AgentToolResult<unknown>["usage"];
};
export declare function makeDelegateWaitTool(_pi: ExtensionAPI): ToolDefinition<typeof WaitParams>;
export declare function makeDelegateCancelTool(_pi: ExtensionAPI): ToolDefinition<typeof CancelParams>;
export declare function buildChildArgs(args: DelegateArgs, rolePrompt: string, ctx: ExtensionContext, runId: string): Promise<{
    cliArgs: string[];
    tmpDir: string;
    isAsync: boolean;
    useJsonStream: boolean;
    sessionFile: string | null;
}>;
interface ChildResult {
    code: number | null;
    signal?: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
/** Model-facing summary of the ACTIVE async watchdog limits — built from the
 *  resolved policy so it stays truthful when timeouts are customized or
 *  disabled via acp.json/env. */
export declare function asyncWatchdogDescription(overrideAsyncMs?: number | null): string;
export declare function formatSyncResult(agent: string, runId: string, task: string, r: ChildResult, file: string): string;
/** Exit-0 runs that produced no final reply text did not deliver anything
 *  actionable (#506): a thinking-only stop (thinking budget exhausted) or a
 *  silent no-op termination must not be announced as a plain completion — the
 *  parent would trust the notification and never re-dispatch the task. Real
 *  non-zero exits and watchdog kills (code null / timedOut) are handled by the
 *  existing failure paths and stay excluded here. */
export declare function genuineNoOutput(code: number | null, timedOut: boolean, output: string): boolean;
export declare const NO_FINAL_OUTPUT_BODY: string;
/** Watchdog/EOF finalize arrives with code === null (the child was killed or
 *  never exited). If a result was delivered (non-empty reply or stderr), the
 *  run counts as completed (0); otherwise it stays null = genuine failure. */
export declare function effectiveExitCode(code: number | null, output: string, stderr: string): number | null;
/** Pure read-after-finish predicate: should the completion notification be
 *  suppressed because the model already read the final result file? Only a
 *  read at/after finishedAt counts — a read while the run was still in flight
 *  (readAt < finishedAt) saw partial output, so the notification still goes
 *  out. Callers additionally gate on run.status === "completed": a FAILED
 *  run's file holds only partial output with no failure marker, so the model
 *  cannot tell it failed from the file — failure notifications are never
 *  suppressed (failures are loud). */
export declare function shouldSuppressRead(run: {
    readAt?: number;
    finishedAt?: number;
}, mode: "skip" | "always"): boolean;
/** Suppress the completion notification for a run the model already read:
 *  mark it delivered (so wait/recovery/flush never re-surface the result),
 *  account its usage in separate mode, and log the skip. Idempotent. */
export declare function applyReadSuppression(run: DelegateRun, runId: string): void;
/** status (set by finalize from the effective exit code) is the authority for
 *  the FAILED/completed decision; the raw code is diagnostic display only
 *  ("exit ?"), so the notification can never disagree with run.status. */
export declare function injectResult(pi: ExtensionAPI, agent: string, runId: string, task: string, status: RunStatus, code: number | null, file: string, timedOut?: string, usage?: Usage, mode?: "merged" | "separate", usageAlreadyReported?: boolean, body?: string, activityFile?: string, signal?: NodeJS.Signals | null): boolean;
/** Tail of an activity log for failure diagnostics ("" when missing/empty). */
export declare function readActivityTail(file: string, maxChars?: number): Promise<string>;
export {};
