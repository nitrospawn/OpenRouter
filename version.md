# OpenRouter Extension Version History & Changelog

All notable changes, bug fixes, architectural enhancements, and operational updates are documented in this file whenever a version number is bumped or a release milestone is reached.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
