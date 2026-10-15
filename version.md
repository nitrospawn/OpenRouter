# OpenRouter Extension Version History & Changelog

All notable changes, bug fixes, architectural enhancements, and operational updates are documented in this file whenever a version number is bumped or a release milestone is reached.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.9] - 2026-10-14

### Fixed
- **Premature Walkthrough Auto-Correction Re-Prompt Loop (8-Turn Execution Drawer Loop):**
  - Resolved bug where discarding a walkthrough for plan-gated suppression (Check 5: no implementation plan created) or duplicate suppression (Check 4) triggered the *Premature Walkthrough Auto-Correction* loop, repeatedly re-prompting the model with *"You emitted a walkthrough block before the task was fully verified..."* until the auto-followup turn limit was reached.
  - Added `isVerificationFailure` distinction in `panelProvider.ts` to separate genuine verification failures (Check 1, Check 2, Check 3) from intentional suppression rules (Check 4 duplicate, Check 5 plan-gated), ensuring that suppressed walkthroughs end the task cleanly without re-prompting.
  - Added explicit completion regex protection (`isContentComplete`) to the Premature Walkthrough Auto-Correction guard so that when a model outputs a complete, verified executive summary (e.g. *"All plan items are complete and verified — no further steps pending"*), the turn concludes immediately and renders the final summary without generating redundant intermediate walkthrough turns.
  - Expanded `isExplicitlyComplete` in Autonomous Conversational Stall Recovery to recognize `all work is complete`, `implementation is complete`, `everything is complete`, `no further steps`, `no pending steps`, and `no pending checklist items`.
- **Post-Plan Walkthrough & Autonomous Continuation Loop Elimination (Token Burn Fix):**
  - Resolved severe issue where models (e.g., GLM 5.3 Flash, Claude Sonnet) produced 8+ walkthroughs and repeated follow-ups after finishing an active plan, burning tokens in an endless execution loop.
  - **Scoped Plan Item Checks to Current Task:** Scoped `hasPendingPlanItems` to evaluate only messages *after the latest user prompt* (`taskScopeHistory`), preventing stale `- [ ]` checklist items from earlier conversations in history from artificially activating the elevated 30-turn automated cap (`MAX_AUTO_FOLLOWUPS`).
  - **Walkthrough-in-History Loop Breakers:** Added `walkthroughInHistory` checks in `panelProvider.ts` for both Autonomous File-Edit Continuation (Section 4) and Conversational Stall Recovery (Section 5). Once a walkthrough document has been generated and recorded for the active task, auto-followups immediately halt, preventing the system from continuously re-injecting *"emit the final \`\`\`\`walkthrough block"* prompts when the model responds with prose summaries.
- **Repetitive Fix Explanation on User Acknowledgments:**
  - Resolved an issue where replying with an acknowledgment or confirmation (e.g. *"its fine now thank you"*, *"that fixed it"*, *"works now"*) caused the model to re-output the entire 3-part technical briefing (Root Cause, What Was Fixed, Verification & How to Test) from the preceding turn.
  - Updated Section 1 in `systemPrompt.ts` to explicitly distinguish active bug-fixing turns from user acknowledgments, instructing models to respond conversationally and concisely without re-dumping past technical briefings when no new work was requested.
- **Walkthrough Code Block Detection & Raw Markdown Fallback:**
  - Resolved an issue where walkthrough documents emitted by certain models (e.g., GLM 5.3 Flash) with leading spaces or indentation before code fences were rendered as raw markdown inside chat rather than being captured as interactive `[📄 Results docs  👁 View]` artifact cards.
  - Updated `findTopLevelFence` in `responseParser.ts` to accommodate arbitrary leading whitespace (`^\s*(```|~~~)`) on opening tags.
  - Expanded the resilient fallback in `responseParser.ts` to detect unfenced `# Implementation Walkthrough` markdown structures containing sections like `## Changes Made` or `## Verification Results`, transforming them into first-class Results docs cards.
- **Simultaneous Plan Docs and Results Docs Artifact Cards:**
  - Resolved an issue where a final task response rendered both `[📄 Plan docs  ✓ Proceed]` and `[📄 Results docs  👁 View]` cards when models repeated plan blocks alongside the final walkthrough block.
  - Added an artifact exclusivity guard in `responseParser.ts` to suppress `planDocument` and strip residual `📄 Plan docs ready` tokens whenever a completion `walkthroughDocument` is present.
  - Added a backend confirmation cleanup in `panelProvider.ts` to ensure confirmed walkthrough completions completely reset any residual `planDocument`.
  - Added a UI-level rendering guard in `main.ts` so that messages containing Results docs notices or cards automatically suppress Plan docs cards.

### Added
- **Mandatory 4-Part Completion Briefing (Root Cause, Changes, Verification, Test):**
  - Updated `systemPrompt.ts` (Section 10) and `panelProvider.ts` final continuation prompt to explicitly require all 4 structured completion sections across every task:
    1. **Root Cause & Solution Summary**
    2. **Files & Key Changes** (classes, functions, widgets modified)
    3. **Verification Facts** (exact commands run and exit code 0)
    4. **How to Test** (step-by-step user instructions for testing)
  - Eliminates overly brief/terse 1-2 sentence conclusions while ensuring the formal ````walkthrough block is emitted directly below.

### Added
- **Plan-Gated Results Docs / Walkthrough Generation:**
  - Added strict gating across `systemPrompt.ts` (Section 10) and `panelProvider.ts` (Check 5) to ensure `walkthroughDocument` and `Results docs` cards are ONLY generated if an implementation plan was created for the task, or if the user explicitly requested a walkthrough / results docs.
  - For direct bug fixes, single-file edits, or unplanned tasks, models now present a comprehensive, structured in-chat explanation (root cause, concrete files and methods modified, and verification steps & how to test) without generating an unnecessary results document modal.
- **Rich, Factual Standalone Summaries (Plan Docs & Results Docs):**
  - Upgraded Section 8 (Implementation Plan) in `systemPrompt.ts` to require a self-contained, fact-filled Executive Summary directly in chat (architecture overview, explicit list of files & key symbols to modify/create, and verification command plan).
  - Upgraded Section 10 (Results Walkthrough) in `systemPrompt.ts` to require a comprehensive factual briefing (root cause & solution summary, exact file paths and classes/functions changed, and concrete verification outputs like exit codes and pass counts). Users no longer need to open the document viewer to understand the full context.

## [0.5.8] - 2026-10-13

### Added
- **Auto-Healing Diagnosis Collapsible Dropdown Integration:**
  - Integrated `isAutoRetry` failure diagnosis cards into the intermediate execution steps drawer (`.intermediate-turn-drawer`) alongside intermediate steps and executed terminal command cards.
  - Keeps the main chat feed clean and focused by eliminating loose, oversized self-healing logs overflowing below the execution steps accordion.
  - Updated `updateIntermediateDrawerSummary()` in `main.ts` to dynamically detect and count `.auto-retry-message` elements, surfacing the diagnosis count in the header label (e.g., `19 execution steps (39 terminal commands, 4 auto-healing)` or `N auto-healing diagnoses`).
  - Added user turn boundary detection in `getOrCreateIntermediateDrawer()` to ignore `auto-retry-message` items so the entire autonomous multi-retry cycle consolidates under a single collapsible drawer.
  - Marked auto-retry messages and retry notices with `isIntermediateStep: true` in `panelProvider.ts` to persist collapsed status across chat sessions and history reloads.
  - Added tailored compact styling (`.intermediate-turn-drawer-body .message.auto-retry-message`) in `style.css` for consistent, aesthetic nesting inside the drawer.

