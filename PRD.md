# PRD: OpenRouter — Product Requirements Document (PRD)

**Status:** Living Specification  
**Version:** 0.2.0  
**Name:** OpenRouter

## 1. Overview

**Purpose:** A VS Code extension that connects to OpenRouter using a single user-supplied API key, giving access to any model on OpenRouter (not locked to OpenAI) for in-editor AI assistance — chat, code edits, and multimodal input (voice/image) where the selected model supports it — with full transparency into token usage and cost.

**Primary user:** Developers who want model choice/flexibility (cost, capability, provider) without juggling multiple vendor extensions or API keys.

**Non-goals (v1):** Multi-key/multi-account switching, team/org billing dashboards, fine-tuning, agents that autonomously run multi-step tasks without user checkpoints.

---

## 2. Core User Stories

1. As a user, I paste my OpenRouter API key once and I'm ready to go.
2. As a user, I can switch models mid-conversation without losing context or restarting anything.
3. As a user, the UI only shows me voice/image input if my current model actually supports it.
4. As a user, I can see exactly what tokens/cost each request used, and a running history.
5. As a user, I'm asked before the extension touches my files or terminal — never silently.
6. As a user, if the AI edits my code or runs a command, I can undo it as a single reversible step, same as any other edit.
7. As a user, I can move the chat panel to whichever side of the editor I prefer, and it stays there.

---

## 3. Information Architecture / UI Structure

### 3.1 Activation & Onboarding
- On first install: a welcome webview (not a blocking modal) with one field — API key — and a "Get key from OpenRouter" link.
- Key is validated with a lightweight call to `/api/v1/auth/key` before saving.
- Stored via VS Code `SecretStorage` API — never in `settings.json`, never logged.
- Key can be changed/cleared anytime via Command Palette: `OpenRouter: Update API Key` / `OpenRouter: Clear API Key`.

### 3.2 Main Panel (Webview)
- Lives in a VS Code **View Container** — user chooses left (Activity Bar / Primary Sidebar) or right (Secondary Sidebar) via a setting or a drag-and-drop (VS Code natively supports dragging any view between sidebars — the extension should register in a way that doesn't fight this).
- Setting: `openrouterCopilot.panelPosition`: `"left" | "right"`, applied via `workbench.view` placement on activation, but user's manual drag always wins (don't force-reset it).
- **Resizable width:** since the panel lives in a native VS Code View Container, it inherits VS Code's built-in drag-to-resize behavior on the sidebar border for free — no custom resize logic needed. Requirement: the webview's internal layout must use fluid/percentage-based sizing (not fixed pixel widths) so content reflows correctly as the user drags the panel narrower or wider, rather than clipping or overflowing.
- Layout top to bottom:
  1. **Header bar** — model selector dropdown (searchable), reasoning-effort dropdown (conditionally visible, positioned strictly between model selector and "+" new chat button; order: model selector → reasoning-effort dropdown → "+" button → gear icon), capability icon badges (image icon / mic icon) shown live for the selected model, settings gear.
  2. **Conversation thread** — messages, streamed responses, inline diff previews for proposed code edits with an "Apply edit" action, collapsible tool-call logs, and inline system notes (e.g. capability-loss notices on model switch, per §3.3).
  3. **Input bar** — text box; undo icon, image-upload icon, and mic icon appear/disappear based on selected model's `input_modalities`; send button; a small token-cost estimate for the draft prompt (optional, nice-to-have).
  4. **Footer strip** — context-used meter (e.g. "34% of context used") plus running session token count + cost.

**Reasoning Effort Selector (Header Control):**
A compact reasoning-effort dropdown positioned in the header row directly BETWEEN the model selector combobox and the "+" (new chat) button. Order from left to right: model selector → reasoning-effort dropdown → "+" new chat button → gear (settings) icon.
- **Layout & Sizing:** The model selector combobox is narrowed to make room for this new control without pushing the gear icon further right and without adding a second header row.
- **Conditional Visibility:** Following the same pattern as capability badges (§3.3), this control is only rendered when the currently selected model supports a reasoning-effort parameter (`supportsReasoningEffort`). When unsupported, the dropdown is completely absent from the DOM / display and the "+" button sits directly adjacent to the model selector combobox.
- **Supported Levels Subset:** If a model supports fewer than three effort levels, only the levels it actually supports are rendered in the dropdown (e.g., if a model only supports `low` and `medium`, `high` is omitted). Supported levels default to `['low', 'medium', 'high']` for reasoning models.
- **Default Value:** Defaults to a sensible middle tier (`medium`) if the user has not explicitly changed it (avoiding defaulting to the most expensive or least capable tier).
- **Dynamic State & Model Switching:**
  - Changes to the reasoning effort level take effect immediately on the next request sent.
  - If the user switches to a model that does not support reasoning effort, any previously selected effort level is cleared and ignored so it is never passed to an incompatible model.
- **Provider Rejection & Fallback:** If a provider rejects a chat completion request due to an unsupported or invalid reasoning effort parameter (e.g., HTTP 400 error indicating unsupported parameter), the client automatically retries the request once without the `reasoning_effort` parameter and surfaces a clear inline notice/notification: *"This model doesn't support the selected reasoning effort level — retrying without it"*.
- **Usage & Audit Logging:** The active effort level is explicitly appended to the logged model name in the Usage Report (§3.5), formatted as `Model Name (Level)` (e.g. `openai/o3-mini (High)` vs `openai/o3-mini (Low)`), ensuring cost and token differences across reasoning tiers are fully visible and explainable.

**Undo Affordance (One-Way Rewind Point — No Redo):** The undo control is a general rollback mechanism against **any** AI-caused workspace change (edits, file creation, file deletion, or file corruption). It operates as a **one-way rewind action** rather than a reversible toggle: clicking undo on a user message reverts the workspace *and* the visible conversation back to the point right after that user message was sent — permanently, with no way back except sending a new prompt:
- **Placement:** The undo (back-arrow) icon lives inside the body of each user message, right alongside the existing Copy action in the same action row. There is **no undo affordance anywhere on AI-generated messages**.
- **No Redo:** Redo is removed entirely — no redo button, no toggle state, no `REDO_TURN` messages, and no redo checkpoint creation. Once undo is executed, the only way to move forward is for the user to type and send a new prompt.
- **Coupled Revert & Truncation:** Clicking undo on a user message simultaneously:
  1. **Chat thread:** Removes every message *after* that user message — including that message's own AI response and any subsequent turns — and also removes the user message itself from the chat window.
  2. **Filesystem:** Reverts whatever files were changed by the AI action(s) that occurred after that message, using the existing scoped-restore mechanism (§4.3 — per-turn `affectedFiles`, cross-turn isolation, drift detection unchanged).
  3. **Auto-Fill Input Box:** Upon *successful* completion of the undo (and only on success), the text of the undone user message is automatically transferred into the chat input box and focused, ready to be modified or sent again. If the input box already contains typed text, it is intentionally cleared and overwritten with the undone message text. Attachments are not automatically restored.
