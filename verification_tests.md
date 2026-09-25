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
10. [End-to-End Regression Scenarios](#10-end-to-end-regression-scenarios)

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

### TC-CHAT-03: Multi-Turn Conversation Context
* **Goal:** Verify conversational recall across turns in the same session.
* **Test Steps:**
  1. Turn 1: *"Let's build a service named AuthService in auth.ts."*
  2. Turn 2: *"Add a method to validate tokens."*
* **Expected Result:**
  - Turn 2 correctly references `AuthService` and `auth.ts` without re-prompting.

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

### TC-TERM-03: Verification Command Confirmation Dialog
* **Goal:** Ensure sensitive commands require explicit user consent.
* **Test Steps:**
  1. Prompt an action that triggers a destructive or environment-altering command (e.g. package install or delete).
* **Expected Result:**
  - Confirmation dialog or inline approval prompt appears.
  - Command executes only if allowed by user; halts immediately if rejected.

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

## 10. End-to-End Regression Scenarios

### TC-E2E-01: Multi-Phase Mobile/Web App Build
* **Goal:** Validate end-to-end multi-phase project generation from scratch to verified build.
* **Execution:**
  1. **Phase 1 (Scaffold):** Generate folder structure, configuration (`pubspec.yaml` or `package.json`).
  2. **Phase 2 (Models):** Implement domain models with serialization.
  3. **Phase 3 (Services):** Implement storage or network services.
  4. **Phase 4 (UI/Views):** Implement screens with single-card grouping per file.
  5. **Phase 5 (Review):** Run Reviewer on all written code, fix highlighted warnings.
  6. **Phase 6 (Verification):** Run build command (`flutter build` or `npm run build`), verify output, and confirm all steps succeed without manual recovery.