### Fixed
- **Premature Packing of Final Responses into Execution Dropdown:**
  - Resolved an issue in `panelProvider.ts` where `confirmedIntermediate` evaluated to `true` whenever an edit block was present, even when no follow-up turn was triggered.
  - Corrected `confirmedIntermediate` to strictly reflect `Boolean(triggeredFollowUp)`, ensuring that final completion steps and single-turn task answers remain fully visible and open in the chat feed instead of being collapsed inside `1 execution step completed`.
  - Added auto-flow gating to `isIntermediateStep` so standalone single-turn requests from users are never tentatively marked intermediate during streaming.
- **Autonomous Stall Recovery Loop on Task Completion:**
  - Fixed an infinite loop where the extension repeatedly re-prompted models with continuation directives after all plan tasks were already finished and verified.
  - Replaced broad `activePlanExists` check with `hasPendingPlanItems` to ensure stall recovery only engages when uncompleted `- [ ]` checklist items actually remain.
  - Expanded `isExplicitlyComplete` detection to recognize completion declarations (e.g. `all plan items are complete`, `pass analysis clean`, `with no issues`, `done:`), gracefully halting execution.
- **Eliminated Duplicate Task Summary Cards:**
  - Removed redundant `renderTaskSummaryCard()` invocation in `main.ts` that caused task summaries to display twice in the message bubble (once as formatted markdown and a second time as a duplicate blue card below).

## [0.5.7] - 2026-10-13

### Added
- **Three-Tier System Prompt Compression:**
  - Implemented dynamic system prompt tiering in `buildSystemPrompt()` across three behavioral levels:
    - **Conversational Tier (~940 tokens / ~500 words):** Includes only core identity, tone, reasoning effort, OS/shell, four-step rule, and request understanding (Sections 1, 2, 5, 6, 7). Strips out heavy editing, planning, and terminal instructions, saving ~4,000+ tokens on general questions and simple chat.
    - **Editing Tier (~4,980 tokens):** Adds file reading tutorial (Section 3), secret redaction (Section 4), planning decision boundaries (Section 8), edit blocks (Section 9), and verification walkthrough rules (Section 10).
    - **Executing Tier (~7,280 tokens):** Injects terminal failure recovery decision trees (Section 10B) and multi-file workspace inspection rules (Section 12).
  - Isolated Diagnostics Section 11 as an on-demand add-on injected strictly when `@current_problems` or `@all_problems` is detected.
- **File Pre-Injection Tightening & Auto-Continuation Guard:**
  - Added auto-continuation bypass in `_handleSendMessage()` (`panelProvider.ts`) via `skipFilePreInjection = Boolean(retryContext?.isAutoFollowUp)`, eliminating redundant file reading loops and saving 5,000–15,000 tokens per auto-continuation turn.
  - Added optional `promptTier` gating to `extractFileMentions()` to suppress bare filenames (Pattern 3) and intent phrases (Pattern 4) on conversational turns, eliminating false positives (e.g. matching `express.ts` from casual chat) while preserving explicit `@mentions` and quoted filenames.
- **Visible Model Cost at Selection Point (Input / Output /M):**
  - Integrated live token pricing directly into the model selector dropdowns (Main Chat combobox, Reviewer combobox, and Reviewer Settings combobox).
  - Automatically converts OpenRouter's raw per-token rates (`prompt`, `completion`) into the industry-standard dollar rate per million tokens (e.g. `$3 / $15 /M`, `$0.15 / $0.60 /M`, or `Free`).
  - Added clean badges (`.combobox-item-price` and `.combobox-item-price.free`) with full tooltips showing exact rates: `Input: $X.XX / 1M tokens • Output: $Y.YY / 1M tokens`.
  - Added unit test suite in `test/pricingFormat.test.ts` covering free, micro-fractional, and standard model rates.

### Fixed
- **Intent-Driven Tier Derivation Heuristics:**
  - Resolved an issue in `panelProvider.ts` where checking `applyEditPerm !== 'deny'` unconditionally caused non-editing questions to default to the editing tier for all users.
  - Paired edit permission checks with explicit regex intent detection (`edit_file|create_file|patch` or actionable editing verbs `edit|fix|update|modify|refactor|create|add`), ensuring simple conversational questions cleanly trigger the conversational tier.
- **System Prompt Tier Verification Suite:**
  - Added calibrated unit tests in `test/systemPrompt.test.ts` validating token consumption bounds and strict section presence/exclusion per tier.

## [0.5.6] - 2026-10-13

### Added
- **Surface Undo Failure Messages in Webview UI:**
  - Added an actionable, dismissable `.undo-error-banner` inline alert inside the user message bubble when an Undo operation fails (e.g. running in standalone file mode without an opened workspace folder, or file restoration errors).
  - Explicit guidance informs the user exactly how to resolve the issue (e.g. `Undo unavailable: open a folder or workspace in VS Code to enable file checkpoints and turn rollback.`).
  - Status bar feedback: updates `#status-text` with `⚠️ Undo failed: <message>` in alert red (`#f85149`) with smooth automatic dismissal.
  - User cancellation feedback: displays clean 3-second `Undo cancelled` status text when the user dismisses or cancels the confirmation modal, replacing silent button resets.

### Fixed
- **Host Diagnostic Logging for Undo Pipeline:**
  - Added explicit diagnostic logs (`logger.warn('UNDO', ...)`, `logger.info('USER', ...)`, and `logger.error('UNDO', ...)`) capturing failure causes, pre-flight dialog cancellations, and drift warnings in `current.log`.

## [0.5.5] - 2026-10-10

### Added
- **Manual Model Refresh Button:**
  - Added a dedicated "Refresh Models" (🔄) button next to the model selector dropdown in the chat view.
  - Allows users to easily re-fetch the models list directly from the UI without restarting VS Code if a network error occurs during initial launch.
  - The button is dynamically hidden when models load successfully and only appears when a fetch failure is detected.

### Fixed
- **Terminal Execution Disk Desync (Ghost Reverts):**
  - Resolved a critical race condition where autonomous agents using terminal commands (`powershell`, `bash`) to verify their own `edit_file` changes would see outdated file contents.
  - Injected a global `vscode.workspace.saveAll()` flush immediately before delegating any command to `CommandRunner.executeCommand`. This perfectly synchronizes unsaved VS Code editor buffers with the physical disk, preventing "disk vs. buffer" mismatches and autosave overwrites.
- **Model Selection on Retry:**
  - Fixed a bug where clicking "Retry" or "Resume" on a stream error card would always force the request to use the model that originally sent the message, ignoring any new model selected by the user in the dropdown while the error card was visible. Retry/Resume now correctly prioritize the currently selected model (`currentModelId`).


## [0.5.4] - 2026-10-09