- **Activation State:** The undo icon becomes active once that user message has received an AI response (i.e. there is an AI response or later history to revert). Before the AI responds, or if there is no subsequent history to clear (e.g. the user message is already the terminal message in the thread with nothing after it), clicking undo is a safe no-op / disabled.
- **Irreversibility Warning & Confirmation:** Because truncating the chat thread without redo is irreversible, a confirmation prompt is required before executing whenever $N > 0$ messages will be removed: *"This will undo this change and remove N later messages from this chat — this cannot be undone. Continue?"*
- **Undo availability state:** Since shadow-git checkpoints are cleared when a workspace window is closed (§4.3) or for `.gitignore`'d files, the undo icon renders in a disabled/greyed-out state (never hidden) next to Copy for any turn whose checkpoint is no longer available, displaying an explanatory tooltip (e.g. "Undo unavailable — this workspace window was closed since this change"). Keeping the icon visible but disabled preserves stable visual alignment across messages and clearly indicates past rollback availability.

**Collapsed Code Blocks in the Message Thread:** Large code blocks written by the model currently render in full inline within the chat thread, forcing the user to scroll past long code they don't need to read there — especially since the actual content is already being written to a file via the edit/diff pipeline (Phase 3), not something the user needs to read twice in full.
- **Code blocks above a size threshold (default >15 lines) render collapsed by default**, showing only a short snippet preview (e.g. the first lines) rather than the entire block — so a single large code block doesn't dominate or fill the chat window.
- **A summary/label remains visible even when collapsed** — e.g. "`auth.ts` — 84 lines written" or similar — so the user always knows what was produced and where it went, without needing to expand it to find out.
- **An expand/collapse toggle** lets the user view the full code inline if they want to, but collapsed is the default state for anything over the threshold.
- **Small code blocks (under the threshold) render as before, uncollapsed** — this behavior only applies to blocks large enough to actually cause scrolling/clutter; short snippets shouldn't be hidden behind an unnecessary toggle.
- This is purely a **display/rendering behavior in the message thread** — it does not affect what's sent to the model, what's written to the file via the edit/diff pipeline (Phase 3), or anything in Context Preview (§7.2), which should continue to reflect full actual content regardless of how it's visually collapsed in the chat.
- Collapsed state should be per-block, not global — expanding one large code block in the thread doesn't force-expand others.

### 3.3 Model Selector (Seamless Switching)
- Dropdown, not a settings-page trip. Always visible in the header, always live.
- Backed by a cached `GET /api/v1/models` response, with two refresh triggers: (1) **auto-refresh on chat launch** — re-fetched automatically every time a new chat session starts, since OpenRouter's catalog changes over time (new models, deprecations, pricing updates) and the list should never be stale at the start of a session; (2) a manual refresh icon in the dropdown for refreshing mid-session without starting over.
- **Resilient Catalog Fetching:** The `/models` fetch includes automatic silent retries (up to 2 retries with exponential backoff) to protect against transient network dropouts and upstream 5xx/429 spikes, preventing the model dropdown from failing to populate on launch.
- **Type-to-search:** the dropdown is a searchable combobox, not a plain native `<select>` — typing filters the list live by name, provider, or capability keyword (e.g. typing "vision" filters to multimodal models), so the user never has to scroll a long list to find a model.
- **Reasoning Effort Support Detection:** The model selector inspects model metadata (`supported_parameters`, model ID keywords like `o1`, `o3`, reasoning tags) to detect `supportsReasoningEffort` and its supported levels. When active, it displays the reasoning effort dropdown immediately to its right.
- Switching models **mid-conversation**:
  - **Decision: drop-with-notice (not blocked).** The model switch is never blocked by earlier content in the conversation. If the new model lacks a capability used earlier (e.g. an image was attached under a vision-capable model, and the user switches to a text-only model), that unsupported content is excluded from what's sent going forward, and an inline system note is shown at the point of switch: "Switched to [Model] — image inputs are not supported by this model; earlier image will be excluded going forward." The user is never silently left talking to a model that's missing context without being told.
  - If the new model does not support reasoning effort, any previously selected reasoning effort is cleared so it is not sent.
  - **Decision: summarize, not full resend.** Rather than resending the entire raw conversation history to the newly selected model on every switch, the extension generates a condensed summary of the prior conversation (key points, decisions, code context) and sends that instead of the full transcript. This keeps token/cost overhead down on long conversations. The full original history remains visible in the UI thread regardless — only what's *sent to the model* going forward is summarized. A setting can allow power users to opt back into full-history resend if they want maximum fidelity over cost savings.
- Last-used model is remembered per-workspace (setting: `openrouterCopilot.lastModel`), not just globally, since users may want different models for different projects.

### 3.4 Long-Conversation Token Management (Hybrid Approach)

Beyond model switching, a single long-running conversation with one model also needs to be kept under control as it approaches that model's context window and cost grows per turn. This reuses the same summarization mechanism from §3.3, applied on a length/token trigger rather than a model-switch trigger, combined with visibility and manual control:

- **Automatic rolling summarization (default behavior):** as the conversation approaches a configurable threshold of the active model's context window (e.g. 70–80%), older turns are compressed into a running summary automatically, while recent turns are kept verbatim. This happens transparently in the background — no interruption to the user's flow.
- **Visible token meter:** the footer strip (§3.2) shows live context usage (e.g. "1,256 / 1.0M (0.1%)") so the user always has visibility into how full the conversation is, independent of whether auto-summarization has kicked in yet.
  - **Instant Reset on New Session:** Clicking the **+** ("Start New Chat") button immediately zeroes out the meter to `0 / [maxContext] (0.0%)` client-side without waiting for the first model reply to complete.
  - **Session-Synchronized Metering:** Switching between previous chat sessions immediately recalculates the meter for that specific conversation's message history.
