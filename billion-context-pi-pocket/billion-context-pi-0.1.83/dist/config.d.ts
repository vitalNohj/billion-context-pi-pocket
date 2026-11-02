import { type Config, type Prompts } from "acp-kernel";
import type { CompressReasoningConfig } from "./reasoning-drop.js";
import type { DegenerationGuardConfig } from "./degeneration.js";
import type { ThrottleRetryConfig } from "./throttle-retry.js";
import type { PiPromptSections } from "./system-prompt.js";
import type { NudgeSectionsConfig, ToolPromptsConfig } from "./surface.js";
/** Default TUI shortcut for the acp_delegate fleet inspector. Moved off
 *  "ctrl+alt+f" (also claimed by pi-subagents) to avoid a cross-extension
 *  conflict Pi's loader only warns about — last-loaded silently wins (#412). */
export declare const DEFAULT_FLEET_SHORTCUT = "ctrl+alt+d";
/** Per-role delegate defaults. Lets long-lived automation pin a cheaper or
 *  more capable model and a thinking level per delegate role, so the main
 *  agent doesn't have to fill them in on every `acp_delegate()` call. */
export interface DelegateRoleConfig {
    /** Default model for this role, as `"provider/id"`. Resolution priority:
     *  per-call `model` > this role default > parent agent's current model. A
     *  value that isn't a valid `"provider/id"` is ignored (treated as unset).
     *  If the configured model doesn't exist in the live registry, the child
     *  falls back to the parent model and a warning is logged — it never fails. */
    model?: string;
    /** Default thinking level for this role: one of off|minimal|low|medium|
     *  high|xhigh|max. Resolution priority: per-call `thinkingLevel` > this role
     *  default > global `delegate.thinkingLevel` > Pi's own default. An invalid
     *  value is ignored with a warning (never fails). */
    thinkingLevel?: string;
}
/** Delegate sub-agent configuration. */
export interface DelegateConfig {
    /** Enable acp_delegate tools (delegate/wait/cancel) and their system-prompt
     *  section. Default: true. Set `enabled: false` to skip registering them. */
    enabled?: boolean;
    /** Keep acp_delegate active even when a third-party subagent extension
     *  (pi-subagents) is installed. Default: false — when pi-subagents is
     *  detected at session start, acp_delegate stands down (tools, fleet
     *  shortcut and system-prompt section skipped) to avoid two overlapping
     *  sub-agent systems, and a reminder points at /acp-subagents so the
     *  third-party agents can still get ACP compression tools (#415). */
    forceEnable?: boolean;
    /** How delegate usage is reported back to the main session.
     *  "separate" (default) — delegate tokens tracked in a separate accumulator;
     *  main session totals stay clean, delegate usage shows as its own block in
     *  acp_status (excluded from main totals).
     *  "merged" — delegate token usage folded into the tool-result usage field,
     *  counted as part of the main session totals. */
    displayUsage?: "merged" | "separate";
    /** Maximum acp_delegate nesting depth. Default: 2 (main → child → grandchild;
     *  the grandchild cannot delegate further). Set 1 to forbid nested delegation
     *  (orchestrator → leaf workers only). The resolved value is propagated to
     *  child processes via PI_ACP_DELEGATE_MAX_DEPTH so the cap follows the whole
     *  delegation tree, even when a child loads a different project acp.json. */
    maxDepth?: number;
    /** Hard timeout for synchronous delegates (async=false, or async auto-downgraded
     *  on one-shot hosts), in minutes. Default: 5. 0 or null disables the timeout
     *  (the run blocks until the child exits or the tool call is cancelled). */
    syncTimeoutMinutes?: number | null;
    /** Idle watchdog for async delegates: kill when no output arrives for this many
     *  minutes. Default: 5. This is the main defense against a stuck child holding
     *  its stdout fd open, so disabling it (0/null) logs a warning — use
     *  acp_delegate_cancel as the manual escape hatch. */
    idleTimeoutMinutes?: number | null;
    /** Hard time limit for async delegates, in minutes. Default: 30. 0 or null
     *  disables the limit. */
    asyncTimeoutMinutes?: number | null;
    /** Cap on how many background (async) delegate processes run at once.
     *  `1` forces strict serial execution; `N` allows up to N in parallel;
     *  omitted means unlimited (existing behavior). Extra launches are queued and
     *  start automatically as slots free. Invalid values (non-integer, <1) fall
     *  back to unlimited with a warning. Env `PI_ACP_DELEGATE_MAX_CONCURRENT`
     *  overrides this. See #294. */
    maxConcurrent?: number;
    /** Global default thinking level applied to every delegate when neither the
     *  per-call `thinkingLevel` nor the role's own `thinkingLevel` is set. One of
     *  off|minimal|low|medium|high|xhigh|max. When unset at all levels, no
     *  `--thinking` flag is passed and each child uses Pi's own default. */
    thinkingLevel?: string;
    /** Per-role defaults keyed by role name (reviewer/researcher/worker/planner/
     *  oracle, or any custom role). See DelegateRoleConfig. Only affects roles
     *  that are named here; other roles inherit the parent model + Pi defaults. */
    agents?: Record<string, DelegateRoleConfig>;
    /** What happens to the completion notification when the model has already
     *  read the delegate's result file after the run finished.
     *  "skip" (default) — the notification is not injected; the model already
     *  saw the result, so re-injecting it would only waste context.
     *  "always" — always inject the notification (previous behavior). */
    notifyIfRead?: "skip" | "always";
    /** Keybinding for the interactive TUI shortcut that opens the acp_delegate
     *  fleet inspector (live list + transcript). Default: "ctrl+alt+d". Set to
     *  "" (empty string) to disable keyboard registration entirely — the
     *  inspector stays reachable via /acp-fleet. Moved off the previous hardcoded
     *  "ctrl+alt+f" because pi-subagents also claims ctrl+alt+f, and Pi's loader
     *  only warns + last-loaded-wins on cross-extension conflicts (#412). */
    fleetShortcut?: string;
}
/** Resolved delegate policy: what actually takes effect after merging acp.json,
 *  env overrides and defaults. Timeout fields are milliseconds; null means the
 *  corresponding timeout/watchdog is disabled. */