### Added
- **Infinite Auto-Retry Backoff for Autonomous Tasks:**
  - Implemented an intelligent exponential backoff state tracker in the Webview UI.
  - User Network Errors (e.g., connection lost) now auto-retry at 60s intervals for the first 5 attempts, then back off to 5-minute intervals infinitely.
  - Provider Errors (e.g., empty response, 502/504 Bad Gateway, timeouts) auto-retry at 30s intervals for the first 3 attempts, then back off to 5-minute intervals infinitely.
  - This guarantees that unattended/overnight autonomous tasks will simply pause and patiently poll during an internet outage or API downtime, rather than dying completely.


## [0.5.3] - 2026-10-09

### Fixed
- **Reviewer Stream UI Freeze (IPC Flooding):**
  - Resolved an issue where generating massive AI responses (e.g. 8,000+ tokens via `glm-5.3-flash`) would flood the VS Code Webview IPC channel with thousands of unthrottled `REVIEWER_STREAM_CHUNK` messages, causing the UI to silently drop them and freeze at "Reviewer thinking".
  - Implemented a 50ms batching throttle in `panelProvider.ts` to aggregate stream chunks before dispatching them to the frontend, exactly matching the safety mechanisms of the main chat stream.


## [0.5.2] - 2026-10-09

### Fixed
- **Reviewer Pinned Context Hallucinations:**
  - Modified the system prompt injection for the pinned context file to instruct the model to apply the rules implicitly.
  - This prevents the model from repetitively announcing "Based on the pinned file..." in its responses unless directly asked.
- **Notification Sound Autoplay Block:**
  - Resolved an issue where agent completion notification sounds were silently suspended by the browser's strict Autoplay Policy because the `AudioContext` was initialized asynchronously.
  - Added global event listeners (`click`, `keydown`) in the webview to silently unlock and warm up the `AudioContext` on the user's first UI interaction, ensuring subsequent agent notifications play reliably.


## [0.5.1] - 2026-10-09

### Fixed
- **Intermediate Execution Steps Drawer Scroll & Content Clipping:**
  - Removed artificial single-line clamping (`collapseIntermediateStepDetails` summary compression) on step detail descriptions in the intermediate execution drawer so full operational details remain accessible.
  - Added `flex-shrink: 0` to `.intermediate-steps-drawer` in `style.css` to prevent flex containers from compressing drawer dimensions during active execution or streaming.
  - Enabled smooth vertical scrolling and unconstrained content visibility within the execution details dropdown, ensuring all diagnostic outputs and step summaries can be fully reviewed when expanded.

## [0.5.0] - 2026-10-08

### Added
- **Universal "Send to Reviewer" from Chat:**
  - Added one-click `🔍 Review File` action button directly in Proposed Edit diff card headers (`📁 Proposed Edit: <filePath>`), reading the target file from the workspace, switching to the Reviewer panel, and pre-filling the review context.
  - Added dual **Floating Selection Toolbar** (`Clarify` & `Send to Reviewer`) that appears immediately upon highlighting any text in assistant message bubbles, allowing one-click forwarding of selected snippets to the Reviewer.
  - Expanded in-chat file link & chip recognition to include Dart (`.dart`), Kotlin (`.kt`, `.kts`), Swift (`.swift`), Gradle (`.gradle`), etc., with hover action (`🔍 Review`) to send referenced workspace files directly to the Reviewer.
  - Added `🔍 Review` action in assistant message bubble headers with intelligent text selection detection: forwards the highlighted text snippet when selected, or forwards the entire message body if no text is selected.
  - Added Reviewer context population lifecycle (`SEND_FILE_TO_REVIEWER`, `SEND_CONTENT_TO_REVIEWER`, `REVIEWER_CONTEXT_POPULATED`) with automatic tab navigation, attachment pill rendering, file size formatting, and custom prompt pre-population.
  - Added safe non-existent file guards preventing crashes when deleted or invalid file paths are clicked.

## [0.4.9] - 2026-10-08

### Added
- **Terminal Self-Healing Failure Diagnostics & Strategic Pivot Delegation:**
  - Added full diagnostic context handoff when terminal auto-retries reach `MAX_TERMINAL_RETRIES` (`currentRetryCount >= 5`), instead of halting silently.
  - Automatically compiles complete execution history including the failing command, execution outcome, exit code, and truncated stderr/stdout diagnostics.
  - Enhanced Safeguard 2 (repeated failing command detection): instead of abruptly breaking execution on the first repeat without edits, hands failure context back to the model once with explicit instructions to pivot away from repeating failing commands.
  - Added single-fire failure delegation guard (`hasDelegatedFailure: true` in `retryContext`) to prevent infinite recursive self-healing loops if commands proposed during the pivot turn also fail.
  - Feeds failure context back as an automated follow-up turn (`isAutoFollowUp: true`) directing the model to classify the error (e.g. `MISSING_SCHEMA`, `COMPILE_ERROR`, `ENV_ISSUE`), apply a completely different strategy, or offer 2–3 concrete actionable options to the user.
- **Failed-Edit Precedence Over Terminal Commands:**
  - When proposed file edits in a turn fail to apply, terminal commands (e.g. tests/compilers) are skipped immediately.
  - Prevents testing stale/unmodified code that would burn retry budget, giving file self-healing full precedence to fix search blocks before verification commands run.
- **Anti-Sleep & Port Probe Failure Safeguards:**
  - Updated system prompt instructions to forbid blind sleep loops greater than 5 seconds (Start-Sleep 60/120, sleep 60) when waiting on background services/emulators.
  - Added anti-stall directive in continuation prompts when port probes (e.g. Test-NetConnection returning False) or health checks fail, directing the model to inspect crash logs (Get-Content <log>) and verify runtime prerequisites (java -version) rather than repeating sleep loops.
  - If prerequisites are missing or unconfigured, mandates classifying immediately as [ENV_ISSUE] and explaining the blocking prerequisite to the user.
- **Upstream Provider Quota & Balance Error Detection:**
  - Added pattern matching for upstream proxy credit exhaustion streamed as regular HTTP 200 text (e.g. `Your quota is exhausted`, `balance: -... USDT`, `API key status: exceeded`).
  - Surfaces a structured error card with `⚠️ Upstream Provider Quota Exhausted` and actionable `Retry Now` and `Resume Task` buttons instead of silently treating it as conversational text and stopping.
- **Active Implementation Plan Task Anchor & Continuous Execution Heartbeat:**
  - Injected an ultra-compact (~50 tokens) `activePlanAnchor` into the system prompt containing only the current plan's checklist items (`- [ ]`, `- [x]`) whenever a multi-step plan is underway.
  - Keeps the model anchored to the plan so it never edits random files out of scope or loses track of its pending tasks.
  - Dynamic Auto-Followup Limit: Expanded `MAX_AUTO_FOLLOWUPS` dynamically from 10 to 30 whenever an active plan has pending checklist items, ensuring multi-step workflows do not halt prematurely.
