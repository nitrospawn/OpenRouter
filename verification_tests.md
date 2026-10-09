# OpenRouter Extension — Comprehensive Verification & Test Specification

This document provides an end-to-end, rigorous manual and automated test matrix for the entire OpenRouter VS Code Extension. It covers all features across the core systems: **Main Chat**, **Reviewer Agent**, **Terminal & Self-Healing Engine**, **File Operations & Diff Viewer**, **Model Memory**, and **Analytics & Governance**.

---

## Table of Contents
1. [Core Architecture & Panels](#1-core-architecture--panels)
2. [Main Chat Engine](#2-main-chat-engine)
3. [File Operations, Diffs & Checkpoint System](#3-file-operations-diffs--checkpoint-system)
4. [Reviewer Subagent & Code Review Workflow](#4-reviewer-subagent--code-review-workflow)
5. [Terminal Execution & Process Lifecycle Management](#5-terminal-execution--process-lifecycle-management)
6. [Self-Healing & Loop Prevention](#6-self-healing--loop-prevention)
7. [Persistent Model Memory (Activity Manifest)](#7-persistent-model-memory-activity-manifest)
8. [Context Assembling & Token Budgeting](#8-context-assembling--token-budgeting)
9. [Usage Tracking, Cost & Analytics](#9-usage-tracking-cost--analytics)
10. [Diagnostic Logging & Multi-Workspace Isolation](#10-diagnostic-logging--multi-workspace-isolation)
11. [End-to-End Regression Scenarios](#11-end-to-end-regression-scenarios)

---

## 1. Core Architecture & Panels

### TC-ARCH-01: Extension Activation & Webview Boot
* **Goal:** Verify seamless bootstrap on startup without unhandled errors.
* **Pre-conditions:** Valid OpenRouter API Key configured in settings.
* **Test Steps:**
  1. Open a workspace in VS Code.
  2. Click the OpenRouter icon on the Activity Bar.
  3. Verify the Webview chat interface renders immediately.
* **Expected Result:**
  - Chat interface renders with model picker, mode selector, and message input.
  - No error notifications in VS Code bottom-right toast tray.
  - Extension output channel records initialization cleanly.

### TC-ARCH-02: Mode Switching (Ask / Code / Architect / Reviewer)
* **Goal:** Verify that mode switching updates system prompts and behaviors accordingly.
* **Test Steps:**
  1. Cycle between **Ask**, **Code**, **Architect**, and **Reviewer** modes using the dropdown.
  2. Send a query in each mode.
* **Expected Result:**
  - **Ask Mode:** Provides explanations and proposes edits with user-applied confirmation.
  - **Code Mode:** Emits actionable edits and verification terminal commands.
  - **Architect Mode:** High-level system design and architectural guidance without unprompted writes.
  - **Reviewer Mode:** Triggers code review persona and diff analysis.

---

## 2. Main Chat Engine

### TC-CHAT-01: Streaming Responses & UI Smoothness
* **Goal:** Verify that markdown and code blocks stream smoothly without flickering or layout breaks.
* **Test Steps:**
  1. Ask for a detailed 300-line explanation or code generation task.
  2. Observe the stream rendering in real time.
* **Expected Result:**
  - Text, bolding, lists, and code blocks format correctly mid-stream.
  - Autoscroll follows text unless user scrolls up.

### TC-CHAT-02: User Cancellation / Stop Generation
* **Goal:** Verify that clicking "Stop" cleanly terminates incoming tokens.
* **Test Steps:**
  1. Submit a prompt that generates a lengthy response.
  2. Click the **Stop** (square icon) button midway.
* **Expected Result:**
  - Generation halts immediately.
  - UI returns to ready state with input enabled.
  - Tokens and cost up to cancellation are accurately tracked.

### TC-CHAT-04: Single-Line Stream Error Card & 30-Second Auto-Retry Countdown
* **Goal:** Verify that stream stalls and timeout errors render as a single-line status bar with an automatic 30s countdown, immediate retry button, and dismiss action.
* **Test Steps:**
  1. Trigger a stream stall (e.g. model provider does not send data for 45s).
  2. Observe the in-chat error card appearance in the message stream.
  3. Verify it renders on a single line: `⚠️ Stream stalled (no data for 45s) | [🔁 Retry Now (30s)] [✕ Dismiss] • Auto-retrying in 30s...`.
  4. Test countdown: observe seconds ticking down every second.
  5. Test `[🔁 Retry Now]`: clicking immediately cancels the timer and fires a clean retry request.
  6. Test `[✕ Dismiss]`: clicking immediately halts the timer and removes the card.
  7. Test focus disarm: focusing the prompt textarea stops the countdown so typing is not interrupted.
* **Expected Result:**
  - Entire error status and action controls stay on 1 single line without vertical header clutter.
  - When countdown reaches 0s, cleanly retries without duplicate text or scrambled tokens.

### TC-CHAT-05: Intermediate Execution Steps Drawer (Scrolling & Unconstrained View)
* **Goal:** Verify that the intermediate execution drawer expands properly without clipping or vertical compression and allows full vertical scrolling through all step details and diagnostics.
* **Test Steps:**
  1. Trigger an agentic task involving multi-step file operations or terminal command executions.
  2. During execution or upon completion, click to expand the intermediate steps dropdown drawer (`.intermediate-steps-drawer`).
  3. Inspect step descriptions, outputs, and diagnostic logs within the expanded list.
  4. Scroll vertically across the drawer content when multiple steps or multi-line outputs exist.
* **Expected Result:**
  - Full details for each intermediate step remain legible without artificial single-line truncation or summary clamping.
  - Drawer maintains `flex-shrink: 0` structure and does not collapse under flex parent layout constraints.
  - User can smoothly scroll vertically through the complete set of execution steps and review all actions taken.

---

## 3. File Operations, Diffs & Checkpoint System

### TC-FILE-01: Single Consolidated Card per File (Turn-Level Grouping)
* **Goal:** Prevent UI card fragmentation when multiple edits are proposed for a single file in one turn.
* **Test Steps:**
  1. Ask: *"Update src/auth.ts: add a JSDoc comment at top, update the login method, and add a logout method."*
* **Expected Result:**
  - Only **ONE** edit card is rendered for `src/auth.ts`.
  - The card displays a counter badge (e.g., `(3 changes in file)`).
  - All changes for that file are consolidated in the diff view.

### TC-FILE-02: Apply Button Confirmation Semantics
* **Goal:** Verify that clicking Apply does not write or duplicate changes on disk again.
* **Test Steps:**
  1. In Ask mode, propose an edit to a file.
  2. Check disk content (file is staged/applied).
  3. Click **✓ Apply** (or Accept).
* **Expected Result:**
  - Badge transitions from `⏳ Pending` to `✓ Applied`.
  - No duplicate lines, no file corruption, no repeated disk writes.

### TC-FILE-03: Reject Button Rollback (Shadow Git Checkpoint)
* **Goal:** Ensure clicking Reject immediately reverts the file on disk to its pre-edit state.
* **Test Steps:**
  1. Record the original SHA / content of `test-file.txt`.
  2. Instruct model to modify `test-file.txt`.
  3. Verify file on disk has changed.
  4. Click **✕ Reject** on the card.
* **Expected Result:**
  - Card displays `✕ Rejected / Reverted`.
  - File on disk is restored to exact byte-for-byte pre-edit state.
  - Manifest logs the turn as reverted.

### TC-FILE-04: SEARCH/REPLACE Indentation & Spacing Resilience
* **Goal:** Verify that minor whitespace variations do not trigger anchor match failures.
* **Test Steps:**
  1. Create a file with 2-space indentation or trailing whitespace on blank lines.
  2. Ask for a targeted replacement of a function inside that file.
* **Expected Result:**
  - The fallback indentation matcher resolves the block cleanly without throwing `"proposed SEARCH block could not be found"`.

### TC-FILE-05: Extensive File Modification (>30% Threshold)
* **Goal:** Ensure large refactorings use full replacement rather than fragile fragmented anchors.
* **Test Steps:**
  1. Ask the model to completely rewrite a 50-line utility into a class.
* **Expected Result:**
  - Model emits full replacement without fragmented SEARCH/REPLACE anchors.
  - Diff renders cleanly and applies without errors.

---

## 4. Reviewer Subagent & Code Review Workflow

### TC-REV-01: Trigger Review on Active File
* **Goal:** Verify Reviewer correctly analyzes the currently focused editor tab.
* **Test Steps:**
  1. Open a source file with intentional flaws (e.g. unhandled promise, hardcoded secret).
  2. Switch to **Reviewer** mode or click **Review Active File**.
  3. Click **Start Review**.
* **Expected Result:**
  - Reviewer agent displays a structured review card containing:
    - Summary of file purpose.
    - Security / Vulnerability observations (flags the secret).
    - Performance / Error-handling suggestions.
    - Actionable proposed refactorings.

### TC-REV-02: Trigger Review on Uncommitted Git Diffs
* **Goal:** Verify Reviewer reviews all local git changes across modified files.
* **Test Steps:**
  1. Modify 2 different files locally without committing.
  2. Trigger **Review Git Working Tree**.
* **Expected Result:**
  - Agent loads `git diff` context.
  - Produces cross-file impact analysis and specific change critiques.

### TC-REV-03: Applying Reviewer Inline Suggestions
* **Goal:** Verify that reviewer-suggested fixes can be applied directly to code.
* **Test Steps:**
  1. In the Reviewer output card, locate a suggested fix with an `Apply Fix` button.
  2. Click **Apply Fix**.
* **Expected Result:**
  - Generates a consolidated edit proposal card.
  - Allows previewing diff and applying with checkpoint rollback protection.

### TC-REV-04: Handoff from Reviewer to Main Chat
* **Goal:** Verify seamless transition of findings into actionable implementation turns.
* **Test Steps:**
  1. After review completes, click **Discuss in Chat** or copy findings.
  2. Switch to Code mode and ask: *"Implement issue #2 found in the review."*
* **Expected Result:**
  - Main Chat preserves context of the review and writes the necessary fix code.

### TC-REV-05: Pinned Context File Configuration & Path Boundary Enforcement
* **Goal:** Verify that a workspace file can be pinned in settings, bounds are checked, and path traversal is rejected.
* **Test Steps:**
  1. Open Settings -> **Reviewer Model (Per-Workspace)**.
  2. In **📌 Pinned Context File**, click **Browse...** and select a file within the workspace (e.g. `docs/architecture.md`).
  3. Verify the relative path is displayed and the **Clear** button appears.
  4. Attempt to manually enter a path outside the workspace (e.g. `../external.md` or absolute path outside project root).
* **Expected Result:**
  - Valid workspace files are stored cleanly under `openrouter.reviewer.pinnedContextFile`.
  - Outside paths or traversal attempts trigger error notification and are rejected from settings.
  - Reviewer header displays `📌 Pinned Context: docs/architecture.md`.

### TC-REV-06: Hierarchical System Context & Reviewer Execution with Pinned Context
* **Goal:** Ensure plan review cleanly combines Reviewer System Prompt, pinned file contents, and plan document without leaking into the user chat bubble.
* **Test Steps:**
  1. Have a valid workspace file pinned (e.g. `spec.md`).
  2. Generate an implementation plan in Main Chat.
  3. Click **Review** on the plan card.
* **Expected Result:**
  - Reviewer view opens with user turn reading `"Review this plan"` accompanied by the `[📄 Plan docs]` attachment card.
  - Model system prompt receives the Reviewer System Prompt followed by `# Pinned Workspace Context (spec.md):` with full file contents, followed by `# Document Under Review (Plan docs):`.
  - Reviewer stream completion logs in diagnostic logger (`[REVIEW  ]`) with token breakdown (`artifactTokens` and `pinnedContextTokens`).
  - Clicking the context reset button (`🔄`) clears chat turns but **preserves** the pinned context file setting.

### TC-REV-07: In-Place Retry & Downstream Truncation with Generation Lock
* **Goal:** Ensure retrying an assistant response cleanly replaces the rejected turn in-place, truncates subsequent turns after confirmation, and locks during active streaming.
* **Test Steps:**
  1. In the Reviewer view, conduct a 3-turn conversation (User -> Assistant -> User 2 -> Assistant 2).
  2. Attempt to click `🔄 Retry` on Assistant 1 while Assistant 2 is actively streaming.
  3. Observe that `🔄 Retry` and `✏️ Edit` buttons are disabled (`disabled = true`, pointer-events none) during active streaming; only the `Stop` button works.
  4. Wait for generation to finish, then click `🔄 Retry` on Assistant 1.
  5. Confirm the warning modal informing that subsequent turns will be discarded.
* **Expected Result:**
  - Downstream turns (User 2 and Assistant 2) are removed from the view and persistent history store.
  - Assistant 1 bubble content is reset and immediately streamed with a fresh response in-place (no stacking).
  - Diagnostic logger outputs `'[REVIEW  ] Retrying reviewer turn...'`.

### TC-REV-08: Inline Edit User Prompt with Attachment Preservation & Rewind
* **Goal:** Ensure user prompt can be edited inline, attached documents/plans are strictly preserved, downstream turns are rewound, and actions are locked during generation.
* **Test Steps:**
  1. Review a plan (User 1 has attached `[📄 Plan docs]`), followed by assistant review and a follow-up question (User 2 -> Assistant 2).
  2. Hover over User 1 prompt and click `✏️ Edit`.
  3. Observe inline textarea with `Save & Submit` and `Cancel` buttons, alongside a warning that subsequent turns will be discarded.
  4. Edit prompt text (e.g. *"Focus specifically on database migration risk"*), then press `Ctrl+Enter` or click `Save & Submit`.
* **Expected Result:**
  - User 1 bubble updates text to the new content while strictly keeping the `[📄 Plan docs]` attachment card.
  - Downstream turns (User 2, Assistant 2) are truncated from the UI and history store.
  - Assistant 1 is immediately streamed with a fresh review taking the updated prompt and preserved plan into account.
  - `Edit` and `Retry` buttons are disabled while the new response streams.

---

## 5. Terminal Execution & Process Lifecycle Management

### TC-TERM-01: Intent-Based Auto-Run Suppression
* **Goal:** Prevent automatic execution when user expresses intent to run manually.
* **Test Steps:**
  1. Ask: *"What command compiles the project? Don't run it, I will run it myself."*
* **Expected Result:**
  - Terminal card appears in chat for reference.
  - **No automated execution** is launched in background or terminal.

### TC-TERM-02: Process Tree Termination on Cancel (`taskkill /T /F`)
* **Goal:** Ensure long-running commands terminate completely with no orphan background processes.
* **Test Steps:**
  1. Run a long-running process (e.g. `gradlew build`, `npm run build`, `ping 127.0.0.1 -t`).
  2. Click **Stop** / Cancel.
* **Expected Result:**
  - The process tree is destroyed immediately.
  - Verify Task Manager has no dangling `java.exe` or `node.exe` worker processes locking workspace files.

### TC-TERM-03: Sequential Terminal Permission Prompt Bar (`runTerminal = 'ask'`)
* **Goal:** Ensure terminal commands pause and request explicit user confirmation via the docked permission prompt bar above the input field, executing strictly one command at a time.
* **Test Steps:**
  1. Configure `openrouter.runTerminal` to `'ask'` in Settings.
  2. Ask assistant to run a command or plan with verification steps.
  3. Observe the `#pending-terminal-bar` docked directly above the user chat textarea inside the input container.
  4. Verify the prompt displays the exact command string alongside `✓ Allow` and `✕ Deny` buttons.
  5. Test `✕ Deny`: command is not executed, the bar dismisses, and the session halts execution cleanly.
  6. Repeat with `✓ Allow`: command executes, produces output, and only then pauses for the next command if another is queued.
* **Expected Result:**
  - File edit approval pipeline (`#pending-edits-bar`) remains completely untouched and independent.
  - Commands never auto-execute blindly when configured to `'ask'`.
  - Execution strictly waits sequentially for user confirmation on each step.

### TC-TERM-04: Batched 1-Line Collapsible Terminal Command Dropdown
* **Goal:** Verify that assistant messages with multiple terminal commands are grouped into a single 1-line dropdown bar that is collapsed by default.
* **Test Steps:**
  1. Prompt an instruction that returns multiple terminal commands (e.g. `npm install` followed by `npm test`).
  2. Inspect the rendered assistant response in the chat viewport.
* **Expected Result:**
  - Multiple command blocks are batched into a single `<details class="terminal-command-batch-details">` container.
  - Renders as a 1-line summary header: `▶ 💻 2 Terminal Commands... [Expand ▾]`.
  - The dropdown is **collapsed by default** (`open = false`).
  - Clicking the summary expands all individual command cards with copy/run actions.

---

## 6. Self-Healing & Loop Prevention

### TC-HEAL-01: Non-Zero Exit Code Self-Healing
* **Goal:** Verify extension detects terminal failure and triggers analysis.
* **Test Steps:**
  1. Ask assistant to run a command that fails due to a missing file (e.g. `cat nonexistent.txt`).
* **Expected Result:**
  - Extension captures stderr and stdout.
  - Initiates self-healing turn analyzing the error and suggesting remedies.

### TC-HEAL-02: Normalized Command Loop Detection
* **Goal:** Prevent repetitive retry loops when the model tries the same command with minor flag tweaks.
* **Test Steps:**
  1. Cause a persistent failure where files are NOT modified between retries.
  2. Model attempts to retry.
* **Expected Result:**
  - Loop detector identifies matching normalized signature (`executable + action`).
  - Halts after maximum allowed attempts (2 retries) and notifies user.

### TC-HEAL-03: Collapsible Failure Diagnosis & Compact Single-Line Status
* **Goal:** Ensure intermediate self-healing retries and failure diagnosis prompts do not flood or fill up the conversation viewport.
* **Test Steps:**
  1. Trigger a self-healing retry turn (e.g. running a test command that fails).
  2. Inspect the rendering of `Auto-Healing Diagnosis` and terminal retry notice messages.
* **Expected Result:**
  - Terminal retry notices render as sleek single-line status pills without oversized headers.
  - The `Auto-Healing Diagnosis` card displays a single-line summary with an interactive collapsible dropdown (`<details>`).
  - The dropdown is **collapsed by default**; clicking it reveals the full error logs, code block, and diagnosis prompt.
  - Intermediate step notes remain collapsed by default (`open = false`).

### TC-HEAL-04: Results & Walkthrough Doc Persistence on Window Reload
* **Goal:** Verify that Results docs (`📄 Results docs ready — [view]`) and walkthrough documents created during automated execution are preserved across reloads.
* **Test Steps:**
  1. Complete an automated plan implementation that concludes with a walkthrough document (`Results docs ready`).
  2. Reload VS Code window (`Developer: Reload Window`) or switch chat sessions and switch back.
* **Expected Result:**
  - The Results doc card is rendered in the conversation upon reload.
  - Clicking `View` opens the walkthrough document in the editor.
  - Clicking `Review` cleanly opens the Reviewer agent with the walkthrough attached.

---

## 7. Persistent Model Memory (Activity Manifest)

### TC-MEM-01: Manifest Turn Logging
* **Goal:** Verify that every file modification and terminal execution is tracked.
* **Test Steps:**
  1. Perform a code edit and run a terminal command.
  2. Inspect `.openrouter/activity-manifest.json` in workspace root.
* **Expected Result:**
  - Entry is created with turn index, timestamp, modified file paths, and command logs.

### TC-MEM-02: Cross-Session Continuity
* **Goal:** Verify that restarting VS Code does not lose awareness of prior tasks.
* **Test Steps:**
  1. Execute edits in a chat turn.
  2. Reload VS Code (`Developer: Reload Window`).
  3. Reopen OpenRouter panel and ask: *"What files were edited in the last session?"*
* **Expected Result:**
  - Agent queries the local manifest and correctly names the files and actions.

---

## 8. Context Assembling & Token Budgeting

### TC-CTX-01: Dynamic Token Truncation
* **Goal:** Ensure system handles massive files without exceeding context limits.
* **Test Steps:**
  1. Add a large file (e.g. 5,000+ lines or generated bundle) to context using `@file`.
  2. Send a query.
* **Expected Result:**
  - Context assembler applies smart truncation around relevant sections without crashing or dropping system instructions.

### TC-CTX-02: Exclusion of Ignored Files
* **Goal:** Verify `.gitignore` and binary files are respected during indexing.
* **Test Steps:**
  1. Query information across workspace.
* **Expected Result:**
  - `node_modules`, `.git`, build output dirs (`dist`, `build`, `.dart_tool`) are ignored.

---

## 9. Usage Tracking, Cost & Analytics

### TC-USE-01: Token & Cost Attribution by Model
* **Goal:** Ensure token usage and monetary cost are logged per request.
* **Test Steps:**
  1. Run queries with two different models (e.g. Anthropic Claude 3.7 vs OpenAI GPT-4o).
  2. Check Usage / Spend summary panel.
* **Expected Result:**
  - UsageStore breaks down spend, prompt tokens, and completion tokens by model accurately.

### TC-USE-02: Zero-Cost Terminal Attribution
* **Goal:** Verify local terminal executions do not artificially inflate API token costs.
* **Test Steps:**
  1. Run verification terminal commands.
* **Expected Result:**
  - Terminal records store 0 cost and 0 tokens while retaining command history.

---

## 10. Diagnostic Logging & Multi-Workspace Isolation

### TC-LOG-01: Per-Workspace Storage & No-Crosstalk Verification
* **Goal:** Ensure each opened workspace logs exclusively to its own `current.log` file in `storageUri` and does not inherit or leak logs to other projects.
* **Test Steps:**
  1. Open Project A in VS Code and trigger an action (e.g. check version or run a prompt).
  2. Open Project B in a separate VS Code window and perform a different action.
  3. Run `openrouter.openDiagnosticLog` ("View logs") in both windows.
* **Expected Result:**
  - Project A's log file resides in Project A's workspace storage and contains only events from Project A.
  - Project B's log file resides in Project B's workspace storage and contains only events from Project B.
  - No logs from Project A appear in Project B.
  - In-memory session buffers are completely isolated.

### TC-LOG-02: Calendar Date-Time Timestamp Formatting (`YYYY-MM-DD HH:MM:SS`)
* **Goal:** Verify log lines contain full calendar date and time for unambiguous multi-day auditability.
* **Test Steps:**
  1. Trigger any log event (e.g. model chat, diff preview, or settings view).
  2. Inspect the generated lines in `current.log`.
* **Expected Result:**
  - Every line starts with `[YYYY-MM-DD HH:MM:SS]` (e.g. `[2026-09-25 21:00:00]`).
  - Session restart writes a clean resume banner with timestamp and workspace label.

### TC-LOG-03: Safety from Git & Document Operations
* **Goal:** Verify logs remain intact after `git clean`, `git reset`, undo actions, or branch switching.
* **Test Steps:**
  1. Run `git reset --hard` or perform shadow-git undo operations in the project.
  2. Inspect the diagnostic log via "View logs".
* **Expected Result:**
  - Log entries are fully preserved because the log directory resides in VS Code internal storage outside the workspace repository.

---

## 11. End-to-End Regression Scenarios

### TC-E2E-01: Multi-Phase Mobile/Web App Build
* **Goal:** Validate end-to-end multi-phase project generation from scratch to verified build.
* **Execution:**
  1. **Phase 1 (Scaffold):** Generate folder structure, configuration (`pubspec.yaml` or `package.json`).
  2. **Phase 2 (Models):** Implement domain models with serialization.
  3. **Phase 3 (Services):** Implement storage or network services.
  4. **Phase 4 (UI/Views):** Implement screens with single-card grouping per file.
  5. **Phase 5 (Review):** Run Reviewer on all written code, fix highlighted warnings.
  6. **Phase 6 (Verification):** Run build command (`flutter build` or `npm run build`), verify output, and confirm all steps succeed without manual recovery.