export interface DelegatePolicy {
    enabled: boolean;
    /** Resolved delegate.forceEnable (default false): keep acp_delegate even
     *  when a third-party subagent extension (pi-subagents) is installed (#415). */
    forceEnable: boolean;
    displayUsage: "merged" | "separate";
    maxDepth: number;
    syncTimeoutMs: number | null;
    idleMs: number | null;
    asyncTimeoutMs: number | null;
    /** Resolved cap on concurrent background delegates; Infinity = unlimited. */
    maxConcurrent: number;
    /** Global default thinking level (undefined when unset). */
    thinkingLevel?: string;
    /** Per-role defaults keyed by role name (undefined when unset). */
    agents?: Record<string, DelegateRoleConfig>;
    /** Whether to suppress the completion notification when the model already
     *  read the result file after the run finished. Always resolved ("skip" default). */
    notifyIfRead: "skip" | "always";
    /** Resolved TUI shortcut for the fleet inspector ("" = registration disabled). */
    fleetShortcut: string;
}
export declare const DEFAULT_DELEGATE_POLICY: DelegatePolicy;
/** Compression tuning fields, shared by all three levels (global, provider,
 *  model). Percentage fields accept a ratio (0.75) or percent string ("75%").
 *  Resolution is per-field, deepest-wins (model > provider > global); an
 *  undefined field at a deeper level does NOT clear a shallower value. */