- **Universal Verification Principles (All Stacks & Languages):**
  - Codified cross-stack verification guidelines in the system prompt: mandates fast, non-destructive diagnostic tools (`tsc --noEmit`, `npm test`, `pytest`, `cargo test`, `flutter analyze/test`, `go test`) for task completion verification.
  - Forbids heavy release packaging (e.g. `flutter build apk`, `docker build`, `assembleRelease`, `electron-builder`) as verification steps unless explicitly requested by the user.
  - Enforces synchronous execution: forbids detaching verification commands into background processes (`Start-Process`, `nohup`) so exit codes are always reliably tracked.

### Fixed
- **Silent Halting on Duplicate Commands and Exhausted Auto-Retries:**
  - Resolved premature halting in Safeguard 2 where repeating a command without file changes terminated the session before reaching the retry limit.
  - Replaced the dead-end behavior where reaching `MAX_TERMINAL_RETRIES` simply posted an assistant warning message and broke the loop, leaving the task incomplete and the user without guidance.

## [0.4.9] - 2026-10-07

### Added
- **Human-Friendly Stream Error Classification & Structured UI Presentation:**
  - Added structured `errorTitle` and `detail` representation to stream failure handling, replacing ambiguous, technical error strings with clear, actionable messages.
  - Classified 4 distinct failure scenarios:
    1. **Provider Busy / Timeout:**
       - **Title:** `⚠️ AI Model Is Not Responding`
       - **Detail:** `<model> is taking longer than usual or is experiencing heavy traffic. Try again or select another model.`
    2. **Mid-Stream Interrupted / Stalled:**
       - **Title:** `⚠️ Response Interrupted`
       - **Detail:** `The connection to <model> dropped mid-response. Click Resume Task to pick up where it left off.`
    3. **User Network Connectivity / Dropped Connection:**
       - **Title:** `⚠️ Internet Connection Issue`
       - **Detail:** `Could not reach the server. Please check your network connection and click Retry Now.`
    4. **Provider Server Failure / Outage (HTTP 5xx / Bad Gateway / Service Unavailable):**
       - **Title:** `⚠️ AI Service Temporarily Unavailable`
       - **Detail:** `The provider hosting <model> is having server issues. Try switching to an alternative model.`
  - Redesigned in-chat error card UI to present a bold headline row, an action-oriented detail explanation, and immediate action buttons (`🔁 Retry Now`, `▶ Resume Task`, `✕ Dismiss`).
  - Retained automatic 30s countdown retry for network and timeout errors, disarming automatically upon prompt input focus.
- **Accurate Notification Sound Timing & Permission Prompt Alerting:**
  - Decoupled notification chime playback from the webview stream end heuristic (`!msg.isIntermediateStep` on `MESSAGE_STREAM_DONE`) which was mistakenly chiming after the initial terminal command was proposed and staying silent after the final completion summary.
  - Introduced dedicated backend-driven `PLAY_NOTIFICATION_SOUND` message dispatched when:
    1. The agent finishes all processing turns and becomes idle (`!triggeredFollowUp`).
    2. The agent requests user permissions via modal dialogs (`ConfirmationDialogs.onPermissionPrompt`).
    3. The agent pauses to ask user permission before running a side-effecting terminal command in `ask` mode (`PENDING_TERMINAL_COMMAND`).
- **Internal Silent Retry for Empty Completions During Auto-Execution:**
  - When an AI model emits an empty completion during automated follow-up turns or multi-step execution plans, retries are handled internally and silently up to `MAX_EMPTY_RETRIES = 2`.
  - Dispatches `MESSAGE_STREAM_DISCARD` to clean up intermediate empty bubbles without cluttering the chat with repetitive empty response cards.
  - If retries are exhausted, halts auto-execution cleanly and surfaces a single structured error card with `⚠️ AI Model Returned Empty Response` and `Resume Task` / `Retry Now` actions.

### Fixed
- **Premature & Missing Notification Sound Fix:**
  - Resolved bug where the agent notification sound chimed immediately after the first terminal command was proposed, but remained completely silent when the entire task and final summary concluded.
  - Eliminated the faulty webview stream end heuristic (`!msg.isIntermediateStep` on `MESSAGE_STREAM_DONE`) which misclassified intermediate automated follow-up turns.
  - Added notification alert support for user permission requests: the notification chime now sounds when user permission is requested (VS Code modal confirmation dialogs for terminal commands, file edits, file deletions) and when terminal execution pauses in `ask` mode (`PENDING_TERMINAL_COMMAND`).
- **10-Turn Empty Response Auto-Execution Loop & Duplicate Error Card Fix:**
  - Fixed bug where an empty response failure emitted duplicate error indicators (both a top yellow assistant chat bubble and a bottom red structured error card).
  - Empty response completions now emit `MESSAGE_STREAM_DISCARD` to remove the streaming placeholder without appending a duplicate text bubble to history or triggering `MESSAGE_STREAM_DONE`.
  - Consolidated empty response failure rendering into a single, clean structured error card (`type: 'ERROR'`) with `Retry Now` and `Resume Task` buttons.
- **Transient Error Card Cleanup Across Chat Actions:**
  - Error cards now vanish immediately (`errorCard.remove()`) when the user or auto-execution clicks **"Retry Now"**, **"Resume Task"**, or **"Dismiss"**, keeping the chat stream clean and uncluttered.
  - Retained full diagnostic logging in logger for all errors and internal retry attempts.

### Changed
- **Host-Webview Error & Sound Messaging Protocol:**
  - Updated `HostToWebviewMessage` in `src/webview/messages.ts` with `PLAY_NOTIFICATION_SOUND` event, putting sound playback timing under authoritative host lifecycle control (`!triggeredFollowUp` on completion, modal dialog prompt, or `ask` mode pending action).
  - Updated `HostToWebviewMessage` with `MESSAGE_STREAM_DISCARD` event, allowing the backend to silently remove intermediate streaming placeholders during silent retries.
  - Updated `HostToWebviewMessage` `ERROR` type in `src/webview/messages.ts` to include optional `errorTitle?: string`.
  - Updated webview renderer in `src/webview/ui/main.ts` and styling in `src/webview/ui/style.css` to support multi-line title + detail layouts with clean button alignment.

### Observability & Logging
- **Structured Diagnostic Error Logging:**
  - Added dedicated diagnostic logger tags in `panelProvider.ts` for each failure classification (`[STREAM_ERROR: TIMEOUT]`, `[STREAM_ERROR: STALLED]`, `[STREAM_ERROR: NETWORK]`, and `[STREAM_ERROR: PROVIDER_OUTAGE]`), preserving raw error metadata while surfacing clean explanations to users.
  - Achieved full parity in the Reviewer sub-system: applied identical human-friendly error titles/details and structured logging tags (`[REVIEWER_ERROR: TIMEOUT]`, `[REVIEWER_ERROR: STALLED]`, `[REVIEWER_ERROR: NETWORK]`, and `[REVIEWER_ERROR: PROVIDER_OUTAGE]`) across `REVIEWER_STREAM_ERROR`.
  - **Comprehensive Silent Retry Logging:** Even though intermediate empty retries are completely silent on the UI, every attempt is recorded in the diagnostic log:
    - Logged on each attempt: `[EMPTY_RESPONSE: AUTO_RETRY] Model <model> returned empty completion (attempt <x>/2). Retrying internally...`
    - Logged on exhaustion: `[EMPTY_RESPONSE: FAILED] Model <model> returned empty completion after 2 attempts. Halting auto-execution.`