- **Manual "Start fresh from here" control:** at any point, the user can explicitly collapse the entire conversation so far into a summary and continue from a clean slate, rather than waiting for the automatic threshold. Useful when the user knows a conversation has drifted and wants a deliberate reset point.
- **Full original history remains visible** in the UI thread regardless of summarization — summarization only affects what's sent to the model, never what the user sees on screen.
- A setting allows disabling auto-summarization entirely for users who want raw full-context behavior and are willing to manage cost/limits themselves.
- **Pinned context (never summarized):** to prevent summarization from silently dropping hard constraints (e.g. "don't touch the auth module"), the extension supports a separate pinned-context tier that is always sent to the model in full, regardless of summarization state:
  - **Manual pinning** — a pin icon on any message in the thread (alongside the undo icon, §3.2) lets the user mark that message as pinned. Pinned messages are excluded from the rolling summarization pool entirely.
  - **Project-level system instructions** are always treated as pinned by default — they're never eligible for summarization.
  - Pinned content is expected to stay small by design (a few sentences of hard constraints, not whole files) — the mechanism relies on the user curating what's worth protecting rather than the AI guessing at importance, which avoids both under- and over-inclusion failure modes.
  - **Token meter reflects the split:** the context meter (footer strip, §3.2) shows pinned vs. active context separately (e.g. "12% pinned, 34% active context") so the fixed cost floor created by pinning stays visible.
  - **Soft warning on pinned growth:** if pinned content grows large enough to become its own cost concern (e.g. crosses ~15% of the active model's context window), a warning is shown suggesting the user unpin older items — so the safety net doesn't quietly turn into the same cost problem it was meant to avoid.
  - Auto-extracted pinning (the AI inferring what's important without being told) is explicitly out of scope for v1 — manual pinning only, to keep behavior predictable and cost bounded.

### 3.5 Usage Report View
- Separate view (own icon in the same view container, or a tab within the panel).
- Table: timestamp, model (including reasoning effort level if applicable, e.g. "Model X (High)"), prompt tokens, completion tokens, cost, workspace/project.
- Filters: date range, model, project.
- Aggregate summary card at top: total spend this session / this week / this month.
- Export to CSV button.
- Data stored locally (SQLite via `sql.js` or a flat JSON log — see §5.3).

**Layout (agreed mockup):** back button + title + export icon in the header; three summary cards (today / this week / this month spend) in a row below; a filter strip (model, date range, project) above the log; a scrollable table listing every logged event — both AI chat calls (time, model with reasoning effort annotation, tokens, cost) and terminal command audit entries (§4.3/§5.3) in the same log, with commands shown using a terminal icon and no token/cost values since they aren't billed by OpenRouter directly.

**Per-project filtering:** "project" is derived from the VS Code workspace the request happened in — either the workspace folder's name/path (single-root workspace) or, for multi-root workspaces, the specific root folder that was active when the call was made. Every logged row (chat calls and terminal commands alike) is tagged with this project identifier at write-time, not computed after the fact. The project filter dropdown is populated dynamically from the distinct project values already present in the local log — no separate project list needs to be maintained. This lets a user working across multiple client projects (e.g. separate repos for different clients) see spend broken down per project, which matters for anyone billing or budgeting per engagement rather than just tracking total spend.

**Export respects active filters:** the Export to CSV button exports only the rows currently visible under the active filters (model / date range / project) — not the entire log unconditionally. If the user has filtered to one project, "Export" gives them a CSV of just that project's usage, not everything. A small label near the button (e.g. "Export 24 rows — Client X, last 7 days") should make it clear what scope is about to be exported.

**Clear history — single entry point, staged flow:** Settings has one "Clear history" button, not two separate ones. Clicking it opens a **category selection step first** — "What would you like to clear? Chat history / Usage data" — rather than immediately confirming a deletion. Once the user picks one, a second, final confirmation step follows, scoped to that specific category (e.g. picking "Chat history" shows "This will permanently delete N chat conversations. This cannot be undone." with a "Yes, delete" button; picking "Usage data" shows the equivalent for M logged usage/cost records). Only the category the user explicitly selected is affected — the other remains untouched. This is a three-step flow overall: Clear history → choose category → confirm deletion.

---

## 4. Permissions Model

This is the most important trust surface in the product. Default posture: **ask, don't assume.**

### 4.1 Permission Categories
| Action | Default Behavior | User Control |
|---|---|---|
| Read open file / selection for context | Allowed automatically (read-only, no side effects) | Toggle off in settings if desired |
| Propose a code edit | Always shown as a **diff preview** first | Accept / Reject / Edit-then-accept per hunk |
| Apply a code edit | Only after explicit Accept | Can set "auto-accept for this session" per-workspace, revocable anytime |
| Create/delete files | Explicit confirmation dialog every time (not auto-accept-able) | N/A — always confirmed |
| Run a terminal command | Explicit confirmation dialog showing the exact command string before execution | "Always allow this exact command" opt-in per workspace; full terminal access can be disabled entirely in settings |
| Access to other (unopened) files in workspace | Off by default; must be enabled per-workspace via a permission prompt the first time it's needed | Can be revoked anytime |

### 4.2 Permission UX
- First time any category is needed, show a native VS Code notification/dialog with **Allow / Allow for this session / Deny**.
- A single settings page (`OpenRouter: Permissions`) lists every category with current state and a reset-all button.
- Terminal command permission is the highest-risk item: show the literal command, working directory, and a plain-language description before running. Never chain multiple commands under one approval.

### 4.3 Undo / Rollback (Shadow Git — fully separate from the user's git)

The extension maintains its **own private git repository**, entirely separate from the user's `.git`. The user's own git usage (branches, commits, history) is never touched, never read from, and never assumed to exist.

- **Location:** a shadow repo living outside the visible working tree's `.git` — e.g. `<globalStorage>/<workspace-hash>/shadow.git`, using `git --git-dir=<shadow path> --work-tree=<user's workspace>` so it tracks the same files on disk without living inside the user's repo folder.
- **Fully invisible to the user by default:** no branches, commits, or refs appear in the user's Source Control panel, `git log`, or `git status` — it's a background mechanism, not a feature the user manages directly. (A "Show AI checkpoint history" view can optionally expose it read-only, but it's not the user's git.)
- **Independent of whether the user's project is a git repo at all.** Works the same whether the workspace has its own `.git`, a different VCS, or no version control whatsoever.
- **Scope — Always-Visible Safety Net against ANY AI workspace change:** Undo is not conditional on whether there is an active edit proposal or an applied diff card. It serves as a general workspace rollback mechanism against **any** AI-caused workspace change — code edits, file creation, file deletion, or unexpected file corruption.
- **Auto-checkpoint before every AI action:** Immediately prior to executing any AI-initiated modification, creation, or deletion, the extension creates a checkpoint of the affected workspace state in the shadow repo. File creations and file deletions are checkpointed identically to edits so that additions and removals can be cleanly inverted.
- **The Undo Icon on User Messages (One-Way Rewind Point):** Positioned directly inside each user message next to the Copy action (never on AI responses). Clicking the undo icon on a specific user message reverts both the workspace files and the conversation thread back to immediately after that user message was sent.
- **No Redo:** Redo is completely excluded from the system architecture. No redo checkpoints are created, and no redo actions or forward-stepping toggles exist.
- **Hard requirement — scoped restore only:** undoing turn N must touch only the files that turn N's checkpoint diff covers. It must never delete or modify files created/changed in later turns (N+1, N+2, ...) that fall outside that diff. This is a known failure mode in comparable tools (e.g. a reported Antigravity bug where "Restore" deleted files created in subsequent turns instead of just reverting content) and must be explicitly tested against before ship.
- **Strict Execution Order & Atomic Safeguard:** The rewind pipeline strictly adheres to the following sequence to guarantee non-destructive failure:
  1. **Pre-flight & Confirmation:** Calculate the number of subsequent messages ($N$). If $N = 0$, it is a safe no-op. Prompt user confirmation: *"This will undo this change and remove N later messages from this chat — this cannot be undone. Continue?"*
  2. **Drift Detection:** Diff on-disk state against expected checkpoint state across all `affectedFiles`. If manual out-of-band changes exist, surface the drift warning dialog. If the user cancels: **ABORT immediately** (no files restored, no history truncated).
  3. **Scoped File Restore:** Call `ScopedRestore.restore(checkpointId, affectedFiles, force)`. If file restore fails or throws: **ABORT immediately** (no history truncated, error surfaced).
  4. **Chat Thread Truncation:** Only after scoped restore completes with `success: true` does `historyStore.truncateAfter(messageId)` execute, permanently pruning all subsequent messages from disk storage.
  5. **Webview UI Sync:** Webview removes all DOM elements from that user message onwards (including the user message itself), transferring the user message's text back into the input box.
- **Shadow Repo Checkpoint Lifecycle on Truncation:** Shadow-git checkpoints for turns truncated away become unreferenced commits in `<storageUri>/shadow.git`. The shadow repo `HEAD` ref is reset back to the target checkpoint (`git update-ref refs/heads/master <checkpointId>`). Because `shadow.git` is automatically cleared on window close, these unreferenced commits impose zero cross-session disk bloat and require no complex mid-session pruning.
- **No interference with the user's own git:** since the shadow repo is a separate `.git` directory, the user can commit, branch, stash, or rebase in their own repo at any time without affecting or being affected by shadow checkpoints.
- **Retention policy: split by data type.**
  - **Chat conversation text persists indefinitely** — stored on disk per-workspace, survives VS Code restarts. A user can return the next day and still read/continue any past conversation.
  - **Shadow-git checkpoints (the undo mechanism) are cleared when that specific workspace window is closed** — not on a whole-application restart. Since the shadow repo is per-workspace (`<workspace-hash>/shadow.git`), and a user may have multiple VS Code windows open across different projects simultaneously, the clear trigger is scoped to that window/workspace instance closing, independent of whether other VS Code windows remain open. This keeps the shadow repo from growing unbounded with file-content snapshots over weeks/months of use (see Open Questions — disk growth was the driving concern here), at the cost of undo only being available for edits made since that workspace window was last opened. Reopening an old chat in a fresh window session lets the user read it and continue chatting, but the "Undo" affordance on turns from before that window closed is disabled (greyed out with a tooltip), since the checkpoint it would restore from no longer exists.
  - There is no automatic expiry for chat text in v1; it only goes away via the explicit "Clear history" action (see §3.5/§5.4), never silently.
- **Terminal commands are out of scope for shadow-git undo** since they can have effects outside tracked files (installs, network calls). The confirmation dialog before running still flags destructive-looking commands and shows a suggested reverse command where one exists (e.g. `npm uninstall` after `npm install`).
- **Audit logging (no undo, but tracked):** every terminal command the user confirms and runs is logged — timestamp, exact command string, working directory, and which chat turn triggered it — in the same local history store as token/usage data (§5.3). This is visible in the Usage Report view so the user has a full record of what the AI executed on their machine, even though these actions can't be reverted automatically.
- The shadow repo only ever touches files the AI itself modifies — it never stages or commits unrelated dirty changes the user already had in progress, so the user's own uncommitted work is never at risk.
- **Drift detection before restore:** before executing any undo, the extension diffs the file's current on-disk state against what the shadow checkpoint expects. If the file has been manually edited since that checkpoint (i.e. changes exist that were never run through the AI), undo does **not** proceed silently. Instead, it surfaces a warning — "This file has changes made outside the AI since this checkpoint. Undo anyway and lose them / Cancel" — and the user explicitly decides. No automatic merge and no silent overwrite in v1; the user is always the one who chooses whether their manual edits are discarded.
- **Checkpoint tagging (implementation note):** every AI-initiated workspace action writes a `checkpointId` (the shadow-git commit/ref it created) onto that turn's stored chat message record at write-time, rather than reconstructing this later via diffing. Determining whether undo is available for a given turn (including the disabled-state UI in §3.2) is then a simple lookup — read the turn's `checkpointId` and check whether it still exists in the current session's shadow repo — instead of live-diffing file states against history. This is cheap to evaluate on render and reuses the same reference for drift detection above.

---

## 5. Functional Requirements

### 5.1 Model Capability Detection
- Parse `architecture.input_modalities` / `output_modalities` and parameter metadata from `/api/v1/models`.
- Map to UI feature flags: `supportsVision`, `supportsAudio`, `supportsTools`, and `supportsReasoningEffort` (with `supportedReasoningEfforts?: string[]`).
- Re-evaluate on every model switch, not cached per-session.

### 5.2 Chat/Completion & Real-Time Context Assembly
- `POST /api/v1/chat/completions`, streamed (SSE).
- **Live In-Memory Buffer Priority:** Active file and selection context are read fresh from the live in-editor buffer (`document.getText()`) on every single send turn, never from disk and never cached across turns. Dirty and unsaved edits are immediately included.
- **Webview Focus Fallback:** When the webview chat input has focus and `vscode.window.activeTextEditor` is momentarily `undefined`, `ContextReader` falls back to `vscode.window.visibleTextEditors` to reliably resolve the active document context.
- **Referenced File Memory Priority:** Cross-file mentions (e.g. "review app.py") inspect `vscode.workspace.textDocuments` first to read live unsaved editor buffers before falling back to disk read (`fs.readFile`).
- **Explicit Superseding Directives:** The system prompt injects authoritative headers (`LIVE BUFFER - AUTHORITATIVE`) instructing the model that the attached file buffer represents the up-to-the-second current code state, strictly superseding any older versions, diffs, or snippets from prior conversation turns.

### 5.3 Usage Logging
- Every response's `usage` object (prompt/completion tokens) + model's per-token pricing → compute cost, append to local store.
- **Retry Isolation Invariant:** Usage logging is strictly bound to successful `onDone(usage)` completion. Failed attempts, transient retries, and mid-stream network drops are never logged to `usageStore` (neither partially nor with zero-token rows); only the single eventual successful attempt logs tokens and cost.
- **No hidden/folded-in calls:** every model API call is logged as its own line item, including background summarization calls (§3.4) triggered by model switching or long-conversation compression — these are never silently absorbed into overhead. A summarization call's log entry is tagged distinctly (e.g. type: "summarization") so it's visible in the Usage Report as what it is, distinguishable from user-facing chat turns, rather than inflating a chat turn's apparent cost or being invisible entirely.
- Every confirmed terminal command execution is also appended to this store (timestamp, command, working directory, triggering chat turn) for audit purposes — see §4.3.
- Local store: SQLite file in the extension's global storage path (`context.globalStorageUri`), not synced anywhere.

### 5.4 Settings Surface
- Panel position (left/right)
- Default model
- Permission states (§4.1)
- Usage data retention period / clear-history button
- **Version indicator:** Displays the current extension version (e.g. `OpenRouter v0.2.0`) pinned at the bottom of the Settings view, updated synchronously with `package.json` across version increments.

---

## 6. Open Questions (to resolve before build)
- Should image/audio inputs be sent as base64 inline or does OpenRouter require provider-specific handling per model? Needs a spike.
- SQLite via `sql.js` (WASM, no native deps) vs. flat JSON log — JSON is simpler but won't scale/query well past a few thousand rows.
- How aggressively to auto-detect "destructive" terminal commands for the undo-warning (regex list vs. asking the model to self-flag)?
- Shadow repo implementation: confirm `git --git-dir=<shadow> --work-tree=<workspace>` behaves correctly across OSes/edge cases (symlinks, very large files). Must always respect the user's `.gitignore` — if the AI is asked to edit an ignored file, warn the user that the edit will be unprotected by shadow-git undo before proceeding (per §4.1 decision). **Undo for these files is permanently disabled** (not a fallback to VS Code's plain edit-stack undo) — the per-turn undo icon (§3.2) renders in its disabled state for any turn touching a `.gitignore`'d file, consistent with how it's disabled when a checkpoint no longer exists.

---

## 7. Success Criteria
- Time from install to first successful chat response: under 60 seconds.
- Zero silent file/terminal actions in testing — every side-effecting action has a corresponding confirmation.
- Model switch mid-chat completes with no visible reload/flicker and correct capability icons within 1 render cycle.

---

## 8. Project Scaffolding & Structure

### 8.1 Repo Layout

```
openrouter-copilot/
├── package.json                  # Extension manifest: name, engines.vscode, activationEvents,
│                                  # contributes.commands, contributes.views (view container)
├── tsconfig.json
├── esbuild.config.js              # Bundling for extension host + webview separately
├── .vscodeignore
├── .gitignore                     # For the extension's OWN repo — unrelated to the shadow-git
│                                  # mechanism the extension runs against user workspaces
├── CHANGELOG.md
├── README.md
│
├── src/
│   ├── extension.ts                # Activation entry point — registers commands, views,
│   │                                # instantiates core services on VS Code startup
│   │
│   ├── auth/
│   │   └── secretStore.ts          # SecretStorage wrapper: save/read/clear API key,
│   │                                # key validation call to /api/v1/auth/key
│   │
│   ├── api/
│   │   ├── openrouterClient.ts     # GET /api/v1/models, POST /api/v1/chat/completions (SSE)
│   │   ├── modelCapabilities.ts    # Parses architecture.input_modalities/output_modalities
│   │   │                           # into supportsVision/supportsAudio/supportsTools flags
│   │   └── pricing.ts              # Cost computation from usage object + per-token pricing
│   │
│   ├── shadowGit/
│   │   ├── shadowRepo.ts           # git --git-dir=<shadow> --work-tree=<workspace> wrapper
│   │   ├── checkpoint.ts           # Create checkpoint pre-edit, tag turn with checkpointId
│   │   ├── restore.ts              # Scoped restore logic (§4.3 hard requirement: never touch
│   │   │                           # files outside the reverted turn's changeset)
│   │   ├── driftDetection.ts       # Diff on-disk state vs. checkpoint before restore
│   │   └── gitignoreRespect.ts     # Checks user's .gitignore before tracking any file
│   │
│   ├── permissions/
│   │   ├── permissionManager.ts    # State machine for read/edit/terminal/cross-file categories
│   │   └── confirmationDialogs.ts  # Native VS Code dialogs for edit/terminal/file confirmations
│   │
│   ├── conversation/
│   │   ├── historyStore.ts         # Persistent chat text storage, per-workspace
│   │   ├── summarizer.ts           # Rolling summarization (§3.4) + model-switch summarization (§3.3)
│   │   ├── pinnedContext.ts        # Manual pin/unpin, pinned-context token accounting
│   │   └── contextMeter.ts         # Computes % context used, % pinned, for the footer strip
│   │
│   ├── terminal/
│   │   └── commandRunner.ts        # Confirmation flow + execution + audit logging (§4.3/§5.3)
│   │
│   ├── usage/
│   │   ├── usageStore.ts           # SQLite (sql.js) local store — chat calls, summarization
│   │   │                           # calls, and terminal command audit rows, tagged by project
│   │   └── projectResolver.ts      # Derives project identifier from active workspace/root folder
│   │
│   ├── webview/
│   │   ├── panelProvider.ts        # WebviewViewProvider — registers the panel into the
│   │   │                           # View Container, handles left/right placement setting
│   │   ├── messages.ts             # Typed message protocol between extension host and webview
│   │   └── ui/                     # Frontend source for the webview (chat panel, settings,
│   │       ├── ChatPanel/          # usage report — see §3.2–§3.5 mockups)
│   │       ├── Settings/
│   │       └── UsageReport/
│   │
│   └── settings/
│       └── configuration.ts        # Reads/writes openrouterCopilot.* settings
│                                    # (panelPosition, lastModel, permission states, etc.)
│
└── test/
    ├── shadowGit.test.ts            # Scoped-restore correctness, drift detection, gitignore respect
    ├── permissions.test.ts
    └── usageLogging.test.ts
```

### 8.2 Key Design Notes for Implementation
- **Extension host vs. webview are separate bundles** — `src/webview/ui/` is UI code running inside the webview's own sandboxed context and must be bundled separately from the extension host code (`src/extension.ts` and everything else), communicating only via the typed message protocol in `webview/messages.ts`.
- **`shadowGit/` is the highest-risk module** — per the PRD's hard requirement (§4.3), `restore.ts` must be unit-tested specifically against the "restore deletes files outside the changeset" failure mode before anything else ships.
- **`usageStore.ts` is the single source of truth** for both the Usage Report view and the "Clear history" flow (§3.5) — both chat calls, summarization calls, and terminal command rows live in one store, distinguished by a `type` field, so category-scoped clearing/filtering reads from one place.
- **`projectResolver.ts` is called at write-time**, not query-time — every row written to `usageStore` or `historyStore` gets its project tag the moment it's created, never inferred retroactively.

---

## 9. Phased Build Plan

### Phase 1 — Foundation
- Extension manifest, activation, command registration
- `SecretStorage` API key flow (save, validate, update, clear)
- Basic webview panel scaffold, registered into a View Container, left/right placement setting
- OpenRouter `/models` fetch + basic model dropdown (no search/auto-refresh yet)
- Basic `/chat/completions` call (non-streaming is fine for this phase) rendering plain text responses

### Phase 2 — Core Chat Experience
- Streaming responses (SSE) with abort/cancellation control via Stop button (`STOP_STREAM` / `AbortController`)
- Model capability detection → conditional image/mic UI
- Type-to-search combobox for model selection + auto-refresh on chat launch
- Multi-session chat management with persistent storage (`chat_sessions.json`), new chat generation, session dropdown list, session switching, inline session renaming (`✏️`) to aid recollection, and session deletion
- Markdown rendering for assistant output (fenced code blocks with copy action, inline formatting, headers, lists)
- User input copy affordance (small copy button on input box and individual message headers)
- "Clarify" aspect quoting: ability to select or quote aspects of agent output directly into context for follow-up clarification
- Executive Task Summary cards auto-extracted and highlighted upon task completion
- Basic settings panel (API key, panel position, default model)
- Live in-editor context freshness: real-time in-memory buffer reading (`document.getText()`) on every turn, webview-focus fallback to `visibleTextEditors`, in-memory document priority for workspace file mentions, and explicit superseding directives in prompt payloads to prevent stale-context regressions.
- Network resilience & stream error recovery: automatic silent retry (up to 2 extra attempts with exponential backoff) for transient network dropouts / fetch failures before reporting an error; in-chat interactive error card with single-click **"⎌ Retry Request"** button if all retries fail, avoiding intrusive raw error popups.

### Phase 3 — Permissions & Safety
- Permission manager + confirmation dialogs for edit/terminal/cross-file access
- Diff-preview UI for proposed code edits, "Apply edit" action via `WorkspaceEdit`
- Proposal lifecycle tracking: in-chat cards display clean file headers and post-resolution status badges (`✓ Applied` / `✗ Failed to apply`) once applied or rejected
- Re-editable applied files: applied or rejected status is tracked per proposal instance, ensuring subsequent model or user edits to the same file remain fully editable and generate fresh action cards without locking
- **Consolidated Proposal Controls & Deduplication:** With the introduction of the Persistent Pending-Edits Bar, redundant action buttons (`Preview Diff`, `Apply Edit`, `Reject`) are eliminated from the in-chat message cards to prevent UI duplication. All active proposal review and resolution actions are consolidated exclusively in the Pending-Edits Bar, while the in-chat cards serve as clean historical audit records.
- **Silent Application (No Intrusive Toasts):** Applying or rejecting an edit operates silently without modal notifications or `vscode.window.showInformationMessage` toast popups ("Successfully applied edit..."). Immediate visual feedback is provided directly within the webview UI via the `✓ Applied` status badge, updated pending counters, and smooth automatic collapse of the Pending-Edits Bar upon resolving all items.
- **Persistent Pending-Edits Bar Amendment (referenced by Phase 8):**
  - Positioned directly above the input bar, stacked above the existing Context preview strip (`Input box` → `Context bar` → `Pending Edits bar` → `Message thread`).
  - Only renders when there is at least one unresolved (not yet applied or rejected) AI-proposed edit; collapses when 0 pending.
  - Each pending edit shows as a compact row: file name, "Preview Diff", Apply, Reject. Resolving one does not lock others.
  - When there are 3 or more pending edits ($\ge 3$), displays "Apply All" and "Reject All" bulk action buttons.
  - **Undo Scoping Invariant:** When "Apply All" applies edits across multiple files in one action, shadow-git checkpoints are treated as one single atomic undoable unit. Triggering undo reverts all files affected by that single click together (`git checkout <checkpointId> -- <file1> <file2> ...`), satisfying §4.3.
- Terminal command confirmation flow + destructive-command flagging + suggested reverse commands + one-click "Run in Terminal" action cards

### Phase 4 — Shadow-Git Undo System
- Shadow repo creation/management (`--git-dir`/`--work-tree`), `.gitignore` respect
- Checkpoint creation pre-action covering code edits, file creation, and file deletion; checkpointId tagging on chat turns
- Scoped restore logic + hard requirement testing (never touch out-of-changeset files)
- Drift detection + warn-and-let-user-decide flow
- Always-visible user message undo action (`⎌` back-arrow icon) rendered alongside Copy on every user message that triggered an AI action
- Multi-step rollback: selecting undo on any historical turn cleanly reverts all workspace changes back to the state immediately before that turn's action
- Disabled-state handling: undo icon renders visible but greyed-out with a helpful tooltip when checkpoints are cleared or unavailable (e.g. across window closes or `.gitignore`'d files)
- Window-close clear trigger for shadow checkpoints

### Phase 5 — Cost & Context Management
- Token usage logging (SQLite store), cost computation from pricing data
- Terminal command audit logging into the same store
- Usage Report view: summary cards, filters (model/date/project), per-project tagging,
  filtered CSV export
- Rolling auto-summarization (long-conversation trigger) + model-switch summarization
- Pinned context tier (manual pin/unpin, exclusion from summarization, token meter split)
- Context meter in footer strip (tokens / max context %, instant reset on new chat click, and session-synchronized token calculation upon switching history)

### Phase 6 — Polish & Edge Cases
- Staged "Clear history" flow (category selection → scoped confirmation)
- Drop-with-notice behavior for capability loss on model switch
- Clean historical conversation viewing (automatic hiding of actionable approval and undo buttons on past chat sessions)
- Soft warning on pinned-context growth
- Multi-root workspace project resolution edge cases
- Resizable panel layout QA (fluid sizing, no fixed-width clipping)
- Full pass against Success Criteria (§7) before release


## Phase 7 — Privacy & Data Handling

**Goal:** Ensure user/client code and secrets are protected before they ever leave the machine, and give users visibility and control over what's shared with third-party model providers.

### 7.1 Secret Redaction (priority item — highest urgency)
- Before any outgoing request (chat context, file/selection content, image attachments), scan the payload for patterns that look like secrets: high-entropy strings, common key prefixes (`sk-`, `AKIA`, `ghp_`, `xox[baprs]-`, etc.), `.env`-style `KEY=value` lines, and known credential file patterns.
- Runs **regardless of `.gitignore` status** — plenty of real secrets end up in tracked files by accident, so gitignore state is not a reliable signal here.
- On detection: mask the value in what's sent (e.g. `sk-***redacted***`) by default; a setting can allow switching to "block and warn" instead for users who want to review before any redacted content goes out at all.
- Adapt rule sets from established open-source secret-scanning tools (e.g. gitleaks/truffleHog-style regex and entropy rules) rather than inventing detection patterns from scratch.
- Redaction applies to both the live chat context sent per-turn and any file content pulled in via cross-file access permission (§4.1).

### 7.2 Context Preview
- A small expandable element near the input bar, visible before/as a request is sent: "Context included: `auth.ts` (lines 12–45), 1 image" — makes explicit exactly what's being sent to the model for that turn.
- **Live Buffer Snippet Preview:** Expanding the Context Preview displays the actual live in-memory buffer snippet being transmitted, along with any referenced workspace files, attached images, secret redaction counts, and ZDR status so the user can verify the exact editor state before or during model review.
- Does not block sending by default — purely a transparency surface, since the information is already available at send-time and just needs to be exposed rather than newly computed.
- Should also reflect when redaction (§7.1) has masked something in that turn's outgoing context, so the user knows both what was sent and what was withheld.

### 7.3 Provider Data-Retention Preference
- A setting exposing provider-level data handling where OpenRouter's model/provider metadata makes this determinable (e.g. preferring providers with documented zero-data-retention terms over those that retain/train on API data by default).
- Scope this carefully — OpenRouter's granularity on this varies by provider, so treat it as an informational preference/filter rather than a guaranteed enforcement mechanism, and be explicit in the UI about that limitation rather than implying a stronger guarantee than can actually be verified.
- At minimum: a direct link from Settings to OpenRouter's own data-policy documentation, so the extension isn't making privacy claims on providers' behalf that it can't independently confirm.

### 7.4 Sequencing Note
- §7.1 (secret redaction) is the priority item — it's the one failure mode in this phase that's silent and irreversible once it happens, and realistic given how often real codebases contain stray credentials. Recommended as a required item before using the extension on any real (non-demo) client project.
- §7.2 and §7.3 are lower urgency — they're about trust and transparency rather than preventing an active leak — and can reasonably follow in a fast-follow update if needed.



## Phase 8 — Diagnostics-to-AI (Problems Panel Integration)

**Goal:** Let the user send VS Code diagnostics (errors/warnings) directly to the AI for resolution, either in bulk or one at a time, sourced from VS Code's native Problems panel, without manually copying error text into chat.

**Depends on / reuses:** §3.4 (context-limit awareness, for the payload-size safeguard), §4.1 (permission model, since reading diagnostics is treated as a context-read like any other), §7.1 (secret redaction, applied to outgoing diagnostic/code context), and Phase 3's diff-preview + Apply Edit pipeline (for how the AI's proposed fixes are reviewed and applied).

### 8.1 Data Source
- Built on VS Code's native diagnostics API (`vscode.languages.getDiagnostics()`), the same data that populates VS Code's built-in **Problems panel**. No custom error detection is built — this surfaces what VS Code (via TypeScript, ESLint, and other linters) already knows.
- Each diagnostic carries: file path, line/range, severity (error/warning/info), message, and source (e.g. `eslint`, `ts`).

### 8.2 Entry Point 1 — Per-Problem Action (Native Problems Panel)
- Adds an **"Ask AI to fix this"** action directly into VS Code's native Problems panel, available per-entry (via right-click / inline action icon on a problem row), and on the in-editor squiggle itself (right-click on the underlined error/warning in the code).
- Selecting it sends that single diagnostic — plus enough surrounding code context for the agent to act on precisely (not necessarily the whole file) — as a new chat turn.
- This flows into the existing diff-preview + Apply Edit pipeline (Phase 3) like any other AI-proposed change — reviewed and applied the same way, no special-cased edit path.

### 8.3 Entry Point 2 — "Send All Problems" Bulk Action
- Available **only from the native Problems panel** — a toolbar/title-bar action within the Problems panel itself (e.g. "Send All to Agent"), consistent with the per-problem action in §8.2. No separate visible action is added to the chat panel/input bar.
- **No `@`-mention system required.** This does not depend on building a general mention/autocomplete infrastructure. Clicking the Problems panel action simply inserts the literal text `@current_problems` into the chat input box as plain text — the same way any text could be typed or pasted in. No dropdown, no autocomplete menu, no parsing of arbitrary `@` triggers elsewhere in the input.
- **Send-time detection, not input-time parsing:** when the message is sent, the send handler checks the outgoing text for the literal string `@current_problems` (a simple string match/regex, not a mention system) and, if found, expands it into the full structured diagnostics payload before the request goes out. Everything else about the message (any additional instructions the user typed alongside it) is left untouched.
- **Input box stays short regardless of problem count.** Only the short literal token is ever inserted into the visible chat input — never the expanded diagnostic list itself. Expansion happens exclusively in the outgoing payload at send-time, so the input box remains readable and editable no matter how many diagnostics exist.
- This preserves the user-facing benefits of a mention-style flow — the user sees the token before sending, can add their own instructions alongside it (e.g. `@current_problems fix these but skip the test files`), and gets diagnostics resolved fresh at send-time rather than stale at click-time — without requiring any `@`-mention feature to exist first.
- **Default scope: current file only.** A separate literal token (e.g. `@all_problems`) can be inserted/typed for workspace-wide diagnostics, detected and expanded the same way at send-time.
- **Default severity filter: errors only.** An option to include warnings is available for users who want the AI to clean those up too.
- **Payload-size safeguard for large diagnostic counts:** since the expanded payload (not the input text) is what could genuinely grow large with hundreds of problems, if the expansion would exceed a reasonable size (e.g. a configurable cap, or a percentage of the active model's context window), the user is shown a warning before sending — e.g. "This would include 340 problems (~12,000 tokens) — consider filtering to errors only, or scoping to the current file" — rather than silently sending an oversized request. This reuses the context-limit awareness already built for long-conversation management (§3.4).
- **Bulk send remains a single structured message, not N separate turns** — the token still expands into one list, sent as one turn, so the agent can reason across problems together (useful when multiple diagnostics share one root cause) rather than fixing them in isolation one at a time.
- **Future extension point (not required for this phase):** if a general `@`-mention system for files/context is built later, `@current_problems` and `@all_problems` can be folded into that system as recognized mention types rather than plain string detection — but this phase does not require or depend on that broader system existing first.

### 8.4 Consistency With Existing Systems
- Both entry points (single-problem and bulk) route into the same underlying diagnostic-assembly logic — they differ only in the selection step (one diagnostic vs. a filtered set), not in how the data is structured or sent.
- Respects the existing permission model (§4.1) the same way any other AI context-read does — reading diagnostic metadata is treated consistently with reading file content for context, not as a separate lower-risk category, since diagnostics are still workspace information being sent to a third-party model.
- Subject to the same secret redaction pass (§7.1) as any other outgoing content, in case a diagnostic message or surrounding code context happens to include something sensitive (e.g. an error message that echoes a value from a `.env` file).



## Phase 9 — Context-Aware Prompt Refinement & Default Implementation Planning

**Goal:** Combine four interrelated behavioral directives into the universal system prompt sent with every chat request, establishing a predictable, high-precision order of operations across all models without creating rigid or brittle programmatic gates in code.

### 9.1 Order of Operations (Strict Execution Sequence)
To prevent conflicting instructions (e.g. attempting to produce an implementation plan before resolving which file is being modified), the assistant strictly adheres to this 4-step sequence:
1. **Context Resolution & Clarification** (Resolve ambiguity before asking)
2. **Implementation Planning** (Plan before acting, unless overridden)
3. **Action Execution & Code Navigation** (Act with targeted precision)
4. **Post-Application Verification** (Verify before declaring done)

### 9.2 Directive 1: Context-Aware Clarification — Resolve Before Asking
- **Skip Search Entirely for Explicitly Named Files:** If the user's message explicitly names the target file(s) (e.g. "edit `auth.ts` to add session expiry"), the assistant proceeds directly against that named file without first running a workspace search to find or verify it. Search is a fallback for genuinely unknown locations, not a mandatory prerequisite. This prevents unnecessary token waste on lower-tier and pro models alike.
- **Nonexistent Named File Handling:** If a user specifies a file name that does not exist in the active workspace or open documents, the assistant does NOT hallucinate contents or fail silently. It falls back to searching the workspace for near matches (e.g. matching base names across folders) or asks for clarification in plain language, offering the closest found candidates.
- **Proactive Resolution:** For requests with clear intent but unspecified locations, the assistant inspects open editor buffers, recent diagnostics (Phase 8), and workspace file lists before asking the user.
- **Clarification as Last Resort:** Clarification is asked only when ambiguity cannot be resolved autonomously. The prompt requires plain, non-technical language and concrete options (e.g. "I found two places that might handle this — login or signup, which did you mean?") rather than asking for raw file paths.

### 9.3 Directive 2: Default-to-Plan Behavior
- **Default Requirement:** Before taking side-effecting actions (emitting ` ```edit_file `, ` ```create_file `, or ` ```bash ` blocks), the assistant outputs a concise plain-language implementation plan explaining what will be changed and why.
- **Per-Request Overrides:** If the user explicitly asks to skip planning ("just do it", "skip the plan", "go ahead", "proceed directly", "no plan needed"), the planning step is bypassed for that request only.
- **Trivial Fixes Exception:** Genuinely trivial, low-risk, single-file edits (e.g. fixing a typo, simple rename, or one-line bug fix) may skip the plan without an explicit user override.

### 9.4 Directive 3: Search-Before-Read Code Navigation
- Instructs the assistant to favor targeted search/grep queries to locate functions and symbols rather than reading entire files sequentially line-by-line. This significantly improves performance and token efficiency on cheaper models.

### 9.5 Directive 4: Post-Application Code Verification & Terminal Confirmation
- **Post-Application Timing:** Verification occurs strictly *after* edits are applied by the user via the diff-preview pipeline.
- **Verification Workflow:**
  1. Re-check VS Code diagnostics on affected files to confirm the reported problem is gone and no new errors/warnings were introduced.
  2. Verify that the reported bug or requirement is satisfied.
  3. Suggest running related automated tests where available.
- **Terminal Confirmation Gate (§4.1/§4.3):** Running automated verification tests (e.g. `npm test`, `pytest`) is a terminal action. The assistant must format test commands as standard ` ```bash ` blocks so that execution routes through `CommandRunner.executeCommand()`, requiring the user's explicit confirmation via the permission dialog. Test runs never execute silently or bypass confirmation.
- **Honest Reporting:** If verification fails or tests error out, the assistant must directly state what failed and propose a follow-up fix or ask for guidance, rather than falsely declaring success.

### 9.6 Architectural Note: Model-Agnostic Prompt Directives
All four directives are implemented directly within the base system prompt transmitted with every completion call (`buildSystemPrompt()`). They are prompt-based directives rather than hardcoded programmatic state machines, ensuring consistent behavior across all selected OpenRouter models. As prompt directives, lower-tier models may occasionally follow them with varying fidelity compared to frontier models.