export interface CompressSettings {
    /** Context usage percentage that triggers forced compression nudges
     *  (bypasses growth-gate + cadence). Accepts a ratio (0.75) or percent
     *  string ("75%"). Default: 0.75. Maps to kernel nudge.maxContextLimitPct. */
    maxContextLimit?: number | string;
    /** Context usage percentage that triggers emergency truncation of large
     *  tool outputs. Accepts a ratio (0.95) or percent string ("95%").
     *  Default: 0.95. Must be >= maxContextLimit. Maps to kernel
     *  nudge.emergencyThresholdPct + truncate.threshold. */
    emergencyThresholdPercent?: number | string;
    /** Token growth threshold for soft compression nudges. Default: 50000.
     *  Maps to kernel nudge.growthFloor + nudge.growthCap. */
    nudgeGrowthTokens?: number;
    /** Minimum reclaimable tokens for a pressure-band nudge (kernel #198).
     *  Default: max(5000, round(limit×0.01)). Explicit 0 restores the legacy
     *  any-pending behavior — useful for tiny windows (e.g. e2e scenarios with
     *  modelContextLimit 1500) where a fixed 5000-token floor exceeds the whole
     *  window and would suppress every nudge. Maps to kernel
     *  nudge.minPressureBenefitTokens. */
    minPressureBenefitTokens?: number;
    /** [#336] Drop oversized reasoning (thinking) from historical `compress`
     *  tool calls — see CompressReasoningConfig in src/reasoning-drop.ts.
     *  Merged field-wise (drop, threshold) across the three levels. */
    reasoning?: CompressReasoningConfig;
    /** Active prompt pack name (see CONFIGURATION.md “Prompt packs”). Base
     *  level; override per provider/model via `providers`. "default" or unset =
     *  built-in defaults. Resolved per request against the live model, so
     *  switching models mid-session switches the pack. Packs ship text-level
     *  overrides only; a pack's `toolPrompts` follow the base selection (tool
     *  definitions freeze at extension load, before the model is known). */
    promptPack?: string;
    /** Opt-in wire-level strip of historical image payloads (issue #321, kernel
     *  #215). Default: false (images ride along verbatim, current behavior).
     *  When true, every message older than `stripImagesKeepRecent` has its image
     *  parts dropped from the outbound provider body (image-only messages
     *  collapse to a "[image]" text placeholder). Host-side policy only — the
     *  strip primitive lives in acp-kernel's wire layer. */
    stripImages?: boolean;
    /** How many of the MOST RECENT messages keep their image payloads when
     *  `stripImages` is enabled. Default: 5. Ignored when stripImages is off. */
    stripImagesKeepRecent?: number;
}
/** Per-provider compression overrides. Carries the same tuning fields as the
 *  global level, plus an optional per-model map keyed by model id. */
export interface ProviderCompress extends CompressSettings {
    /** Per-model overrides within this provider, keyed by model id
     *  (e.g. "claude-sonnet-4-5"). */
    models?: Record<string, CompressSettings>;
}
/** Compression tuning. Top-level fields are global defaults; `providers`
 *  optionally narrows them per Pi provider name and per model id. The active
 *  entry is resolved live each turn from the current model
 *  (`ctx.model.provider` / `ctx.model.id`). */
export interface CompressConfig extends CompressSettings {
    /** Per-provider (and per-model) overrides, keyed by Pi provider name
     *  (e.g. "anthropic", "openai", "zhipu") — the same name used in
     *  models.json and `pi --provider`. */
    providers?: Record<string, ProviderCompress>;
}
/** Generic tool-call repetition guard. Detects the same tool being called
 *  repeatedly with byte-identical arguments — a sequence-level attractor that
 *  token-level penalties cannot break (greedy small models loop on e.g.
 *  acp_status or bash polls forever, each round adding protected tokens that
 *  the compression protection band then refuses to reclaim). Consecutive
 *  identical calls accumulate per session: at `warn` a strong warning is
 *  appended to that call's toolResult; at `abort` the call is refused (blocked,
 *  error toolResult) and the turn aborted so the attractor breaks. Any change
 *  to the arguments (or a switch to a different tool) resets the counter.
 *  Accepts a boolean shorthand (`false` disables) or an object. Default:
 *  enabled, warn=3, abort=5. See issue #308. */
export interface RepetitionGuardConfig {
    /** Enable/disable the guard. Default: true. */
    enabled?: boolean;
    /** Consecutive identical calls before a strong warning is appended to the
     *  matching toolResult. Default: 3. */
    warn?: number;
    /** Consecutive identical calls before the call is refused and the turn
     *  aborted. Default: 5. Must be greater than `warn`; clamped up
     *  automatically if not. */
    abort?: number;
}
/**
 * Adapter configuration. Maps onto acp-kernel's `Config` plus Pi-specific knobs
 *  (live model context window, protected tools, state persistence).
 */