## [0.4.8] - 2026-10-02

### Added
- **Candidate Mention Extraction (`extractFileMentions`):**
  - Proactively scans user chat prompts to detect file references across 4 distinct pattern sets:
    1. Explicit `@` mentions (e.g. `@src/index.ts`, `@file:README.md`).
    2. Quoted filenames (e.g. `"PRD.md"`, `'database.sql'`, `` `config.json` ``).
    3. Bare filenames with recognized extensions (`.md`, `.ts`, `.js`, `.dart`, `.py`, `.sql`, `.prisma`, `.json`, etc.).
    4. Common intent phrases (e.g. `copy PRD.md into prdv2.md`, `read foo.dart`, `based on spec.md`, `open auth.ts`).
  - Added URL immunity: ignores file-like extensions inside HTTP/HTTPS web links.
  - Normalization: trims whitespace, strips leading `@`, `file:`, or `./` relative path prefixes, strips trailing punctuation, deduplicates case-insensitively, and limits extraction to top 5 candidates.
- **Proactive File Pre-Injection Loop:**
  - In `_handleSendMessage()`, resolves extracted file candidates via `ContextReader.findAndReadWorkspaceFile()` before prompt generation.
  - Injects target file buffers directly into prompt `<file_content>` tags, eliminating wasteful chunked terminal reads (`Get-Content`) by models.
  - Automatically skips the active editor file (already injected) and prevents duplicate file entries.
  - Budget guardrail: caps total injected referenced content across files at `MAX_REFERENCED_CONTENT_CHARS = 120_000` (~40,000 tokens).
  - Missing file intelligence: flags non-existent referenced files under `missingReferencedFile` so the model knows to create them instead of searching fruitlessly.
  - Robust fault tolerance: wraps all candidate file lookups in silent `try/catch` handlers to never disrupt message sending.
- **Workspace Memory in Context Switch (`openrouter.context.workspaceMemoryInContext`):**
  - Added dedicated toggle in the Context Management settings view: *"Workspace Memory in Context"*.
  - Strictly controls prompt injection: when toggled OFF, `<recent_workspace_activities>` is omitted from outgoing AI prompts to conserve tokens or run clean turns.
  - Logging continuity: activity logging to `.openrouter/activity_log.md` continues uninterrupted even when context injection is toggled OFF, preserving complete session auditability.
  - Immediate turn-by-turn effect: toggling immediately impacts the very next turn with zero window reload required.
  - Checkpoint undo consistency: rolling back or undoing turns appends an explicit reverted status (`~~[Task Summary]~~ [REVERTED by user]`), preserving truth across turns.
- **Memory Leakage Prevention & Workspace Isolation:**
  - Added strict exclusions in `ContextReader` for `.openrouter/` and `activity_log.md`:
    - Active editor tabs viewing `activity_log.md` are ignored (`hasContext: false`), preventing unintentional context ingestion when browsing logs.
    - Excluded from `listWorkspaceFiles` directory discovery glob, so `.openrouter` never appears in workspace file trees.
    - Excluded from `findAndReadWorkspaceFile`, preventing proactive pre-injection or model file reads from querying internal activity logs as source code files.
- **Shadow Git Protection for Memory Logs:**
  - Added `.openrouter/` to hardcoded ignore lists in `GitignoreRespect`.
  - Guarantees `.openrouter/activity_log.md` is never reverted, corrupted, or deleted during checkpoint restore operations.
- **Relocation of Workspace Memory Storage to Extension Storage:**
  - Relocated `activity_log.md` from the project workspace folder (`.openrouter/activity_log.md`) to VS Code's internal workspace storage: `context.storageUri/memory/activity_log.md`.
  - **Zero Workspace Clutter:** Prevents `.openrouter` folder from cluttering project root directory or VS Code file explorer.
  - **Git & Shadow Git Immunity:** Stored securely in extension storage (`AppData/Roaming/Code/User/workspaceStorage/...`), completely outside user git tracking, shadow git commits, file undos, and workspace cleanups.
  - **Diagnostic Logger Coexistence:** Diagnostic logging uses `context.storageUri/logs/` while memory logs use `context.storageUri/memory/`, providing separate lifecycles, clear directory isolation, and zero collision.
  - **Automatic Seamless Migration:** On first access of an existing workspace, if `.openrouter/activity_log.md` is detected, its contents are automatically migrated to `context.storageUri/memory/activity_log.md`, preserving all existing memory history.
- **Agent Response & Task Completion Notification Sound (`openrouter.notificationSound`):**
  - Added notification audio alert that plays whenever the agent finishes responding or completes a task.
  - Intermediate step immunity: notification sounds trigger exclusively on final turn completions (`MESSAGE_STREAM_DONE` when `!msg.isIntermediateStep` and `REVIEWER_STREAM_DONE`), avoiding disruptive chatter during multi-step tool calls.
  - Zero external dependency synthesizer: built entirely using standard HTML5 Web Audio API (`AudioContext`) oscillators with smooth acoustic envelopes, fully immune to Content Security Policy (CSP) media blocks and requiring 0 npm packages.
  - **Tone Presets (`openrouter.notificationTone`):**
    - Configurable preset selection in Settings:
      1. `bell` (Default): Soft Bell featuring two consecutive identical harmonic strikes (spaced 200ms apart with smooth acoustic decay).
      2. `chime`: Subtle two-tone rising chime ($D_5 \rightarrow A_5$).
      3. `pop`: Snappy, minimal wooden bubble pop.
      4. `ding`: High crystal sine ding with harmonic tail.
  - **Settings UI Controls & Real-Time Test Button:**
    - Dedicated "Notifications & Sound" section in Settings view with a master toggle checkbox (`Play notification sound on completion`).
    - Sound Tone dropdown selector dynamically synced with extension state.
    - Inline "▶ Test" preview button to instantly audition the selected preset before saving.

### Fixed
- **Network Timeout Retry Fix & Seamless Task Continuation:**
  - Resolved an issue in `src/webview/ui/main.ts` where the inline `Retry Now` button became completely unresponsive after the 30-second auto-retry countdown expired (caused by `isDisarmed = true` in `clearCountdown()` short-circuiting subsequent manual clicks in `triggerRetry()`).
  - Decoupled countdown disarming from user-initiated retries, ensuring manual `Retry Now` clicks reliably execute regardless of countdown status or expiration.
  - Added an intuitive **"▶ Resume Task"** action button to the stream error card whenever an active implementation plan is underway in history (`canResume: true`). Allows seamlessly continuing multi-step execution from the exact point of connection interruption without starting over or re-running completed modifications.
- **Premature Walkthrough Prevention & Hard Physical Execution Gate:**
  - Hardened system prompt `WALKTHROUGH RULES` with an explicit physical execution gate: ````walkthrough blocks must be the very last artifact produced in a task and require all checklist items (- [x]) to be completed, modified files inspected/compiled, and at least one non-read-only verification command (test runner, build, lint, or compiler) to have physically executed with exit code 0 in `Recent Terminal Outputs`.
  - Added a mandatory `PRE-WALKTHROUGH SELF-CHECK` 3-point checklist directive in Section 10 (Step 4: Verify Before Declaring Done) directly preceding the walkthrough block format definition.
  - Added a runtime walkthrough guard in `OpenRouterPanelProvider` (`panelProvider.ts`): inspects active plan documents for unchecked items (`- [ ]`) and verifies that `TerminalOutputTracker.getRecentOutputs()` contains a successful non-read-only command execution with exit code 0.
  - Automatically discards premature walkthrough artifacts and schedules an autonomous correction turn directing the model to execute verification commands before emitting the final walkthrough.
- **Physical Test Execution Gate & Anti-Hallucination Guardrail:**
  - Enforced a strict execution gate preventing models from fabricating test outcomes (e.g. "All green", "All tests passed") without physically executing the test suite (`flutter test`, `npm test`, `pytest`) in the terminal with exit code 0 during the active turn.
  - Implemented dependency and environment verification prerequisites before any test commands run, preventing runaway self-healing loops when dependencies fail to resolve.
  - Enforced that implementation walkthrough plans and completion summaries are strictly the **final artifact** generated only after all code edits and terminal test verifications have completed cleanly.

---

## [0.4.7] - 2026-09-25

### Added
- **Workspace-Isolated Diagnostic Logging:**
  - Upgraded diagnostic logger to write logs per-workspace inside `context.storageUri/logs/current.log` (falling back to `context.globalStorageUri/logs/` when running in standalone file mode).
  - Guarantees zero crosstalk between projects: opening, switching, or running multiple workspaces simultaneously preserves independent logs per workspace.
  - Reset in-memory session buffer and start time upon workspace activation, preventing past workspace sessions from contaminating live session views.
  - Added clean session separator headers (`=== Session Resumed [Date/Time] [Workspace: name] ===`) when reopening an existing project.
  - 2MB log rollover: automatically rolls `current.log` to `previous.log` upon hitting 2MB, preventing unconstrained disk growth while maintaining continuous recent history.
- **Full Date & Time Timestamps (`YYYY-MM-DD HH:MM:SS`):**
  - Enhanced all log line stamps from time-only (`[HH:MM:SS]`) to unambiguous standard calendar timestamps (`[YYYY-MM-DD HH:MM:SS]`), ensuring full multi-day auditability.
- **Enhanced Diagnostic Report & "View logs" Command:**
  - `openrouter.openDiagnosticLog` ("View logs" button in settings) directly opens the active workspace's `current.log`.
  - `openrouter.copyDiagnosticLogs` includes the workspace name and full calendar timestamp in the export header.
- **Complete Storage Isolation from Git & Undo:**
  - Stored inside VS Code's internal extension storage (`AppData/Roaming/Code/User/workspaceStorage/...`), completely outside workspace repositories. Immune to `git clean`, `git reset`, branch changes, shadow-git commits, or file undos.

---

## [0.4.6] - 2026-09-25

### Added
- **Reviewer Pinned Context File (Strictly Per-Workspace):**
  - Added `openrouter.reviewer.pinnedContextFile` configuration setting stored per-workspace (`ConfigurationTarget.Workspace`).
  - Added dedicated Settings UI controls in the Reviewer Model section: a relative path input, native VS Code workspace file browser dialog ("Browse..."), and clear button.
  - Path traversal protection: paths resolving outside the workspace root (e.g. `..` or absolute external paths) are blocked and warned against.
  - Reviewer header indicator: visual `📌 Pinned Context:` pill displaying the relative file path with click-to-open editor integration.
  - Pinned attachment badge: reviewer chat cards now support a distinct amber `Pinned` tag for pinned context files.
- **Hierarchical System Prompt Payload Assembly:**
  - Configured Reviewer System Prompt remains authoritative and is rendered first.
  - Pinned context file contents are injected under `# Pinned Workspace Context (<relative_path>):`.
  - The document under review (plan or walkthrough) follows under `# Document Under Review (<label>):`.
  - Clean initial user prompt: clicking "Review" on a plan card now creates a clean `"Review this plan"` user turn with an attached plan document card, rather than echoing the entire system prompt.
- **Context Reset & New Session Preservation:**
  - Clicking the refresh/reset button (`🔄`) clears chat messages and active session state while strictly preserving the workspace pinned context file configuration.
- **Reviewer In-Place Retry & Downstream Truncation:**
  - Clicking `🔄 Retry` on an assistant response now cleanly replaces the rejected response in-place (no stacking) and truncates any downstream turns.
  - Added a confirmation modal warning the user when retrying an earlier turn with subsequent downstream messages.
- **Reviewer Inline Prompt Editing (`✏️ Edit`):**
  - Added an `Edit` action button on user chat bubbles in the Reviewer.
  - Interactive inline editor allows modifying user instructions directly inside the message bubble with `Save & Submit`, `Cancel`, `Ctrl+Enter`, and `Escape`.
  - Strictly preserves attached artifacts (e.g. `Plan docs`) while updating prompt text.
  - Automatically truncates subsequent downstream conversation turns and triggers a fresh streaming review.
- **Generation Lock for Reviewer Actions:**
  - Both `Edit` and `Retry` action buttons are strictly disabled (`disabled = true`, pointer-events none, dimmed opacity) while the Reviewer is actively generating text (`busy = true`).
  - Backend message handler guards against concurrent execution; only the **Stop** button is permitted to interrupt model generation.
- **Docked Sequential Terminal Permission Bar (`runTerminal = 'ask'`):**
  - Added dedicated `#pending-terminal-bar` docked directly above the user chat textarea inside `.input-bar`, completely separate and isolated from the file edits approval bar.
  - When `openrouter.runTerminal` is configured to `'ask'`, auto-execution strictly pauses at each terminal command and displays the pending command with **Allow** (`✓ Allow`) and **Deny** (`✕ Deny`) buttons.
  - Sequential execution guarantee: commands execute strictly one at a time upon individual user confirmation; denying cancels execution and unblocks the session cleanly without running subsequent commands.
- **Batched 1-Line Collapsible Terminal Command Dropdowns:**
  - Assistant responses proposing multiple terminal commands within a single turn are grouped and rendered inside a sleek, single-line `<details class="terminal-command-batch-details">` dropdown (`▶ 💻 N Terminal Commands... [Expand ▾]`).
- **1-Line Stream Error Card & 30-Second Auto-Retry Countdown:**
  - Redesigned stream error cards (e.g. stalled responses or provider timeouts) into a sleek, ultra-compact single-line layout: `⚠️ Stream stalled (no data for 45s) | [🔁 Retry Now (30s)] [✕ Dismiss] • Auto-retrying in 30s...`.
  - Automatically arms a 30-second countdown for stalled streams, network drops, or timeout errors, allowing unattended sessions to self-recover without manual intervention.
  - Interactive controls: `Retry Now` triggers immediately on click; `✕ Dismiss` halts the timer and cleans up the error; focusing the prompt textarea immediately disarms the timer so it never interrupts the user while typing.
- **Results & Walkthrough Doc Persistence on Reload:**
  - Fixed an over-aggressive history filter in `_loadChatHistory()` that previously suppressed assistant turns created during automated execution.
  - Results docs (`📄 Results docs ready — [view]`), walkthrough documents, and plans are now strictly preserved and rendered on window reloads and session switches.