export interface AdapterConfig {
    /** Master switch. Default: true. Set `enabled: false` in acp.json (or
     *  programmatically) to turn the whole adapter off — no tools, no system
     *  prompt, no context transform — for models too small to handle ACP, where
     *  Pi's native context management should run instead. Checked at extension
     *  load; requires a Pi restart to take effect. */
    enabled?: boolean;
    /** When omitted, the adapter reads `ctx.model.contextWindow` live each turn.
     *  Set explicitly for tests/headless runs. */
    modelContextLimit?: number;
    /** Tool-name patterns (glob suffix allowed) whose EVERY call+result pair is
     *  hard-excluded from compression — matching refs render as BLOCKED in every
     *  view. Default: none. Intended for low-frequency high-value tools whose
     *  outputs are independent content (e.g. skill loads); do NOT use for chatty
     *  tools — protecting every instance grows context unboundedly (#639
     *  rationale). Settable via acp.json since #499. */
    protectedTools?: string[];
    /** Tool-name patterns (glob suffix allowed) whose LATEST call+result pair is
     *  hard-excluded from compression; older pairs remain compressible. Default:
     *  none. Intended for cumulative-snapshot tools where each call supersedes
     *  the last. Settable via acp.json since #499. */
    protectedLatestTools?: string[];
    /** Tool-name patterns (glob suffix allowed) EXCLUDED from the soft-protected
     *  recent zone: matching tool results inside the recent window fold
     *  immediately instead of aging out first (kernel >= 0.0.92). Default:
     *  unset → kernel built-in ["decompress", "search_context", "read",
     *  "bash"]. The built-in keeps read/bash compressible — the largest
     *  reclaimable mass — but that also folds freshly-read files in batch-read
     *  workflows (#1198-style fold→re-read loop, bili #1277). Recommended
     *  remedy: ["decompress", "search_context", "bash"] (remove only read).
     *  ⚠ Unlike the two protection keys, an EMPTY ARRAY IS VALID — it excludes
     *  nothing and gives every tool recent-zone protection (escape hatch); do
     *  not re-include decompress/search_context or just-restored blocks get
     *  pinned in the recent zone and become unreclaimable. */
    neverPreserveRecentTools?: string[];
    /** The positive counterpart of neverPreserveRecentTools: tool-name
     *  patterns REMOVED from the effective recent-zone exclusion list (kernel
     *  >= 0.0.93) — `(neverPreserveRecentTools ?? built-in) minus
     *  preserveRecentTools`. The one-entry #1198/#1277 batch-read fold→re-read
     *  remedy: ["read"] protects fresh read results without restating (or
     *  freezing a stale copy of) the built-in list. Default: unset → no
     *  subtraction. Unlike neverPreserveRecentTools an EMPTY ARRAY IS
     *  INVALID here (pure no-op — use neverPreserveRecentTools: [] for
     *  protect-everything instead). */
    preserveRecentTools?: string[];
    preserveRecentMessages?: number;
    /** Check npm for a newer billion-context-pi on startup and auto-install it. Default: true.
     *  Disable via `autoUpdate: false` or env `ACP_AUTO_UPDATE=0` to avoid all
     *  network calls on startup. */
    autoUpdate?: boolean;
    /** Enable debug-level events in the ACP log file (default ~/.pi/acp.log).
     *  Always-on events (session/turn/compress/delegate lifecycle, all errors and
     *  warnings) are written regardless; `debug` only adds verbose diagnostics.
     *  Default: false (or env ACP_DEBUG=1/true). */
    debug?: boolean;
    /** Default timeout in seconds injected into the bash tool when the model
     *  omits `timeout`. Pi has NO built-in default, so without this a command
     *  that the model forgets to time out can hang for thousands of seconds.
     *  Default: 60 (catches hangs quickly). On timeout the model is guided to
     *  re-run with a larger `timeout`. Set to 0 to disable (restore Pi's
     *  unbounded behavior). */
    toolBashDefaultTimeout?: number;
    /** Hard byte cap applied to tool result text via the `tool_result` hook.
     *  Default: 50000 (~50KB) — aligned with Pi's own bash/read/grep cap so
     *  every tool path lands under one ceiling; the net still catches runaway
     *  output from tools Pi does not cap (MCP/custom). Set higher for large
     *  MCP outputs, lower (e.g. 8192) for a tighter context budget, or 0 to
     *  disable. When capped, oversized text is head-truncated with a notice
     *  telling the model how to see the full output (bash: read
     *  BashToolDetails.fullOutputPath). */
    toolOutputMaxBytes?: number;
    /** Delegate sub-agent config. Accepts a boolean shorthand (`true` →
     *  `{ enabled: true }`, `false` → `{ enabled: false }`) or a DelegateConfig
     *  object. Default: enabled. */
    delegate?: boolean | DelegateConfig;
    /** Compression tuning. */
    compress?: CompressConfig;
    /** Provider token-throttle (Bedrock "Too many tokens, please wait before
     *  trying again.") auto-retry. Accepts a boolean shorthand (`false`
     *  disables) or a ThrottleRetryConfig object. Default: enabled, 10 retries,
     *  60s exponential base capped at 300s per kick. */
    throttleRetry?: boolean | ThrottleRetryConfig;
    /** Cap on the output-headroom reservation as a fraction of the context
     *  window: reserved = min(model.maxTokens, pct * window). Accepts a ratio
     *  (0.25) or percent string ("25%"). Default: 0.25. Set 0 to disable the
     *  reservation entirely; >= 1 restores the legacy full-capability
     *  reservation (issue #207). */
    outputHeadroomMaxPct?: number | string;
    /** Generic tool-call repetition guard (see RepetitionGuardConfig). Accepts a
     *  boolean shorthand (`false` disables) or an object. Default: enabled,
     *  warn=3, abort=5. Stops greedy small models looping on byte-identical
     *  tool calls (issue #308). */
    repetitionGuard?: boolean | RepetitionGuardConfig;
    /** Character-level degenerate-repeat guard (see DegenerationGuardConfig).
     *  Collapses long single-codepoint runs (e.g. 4655×「【」) in assistant
     *  text/thinking of the outgoing view and injects a one-shot recovery notice
     *  after a degenerated turn — breaking the abort loop where pi replays the
     *  degenerated thinking back to the provider on every request (issue #351).
     *  Distinct from `repetitionGuard`, which is tool-call level. Accepts a
     *  boolean shorthand (`false` disables) or an object. Default: enabled,
     *  minRun=200. */
    degenerationGuard?: boolean | DegenerationGuardConfig;
    /** Host multi-session turn-boundary policy (#364). Accepts a boolean
     *  shorthand (`true` → count host-injected custom_message entries as turn
     *  boundaries) or a HostSessionConfig object. Default: off — pi-native
     *  behavior where only genuine user-role messages start a turn, so existing
     *  single-session users' nudge cadence is unchanged. Enable for inline
     *  multi-session hosts (Prime RLM & co.) whose injected agent messages must
     *  delimit real turns. See docs/host-adapter.md. */
    hostSession?: boolean | HostSessionConfig;
    /** Persistent-rules feature gate (#526): opt-in `rules: true` in acp.json.
     *  Gates the human `/acp-rule` command (list + record + remove + clear — kernel
     *  `listRules`/`addRule`/`removeRule`/`clearRules` against the session `.acp.json` sidecar state) and
     *  the model-side `acp_rule` tool (#490). Custom limits via
     *  coreOverrides.rules ({ maxRules?, maxRuleChars? }). */
    rules?: boolean;
    /** Legacy flat alias for `delegate.displayUsage`. Kept for backward
     *  compatibility with existing acp.json files. Prefer `delegate.displayUsage`. */
    displayUsage?: "merged" | "separate";
    /** Override acp-kernel's load-bearing compression prompt rules (the 4
     *  Prompts fields). Each set field replaces the kernel default verbatim.
     *  Requires acknowledgePromptsRisk: true — without it, overrides are dropped
     *  (defaults used) and a warning is logged. Set via ~/.pi/acp.json. */
    prompts?: Partial<Prompts>;
    /** Must be true for `prompts` overrides to take effect. Acknowledges that
     *  replacing the kernel's tuned compression rules may reduce summary quality
     *  (lost paths/signatures/decisions → worse retrieval). */
    acknowledgePromptsRisk?: boolean;
    /** Override structural sections of the ACP system prompt (ACP TAGS, TOOLS,
     *  WHEN TO COMPRESS, ...). Tri-state per section: string = replace, null =
     *  remove, omitted = default. Not risk-gated — these are documentation
     *  sections, not compression rules. Set via acp.json. */
    promptSections?: Partial<PiPromptSections>;
    /** Override guidance-class nudge texts (efficiencyNote, emergencyHeader,
     *  t2Guidance, t3Guidance). Same tri-state semantics. Not risk-gated. */
    nudgeSections?: NudgeSectionsConfig;
    /** Override the four ACP tool definitions' LLM-facing text (description,
     *  paramDescriptions, promptSnippet, promptGuidelines). Read synchronously
     *  at extension load — tool defs are frozen at registration time. */
    toolPrompts?: ToolPromptsConfig;
    /** Replace (string) or remove (null) the ACP_DELEGATE_NOTIFICATIONS appendix
     *  injected when the delegate tool is enabled. */
    delegatePrompt?: string | null;
    coreOverrides?: Partial<Config>;
}
export declare const DEFAULT_TOOL_BASH_TIMEOUT = 60;
export declare const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 50000;
/** Resolve delegate config from the adapter, handling the boolean shorthand
 *  and the legacy flat `displayUsage` alias. Precedence: env > acp.json >
 *  default (same convention as ACP_MODEL_CONTEXT_LIMIT). Invalid values fall
 *  back to the default with a logged warning — they never fail the session. */