- **Collapsible Failure Diagnosis & Compact Self-Healing Retries:**
  - Replaced giant uncollapsed diagnostic error dumps (`Auto-Healing Diagnosis` with 40+ lines of raw compiler/test output) with sleek, compact status cards featuring an interactive collapsible dropdown (`<details>`).
  - Intermediate commentary step notes now stay cleanly collapsed by default (`open = false`), keeping the chat focused on user prompts and final artifacts.
  - Terminal and file edit retry notices render as streamlined single-line status pills, preventing repetitive retry blocks from flooding the viewport.
- **Enhanced Reviewer Diagnostic Logging & Monitoring:**
  - Added granular `'REVIEW'` diagnostic logging covering: pinned context updates and clears, file read size and token estimates, path rejection warnings, stream start/completion/cancellation metrics, context reset operations, and in-place retry/edit rewinds.

---

## [0.4.5] - 2026-09-25

### Fixed
- **Process Cancellation & Aggressive Child Termination:**
  - Upgraded process termination on cancellation or timeout: uses non-blocking `cp.spawn('taskkill', ['/pid', pid, '/T', '/F'])` on Windows to immediately destroy the entire child process tree.
  - Added daemon cleanup for background compilation processes (e.g. running `gradlew.bat --stop`) so orphan `java.exe` instances do not lock workspace files.
- **Intent-Based Terminal Auto-Run Suppression:**
  - Added user intent detection in `panelProvider.ts`: if the user explicitly asks to run commands manually or asks not to retry (e.g. *"I will run it by myself"*, *"don't run"*), automatic execution of side-effecting terminal blocks is suppressed for that turn.
  - Interactive terminal cards remain visible in chat so the user can execute them with a single click if desired.
- **Normalized Command Similarity in Self-Healing Retry:**
  - Upgraded loop detection to compare normalized command signatures (executable + primary action) rather than strict exact string matches. Prevents models from repeating failing operations with superficial flag variations when no workspace files were edited.
- **Consolidated Per-File Edit Cards & UI Grouping:**
  - Multiple edit blocks proposing changes to the same file within a single turn are now grouped under a single card with an aggregated changes counter (`data-file-key`), preventing fragmented UI walls of cards.
- **Apply as User Confirmation Semantics:**
  - Clicking Apply/Accept serves as user confirmation to transition UI state from `⏳ Pending` to `✓ Applied` without executing redundant duplicate disk writes.
- **Reject Rollback via Checkpoints:**
  - Clicking Reject rolls back file modifications on disk via `checkpointManager.revertCheckpoint()` and marks the activity manifest log as reverted.
- **SEARCH/REPLACE Anchor Matching Resilience:**
  - Added indentation/whitespace tolerance fallback in `DiffPreviewManager.resolveProposedContent` to prevent match failures on minor formatting differences.
  - Enhanced system prompt with single-block emission rules and full-file replacement recommendations when modifying >30% of a file.

---

## [0.4.4] - 2026-09-24