export declare function resolveDelegate(adapter: AdapterConfig): DelegatePolicy;
/** Defaults for the generic tool-call repetition guard (issue #308). */
export declare const REPETITION_GUARD_DEFAULTS: {
    readonly warn: 3;
    readonly abort: 5;
};
/** Resolve the repetition-guard configuration from the adapter, handling the
 *  boolean shorthand (`false` disables) and clamping `abort` to stay strictly
 *  above `warn` (a guard that aborts at or before its warn threshold would be
 *  meaningless). Non-numeric / out-of-range values fall back to defaults. */
export declare function resolveRepetitionGuard(adapter: AdapterConfig): {
    enabled: boolean;
    warn: number;
    abort: number;
};
/** Host multi-session turn-boundary policy (#364). See TurnBoundaryPolicy in
 *  src/turn-boundary.ts for the semantics this resolves. */
export interface HostSessionConfig {
    /** Count host-injected custom_message entries (agent_message) as turn
     *  boundaries. Default: false (pi-native behavior). */
    countCustomMessages?: boolean;
    /** #578: optional customType allowlist refining countCustomMessages — when
     *  set (with countCustomMessages:true), only injected entries whose
     *  customType is listed start a turn, keeping metadata injections
     *  (harness_digest, ipython_state) out of nudge/retry accounting. Ignored
     *  unless countCustomMessages:true; malformed values warn and fall back to
     *  "all injected types count". */
    customMessageTypes?: string[];
}
export interface ResolvedHostSession {
    countCustomMessages: boolean;
    /** Present only when countCustomMessages is on and a valid allowlist was
     *  configured (#578). */
    customMessageTypes?: readonly string[];
}
/** Resolve the host-session turn-boundary policy from the adapter, handling
 *  the boolean shorthand (`true` enables countCustomMessages). Invalid values
 *  fall back to the pi-native default (off) with a logged warning — they never
 *  fail the session. */
export declare function resolveHostSession(adapter: AdapterConfig): ResolvedHostSession;
/** Per-field deepest-wins merge of the three compression levels (global →
 *  provider → model). An undefined field at a deeper level does NOT clear a
 *  value set at a shallower level — only a defined value overrides. */
export declare function mergeCompress(global?: CompressSettings, provider?: CompressSettings, model?: CompressSettings): CompressSettings;
/** Resolve the effective compression settings for the active model: global →
 *  provider (matched by Pi provider name) → model (matched by model id).
 *  Returns a CompressSettings whose fields are undefined when nothing is set
 *  at any level. The Pi adapter keys providers by name (ctx.model.provider),
 *  not URL — it never sees the upstream URL the way the proxy does. */
export declare function resolveCompress(compress: CompressConfig | undefined, provider: string | undefined, modelId: string | undefined): CompressSettings;
export declare function resolveConfig(adapter: AdapterConfig, liveContextLimit: number, provider?: string, modelId?: string): Config;
export declare function parsePercent(v: number | string): number;