### Added
- **Model Memory (Persistent Cross-Session Activity Manifest):**
  - Added [MemoryManifest](file:///c:/Users/HP/Videos/Qubators/MVP/Openrouter%20code/src/memory/memoryManifest.ts) managing `.openrouter/activity_log.md` to record high-level tasks across sessions.
  - Automatically captures tasks with `IN PROGRESS` status as soon as edits touch disk, transitioning to `COMPLETED` when walkthroughs are generated.
  - Synchronized with shadow-git undo: clicking Undo marks entries as `~~[Task Summary]~~ [REVERTED by user]`, preventing cross-session hallucinations of undone code.
  - Auto-injects the most recent active tasks into new chat sessions under `<recent_workspace_activities>` with low token overhead (~150-250 tokens).
  - Ensured `.openrouter/` is cleanly ignored in `.gitignore`.

### Fixed
- **Non-Blocking Terminal Execution & Batch Continuation:**
  - Resolved freeze caused when read-only inspection commands (e.g. `type`, `cat`) failed with exit code 1. Replaced halting `break` with `continue`, ensuring all commands in a batch execute.
  - Added automated feedback loop that captures both successful and failing inspection command outputs and returns them to the model in an auto-continuation turn.
  - Capped terminal outputs at 3,000 characters to prevent context spikes while maintaining full model visibility.
  - Added system prompt guidance advising efficient file inspection practices while preserving complete model autonomy.

---

## [0.4.3] - 2026-09-24

### Fixed
- **Multi-Block Edit Chaining Per File (Strategy 1):**
  - Grouped all proposed edit blocks for the same file in a turn so that they resolve sequentially in memory against the file's original state before being applied to disk atomically in a single write operation.
  - Resolved `✗ Failed to apply` errors in "Ask before edit" mode where applying edit block 1 invalidated the `<<<< SEARCH` anchors of subsequent blocks for that file.
  - Updated both streaming auto-execution and bulk `ACCEPT_ALL_EDITS` to resolve chained blocks sequentially and emit unified status updates for each edit proposal.
- **Relaxed Empty SEARCH Block on New/Empty Files:**
  - Allowed empty `SEARCH` blocks when the target file is empty (0 bytes) or only whitespace, preventing false "Empty SEARCH block is not allowed" errors when creating new files with `edit_file:path`.
- **Self-Healing Duplicate Elimination:**
  - Enhanced the self-healing retry prompt to supply the real current file content and explicitly forbid re-declaring methods, classes, or imports that already landed in the file.
- **System Prompt Refinements:**
  - Added strict guidance instructing models to prefer `create_file:path` for brand-new files and consolidate edits to the same file into a single block.

---

## [0.4.2] - 2026-09-24

### Added
- **Process-Agnostic File Mutation Guard:**
  - Guaranteed that any file modification in the workspace—whether proposed via a standard `edit_file:<path>` block or executed through terminal commands (`echo ... > file`, `>>`, `Set-Content`, `Out-File`, `Add-Content`, `tee`, `touch`, `sed -i`)—is captured with a pre-execution snapshot and shadow-git checkpoint.
  - When `applyEdit` is set to `ask` ("Ask each time"), terminal mutations immediately generate interactive "Accept" / "Reject" review cards in the UI with file diff views and line counts.
  - **Non-Blocking Flow:** The AI continues executing autonomously without pausing or waiting for user interaction. Clicking "Accept" is a zero-write confirmation (no-op on disk, updates status badge to `✓ Applied`), while clicking "Reject" immediately undos and reverts the file to its pre-command state using the checkpoint.
- **Compact 1-Line Terminal Execution Dropdown:**
  - Consolidated all executed terminal commands in a turn (whether 1, 2, or 10 commands) into a single compact 1-line dropdown (`▸ ✓ Ran N terminal commands (all completed, exit code: 0)`), taking up ~28px in the chat feed.
  - Clicking expands the native `<details>` drawer to inspect individual command lines, exit codes, and output blocks with one-click copy.
  - Automatically suppresses redundant bulky terminal action cards in chat when terminal execution is set to `allow` or `allow_session`.
- **Channel Guidance with Full Read/Write Terminal Permissions:**
  - Added clear system prompt guidance advising the model that creating or modifying files is preferred via standard `edit_file:<path>` blocks so rich interactive diffs and line counts render cleanly for review, while confirming full permission to use terminal commands for both reads and writes when appropriate.
- **Comprehensive Shadow-Git Action Diagnostic Logging:**
  - Added structured `[SHADOW_GIT]` log events across the entire lifecycle to both `log-today.txt` and the diagnostic log viewer:
    - Shadow repository initialization and cleaning (`Initialised shadow git repository`, `Cleaned shadow git repository`).
    - Checkpoint creation initiation, commit SHA recording, description, and failure tracking.
    - Scoped restore operations (batch git checkout, individual fallback restore, file deletions).
    - Drift detection analysis (reporting clean files vs modified vs deleted workspace files).
    - Turn message checkpoint tagging and shadow repo HEAD ref updates during Undo actions.


---

## [0.4.1] - 2026-09-24

### Added
- **Optimistic File Apply with Zero-Write Accept & Checkpoint Revert in 'Ask' Mode:**
  - In 'Ask' mode, file edits proposed by the model are written to disk immediately alongside an instant pre-edit shadow-git checkpoint so developers can test and inspect live code in VS Code.
  - Clicking **Apply** / **Accept** is an idempotent, zero-write no-op on disk: updates the UI status badge to `✓ Applied`, disables buttons, and keeps the file intact without touching disk or duplicating code.
  - Clicking **Reject** immediately reverts the file both on disk and in any open VS Code editor buffer using the pre-edit checkpoint snapshot.

### Fixed
- **Double Write Elimination on Apply:**
  - Resolved root cause where clicking **Apply** appended duplicate content (e.g. repeated comments) into the target file.
  - Added strict idempotency guard to `DiffPreviewManager.applyEdit`: skips disk modification when the file's current content matches the resolved target content.
  - Added idempotency check to host `ACCEPT_EDIT` message handler: short-circuits with success when an edit was already applied optimistically.
- **Synchronized Host & Webview UI `editId`:**
  - Unified `editId` formatting across backend auto-execution and webview card rendering to `${messageId}-edit-${count}`, ensuring `EDIT_APPLIED` and `EDIT_REVERTED` events accurately target and resolve UI elements.
- **Permission State Recognition in Webview:**
  - Updated `renderEditProposal` in webview to treat both `allow` and `allow_session` as automatically applied, preventing phantom "Pending" cards from lingering with active "Apply" buttons when auto-apply is enabled.
- **Guarded Autonomous Continuation:**
  - Restricted autonomous follow-up execution turns to active plan executions in `allow`/`allow_session` modes. In `ask` mode, the model outputs its response for Turn 1 and halts, allowing the user to review before continuing.

---

## [0.4.0] - 2026-09-24

### Added
- **Optimistic File Edit Execution with 100% Instant Revert (Option 2):**
  - Captured pre-edit snapshots via shadow-git checkpoints and in-memory byte buffers before applying any modification.
  - Fully wired the **Reject** and **Reject All** buttons to immediately restore original files on disk and synchronize active VS Code editor buffers in real-time.
  - Added chat confirmation feedback (`↩️ Reverted: undone changes to <filename>`) and webview status badges (`↩️ Reverted`).
- **Intermediate Execution Step Details Collapse (Option B):**
  - Solved LLM commentary and observation spillage into chat during multi-step execution and verification turns (e.g. running `type prd.md`).
  - Automatically wraps intermediate explanatory commentary into a native collapsible drawer (`<details class="intermediate-step-details">`), presenting a clean `▸ Step Notes` toggle while keeping action cards prominently displayed.
  - Automatically expands notes if errors or warnings (`⚠️`, `failed`, `denied`) occur.
  - Leaves direct user-initiated responses and final completion/walkthrough messages fully expanded.
- **Comprehensive User Action & File Operation Diagnostic Logging:**
  - Added explicit `[USER]` and `[FILE]` logger events to `log-today.txt` and the diagnostic log viewer.
  - Logs disk write events (`Writing to file: <path>`) immediately prior to applying workspace edits.
  - Tracks all user decisions: single edit acceptance, bulk edit acceptance, edit rejections, manual terminal command triggers, diff previews, file navigation, session management (new, switch, rename, delete), and permission toggles.
- **Non-Blocking Multi-Step Execution in 'Ask' Mode:**
  - Guaranteed continuous task progression across multi-file plans without freezing or waiting for user confirmation between consecutive file edits.
- **Token Limit Auto-Resume:**
  - Detects model completions truncated by provider output limits (`finish_reason: length`) and automatically dispatches continuation prompts.
- **Natural Language Approval Intent Matching:**
  - Expanded approval detection regex in `panelProvider.ts` to recognize conversational affirmations (e.g. "start", "do it", "carry on", "go ahead", "approved").

### Fixed
- Fixed bug where clicking **Reject** on an edit card did not undo changes on disk or revert open editor tabs.
- Fixed premature execution halting after file application during implementation plans.
- Fixed editor buffer vs. file-system synchronization lag when restoring files from shadow-git.

### Changed
- Preserved 100% passing test suite across all 5 test suites (308/308 tests).
- Packaged production VSIX bundle: `openrouter-0.4.0.vsix`.

---

## [0.3.0] - 2026-09-20

### Added
- **Reviewer Sidecar Workflow:**
  - Split reviewer panel for reviewing and critiquing plans, walkthroughs, and standalone documents.
  - Integrated reviewer feedback loop with selective text quotation and return to the main model.
- **Smart Scroll Management:**
  - Smooth scroll-to-bottom pinned scrolling with floating scroll-bottom button indicators.
- **Per-Turn Shadow-Git Checkpoints & Undo Safety Net:**
  - Isolated turn rollback restoring files and rewinding chat state cleanly via shadow-git commit trees.
- **Two-Tier Document System:**
  - Extraction and persistence of independent `.md` files for implementation plans and results walkthroughs.

### Fixed
- Prevented auto-scroll jitter when users manually scroll up to read earlier responses during active streaming.
- Resolved markdown code block fence truncation issues in streaming chunks.

---

## [0.2.0] - 2026-09-15

### Added
- **Targeted Search/Replace Block Parser:**
  - Fuzzy-tolerant search/replace block parsing with trailing whitespace and delimiter normalization.
  - Accidental code fence unwrapping and EOF append fallbacks.
- **Granular Permission Manager:**
  - Category-based permissions (`applyEdit`, `runTerminalCommand`, `createDeleteFiles`).
  - Support for `allow`, `ask`, and `deny` states, plus session-scoped overrides (`allow_session`).
- **Terminal Self-Healing & Classification:**
  - Automated retry and error feedback on non-zero exit codes.
  - Infinite-loop breaker detecting duplicate failing terminal commands.
- **Usage Store & Cost Tracking:**
  - Token counting and real-time cost calculation based on OpenRouter pricing tiers.
  - Filterable usage summary by project, model, and date ranges.

---

## [0.1.0] - 2026-09-01

### Added
- Initial extension release connecting VS Code to OpenRouter API.
- Streaming chat webview with model selector, API key storage in SecretStorage, and basic markdown rendering.
