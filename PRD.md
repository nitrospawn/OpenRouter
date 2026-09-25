# PRD: OpenRouter — Product Requirements Document (PRD)

**Status:** Living Specification  
**Version:** 0.4.7  
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
- Setting: `openrouterCopilot.panelPosition`: `"left" | "right"`, applied via `workbench.view` placement on activation, but user's manual drag always wins (don't force-reset it). Note: To keep the in-panel Settings view streamlined and uncluttered, manual panel position segmented buttons and duplicate default model dropdowns are excluded from the settings UI (relying on native VS Code view dragging and the main chat header combobox).
- **Resizable width:** since the panel lives in a native VS Code View Container, it inherits VS Code's built-in drag-to-resize behavior on the sidebar border for free — no custom resize logic needed. Requirement: the webview's internal layout must use fluid/percentage-based sizing (not fixed pixel widths) so content reflows correctly as the user drags the panel narrower or wider, rather than clipping or overflowing.
- Layout top to bottom:
  1. **Header bar** — model selector dropdown (searchable), reasoning-effort dropdown (conditionally visible, positioned strictly between model selector and "+" new chat button; order: model selector → reasoning-effort dropdown → "+" button → gear icon), capability icon badges (image icon / mic icon) shown live for the selected model, settings gear.
  2. **Conversation thread** — messages, streamed responses, inline diff previews for proposed code edits with an "Apply edit" action, collapsible tool-call logs, and inline system notes (e.g. capability-loss notices on model switch, per §3.3).
  3. **Input bar** — text box; undo icon, image-upload icon, and mic icon appear/disappear based on selected model's `input_modalities`; send button; dynamic pre-flight token estimate indicator showing calculated tokens for the prompt text plus all staged file attachments, document chips, and images (per §3.4.1).
  4. **Footer strip** — context-used meter (e.g. "34% of context used") plus running session token count + cost.

**Reasoning Effort Selector (Header Control):**
A compact reasoning-effort dropdown positioned in the header row directly BETWEEN the model selector combobox and the "+" (new chat) button. Order from left to right: model selector → reasoning-effort dropdown → "+" new chat button → gear (settings) icon.
- **Layout & Sizing:** The model selector combobox is narrowed to make room for this new control without pushing the gear icon further right and without adding a second header row.
- **Conditional Visibility:** Following the same pattern as capability badges (§3.3), this control is only rendered when the currently selected model supports a reasoning-effort parameter (`supportsReasoningEffort`). When unsupported, the dropdown is completely absent from the DOM / display and the "+" button sits directly adjacent to the model selector combobox.
- **Supported Levels Subset:** If a model supports fewer than three effort levels, only the levels it actually supports are rendered in the dropdown (e.g., if a model only supports `low` and `medium`, `high` is omitted). Supported levels default to `['low', 'medium', 'high']` for reasoning models.
- **Default Value (Low-by-Default Baseline):** For models with reasoning capacity (`supportsReasoningEffort`), the selector automatically defaults to **`low`** (via `getDefaultReasoningEffort()`), prioritizing rapid response times and cost efficiency. If `low` is unavailable for a model, it falls back to `medium` or the first supported tier.
- **Session Startup & Reopen Reset:** On each startup, panel reopen, or extension reload, the selector cleanly re-initializes to **`low`** for reasoning models, irrespective of any previous session selection. This provides an intentional cost/latency safeguard against forgotten "High" effort settings.
- **Dynamic State & Model Switching:**
  - Mid-session changes to the reasoning effort level take effect immediately on the next request sent and persist for the remainder of that active session.
  - If the user switches to a model that does not support reasoning effort, the dropdown container is completely hidden, and the active effort is cleared to `undefined` so `reasoning_effort` is never transmitted to unsupported models. Switching back to a reasoning model re-initializes to `low`.
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

#### 3.4.1 Attached File & Document Token Accounting
Attached files (code files, workspace docs, Plan/Walkthrough artifacts, and image attachments) carry substantial token weight and must be accurately surfaced in both pre-flight input estimation and running context accounting:

1. **Pre-Flight Input Bar Estimation (Staged Draft):**
   - As the user types in the input bar or stages attachments (via `@` mention chips, file attachment buttons, or "Send to Reviewer" doc chips):
     - **Text & Code Files:** Estimated as `Math.ceil(fileContent.length / 4)` tokens per attached file.
     - **Artifact Documents:** Staged Plan docs or Walkthrough/Results docs compute tokens based on their full serialized markdown payload.
     - **Image / Multimodal Attachments:** For vision-capable models, vision token calculations are factored in based on standard tile budgeting (e.g., base ~85 tokens + ~170 tokens per 512×512 tile).
     - **Combined Pre-Flight Total:** The staged prompt estimate combines `userTypedText` tokens + `sum(attachedFileTokens)` + `imageTokens`.
2. **Pre-Flight Footer Meter Projection:**
   - When attachments are staged in the input bar, the footer context meter dynamically indicates the projected impact (e.g., `(Projected: +3,450 tokens)` or visual projected fill percentage) prior to sending, alerting users before they exceed the model's token limits.
3. **Session History Synchronization:**
   - When switching or loading sessions (`HISTORY_LOADED`), token meter fallback calculations must not only sum `m.content` characters, but also include all attached file payloads (`m.attachments[].content`, `m.attachedFile.content`, `m.planDocument`, `m.walkthroughDocument`).
   - This ensures that reloading past sessions containing file attachments accurately initializes the token meter to true consumed context.

### 3.5 Usage Report View
- Separate full view (`#view-usage`) within the webview container, navigated to via Settings or direct commands, featuring a pinned header strip (`.settings-header-strip`) with back navigation (`‹ Settings`), view title ("Usage Report"), and a dynamic export button (`📥 Export CSV (N)`).
- **Summary Spend Metric Cards (4-Card Responsive Grid):**
  - Displays four summary spend cards in a responsive grid (`repeat(4, 1fr)` with `@media (max-width: 360px)` 2x2 wrapping):
    1. **Today Spend** (`#spend-today`): Total spend incurred today.
    2. **This Week Spend** (`#spend-week`): Total spend incurred during the current week.
    3. **This Month Spend** (`#spend-month`): Total spend incurred during the current calendar month.
    4. **Total Cost** (`#spend-total`): Cumulative lifetime spend across all recorded history.
  - **Dynamic / Reactive Filtering:** All four summary cards dynamically recalculate in real-time based on the active `#filter-project` and `#filter-model` selections. Filtering to a specific client project or model immediately recalculates Today, This Week, This Month, and Total Cost for that specific subset, providing accurate multi-dimensional financial visibility.
- **Filter Controls & Workspace Context:**
  - **Auto-Selected Workspace Default:** On opening the Usage Report, `#filter-project` automatically pre-selects the currently active VS Code workspace project folder (while retaining "All Projects" as an option).
  - **Cascading / Dependent Model Filter:** Selecting a project in `#filter-project` dynamically updates `#filter-model` to list only the models that were actually used within that selected project (plus "All Models"), preventing empty zero-match combinations.
  - **Dynamic Population:** The project filter dropdown is populated dynamically from distinct project values present in the local log — no manual project list is required.
- **Audit Table & Pagination:**
  - Scrollable audit log table listing every logged event — both AI chat calls (timestamp, model annotated with reasoning effort tier, e.g. `Model (High)`, prompt tokens, completion tokens, cost, workspace project) and terminal command audit entries (§4.3/§5.3).
  - **Table Pagination:** Renders the first 100 matching entries initially with a smooth "Show more" button for fast DOM performance on large datasets.
  - **Terminal Command Audit Integrity:** Confirmed terminal command executions log into `UsageStore` alongside AI requests with `cost: 0`, `promptTokens: 0`, `completionTokens: 0`, `totalTokens: 0`, and the active workspace project name, maintaining a unified audit trail with zero token distortion.
- **Export to CSV with Live Count:**
  - The Export CSV button dynamically indicates the full filtered count (e.g. `📥 Export CSV (42)`), exporting all matching records across the full dataset regardless of visible table pagination limit.
- **Pinned Header & Scroll Architecture:**
  - A fixed header strip (`.settings-header-strip`) keeps navigation and export actions permanently accessible while the audit table scrolls independently inside `#usage-scroll-body`. Navigating between views automatically resets scroll position (`scrollTop = 0`).
- **Clear history — single entry point, staged flow:** Located in the Settings "Usage data" row alongside `📊 View usage report` and `View logs` (which opens diagnostic logs in a dedicated editor tab), the "Clear history" button is positioned at the far right. Settings has one "Clear history" button, not two separate ones. Clicking it opens a **category selection step first** — "What would you like to clear? Chat history / Usage data" — rather than immediately confirming a deletion. Once the user picks one, a second, final confirmation step follows, scoped to that specific category (e.g. picking "Chat history" shows "This will permanently delete N chat conversations. This cannot be undone." with a "Yes, delete" button; picking "Usage data" shows the equivalent for M logged usage/cost records). Only the category the user explicitly selected is affected — the other remains untouched. This is a three-step flow overall: Clear history → choose category → confirm deletion.

---

## 4. Permissions Model

This is the most important trust surface in the product. Default posture: **ask, don't assume.**

### 4.1 Permission Categories
| Action | Default Behavior | User Control |
|---|---|---|
| Read open file / selection for context | **Allowed automatically** (read-only, no side effects) | Toggle off in settings if desired |
| Propose a code edit | Always shown as a **diff preview** first | Accept / Reject / Edit-then-accept per hunk |
| Apply a code edit | **Ask each time** (explicit confirmation dialog / Pending Edits review) | Can set "Allow" (zero-interaction auto-apply) or "Deny" |
| Create/delete files | Explicit confirmation dialog every time (not auto-accept-able) | N/A — always confirmed |
| Run a terminal command | **Ask each time** (explicit confirmation dialog showing exact command) | Can set "Allow" (zero-interaction auto-run), "Always allow this exact command", or "Deny" |
| Access to other (unopened) files in workspace | **Allowed automatically** (ambient read-only workspace context) | Toggle off in settings if desired |

### 4.1.1 Permission System Refinements & Execution Rules (Amendment)

1. **Allow = Zero Manual Interaction (All Applicable Categories):**
   - **`applyEdit = Allow`:** When set to Allow, proposed code edits are applied **automatically** with no manual "Apply" button click and no actionable entries placed in the Pending Edits bar. The edit is written to disk immediately once generated, followed by a concise confirmation summary posted to chat (e.g. `✓ Applied: updated auth.ts`).
   - **`runTerminalCommand = Allow`:** When set to Allow, proposed terminal commands execute **automatically** with no "Run in Terminal" button click and no modal confirmation dialog, followed by an execution summary posted to chat.
   - **`Ask` Mode:** When either permission is set to Ask, the standard manual flow remains completely unchanged (user reviews and clicks Apply/Deny/Diff for edits, Run/Deny for commands).
   - **`Deny` Mode:** Refused immediately without dialogs or execution. To preserve user trust and prevent false claims of success from optimistic model narration, when an edit proposal or terminal command is generated under Deny mode, the extension immediately surfaces a clear notice and appends a distinct system correction in chat: `"⚠️ This edit was not applied — Code edits permission is currently set to Denied."`, and renders the proposal card with an explicit denial badge (`✗ Edit blocked — Code edits permission is set to Denied`). The disk remains untouched and no false success is asserted.
   - **Safety Invariant:** All security, backup, and recovery mechanisms apply identically for auto-applied actions under Allow as they do for manually clicked actions:
     - **Shadow-git Checkpointing (§4.3):** A shadow-git commit is created immediately prior to applying any edit.
     - **Secret Redaction (§7.1):** Outgoing context and terminal outputs are scanned and masked.
     - **Scoped Restore & Drift Detection:** The user may rewind any auto-applied turn via the undo button on the user message.
     - **Safe Failure on Malformed Edits:** Malformed `SEARCH/REPLACE` blocks or file-write failures fail safely, surfacing clear error messages in chat without corrupting or wiping existing files.
   - **Ambient Read Categories:** `readActiveContext` and `readWorkspaceFiles` operate with zero manual interaction under Allow (ambient read-only context).

2. **Standard Default Permission States (Fresh Install / New Workspace):**
   | Permission | Default State | Behavior |
   |---|---|---|
   | Read open file for context (`readActiveContext`) | **Allowed** | Ambient read of active editor buffer |
   | Code edits (`applyEdit`) | **Ask each time** | Review via diff preview & Pending Edits bar |
   | Terminal commands (`runTerminalCommand`) | **Ask each time** | Modal dialog with exact command and cwd |
   | Access other workspace files (`readWorkspaceFiles`) | **Allowed** | Ambient cross-file resolution & symbol search |
   *These defaults apply on initial installation or fresh workspace state. Once customized by the user in Settings, chosen values persist and are never silently overwritten back to defaults.*

3. **Live Mid-Session Permission Updates:**
   - Permission modifications made in Settings (or via Command Palette) take effect **immediately on the very next action** within an active conversation — without requiring a new chat session, window reload, or extension restart.
   - Applies symmetrically in both directions (loosening from Ask/Deny to Allow, and tightening from Allow back to Ask/Deny) across all categories.
   - **Pending Edits Lifecycle on Mode Switch:** Pre-existing edits that were proposed under `Ask` and remain in the Pending Edits bar are not retroactively applied to disk upon switching to `Allow`. They remain pending for the user's manual disposition, while all edits generated subsequently auto-apply immediately.

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
- **Streamlined Configuration:** To eliminate clutter and preserve vertical space, redundant manual panel position buttons (Left/Right) and duplicate default model dropdowns are removed from the Settings UI. Panel positioning is handled natively via VS Code view drag-and-drop (or setting `openrouterCopilot.panelPosition`), and model selection is handled directly via the primary chat header combobox.
- **Pinned Header Strip:** A fixed header strip (`.settings-header-strip`) keeps the `‹ Back` navigation button and "Settings" title permanently pinned at the top, while configuration options scroll smoothly inside `#settings-scroll-body`. Scroll position is automatically reset (`scrollTop = 0`) on view transitions.
- **Permission States:** Interactive toggles and selectors for file read, code edit auto-apply/ask/deny, terminal execution, and cross-file access (§4.1).
- **Reviewer Model Configuration:** Workspace-scoped master toggle, side-by-side reviewer model and dynamic reasoning-effort selector, and customizable reviewer system prompt (§10).
- **Usage Data & Diagnostic Logs Actions:** The "Usage data" section provides direct action buttons: `📊 View usage report`, `View logs` (opens the active diagnostic log file in a new VS Code editor tab via `openrouter.openDiagnosticLog`), and a danger-accented `Clear history` button positioned at the far right.
- **History & Retention:** Staged "Clear history" flow with category selection (Chat history vs. Usage data) and scoped confirmation dialogs (§3.5).
- **Privacy Policy Link:** Direct link in Settings pointing to OpenRouter's official privacy documentation at `https://openrouter.ai/privacy` (§7.3).
- **Version Indicator:** Displays the current extension version (e.g. `OpenRouter v0.3.0`) pinned at the bottom of the Settings view, updated synchronously with `package.json` across version increments.

### 5.5 Dynamic Environment & Shell Injection
- **Runtime Environment Resolution:** When assembling system instructions for model completion turns, the extension queries the runtime environment via Node.js standard APIs (`process.platform`, `process.env.ComSpec`, `process.env.SHELL`) rather than static or hardcoded defaults.
- **Platform & Shell Adaptation:**
  - **Windows (`win32`):** Injects explicit operating system identity and default shell (`cmd.exe` or `powershell.exe`). Enforces Windows command syntax: forbids Unix-only utilities (`pwd`, `ls`, `cat`, `grep`, `export`, `rm -rf`, `touch`) and instructs use of Windows native equivalents (e.g. `cd` without arguments to print working directory, `dir` to list files, `type` to inspect files, Windows path conventions).
  - **macOS / Linux (`darwin` / `linux`):** Injects POSIX/Unix environment identity and shell (`bash`, `zsh`), directing standard POSIX shell syntax.
- **Dynamic Code Fence Language Tagging:** Shell commands in model responses are directed to use the appropriate language identifier for the detected shell (e.g. \`\`\`cmd, \`\`\`powershell, or \`\`\`bash), aligning with client-side block matchers.
- **Recent Terminal Outputs Feedback:** Feeds recent terminal command executions (`terminalOutputs`) into the system prompt context, ensuring the model maintains visibility into real command exit codes and captured stdout/stderr.

### 5.6 Terminal Command Self-Healing & Auto-Retry Loop (Bounded Recovery)
- **Autonomous Error Recovery (`runTerminalCommand = 'allow'`):** When terminal commands auto-execute under Allow permission and return a non-zero exit status code (`result.executed && result.exitCode !== 0`), the extension initiates an automated self-healing retry turn. The failure details (command, non-zero exit code, truncated stderr/stdout) are packaged into a diagnosis prompt sent to the active model.
- **Infinite Loop Safeguards & Circuit Breakers:**
  1. **Hard Retry Limit (`MAX_TERMINAL_RETRIES = 2`):** A strict attempt cap limits self-healing turns to at most 2 retries per command chain. If the second retry still fails, execution halts unconditionally with an explanatory warning posted to chat: `⚠️ Terminal auto-retry limit reached (2/2 attempts). Halting self-healing loop.`
  2. **Duplicate Failing Command Suppression:** The extension maintains a set of failed commands for the active turn. If the model suggests the identical failing command that previously failed, the retry terminates immediately: `⚠️ Model proposed identical failing command '<cmd>'. Halting self-healing retry to prevent infinite execution.`
  3. **User Abort & Cancellation Propagation:** If the user clicks the "Stop" button or triggers a session abort controller, all active execution and pending self-healing retries terminate instantly.
  4. **Non-Cascading Command Execution:** If a command in a multi-command response block fails, subsequent commands in that block are halted immediately to prevent running downstream commands that rely on the failed predecessor.
  5. **Transparent Chat Audit Trail:** Each retry attempt logs a visible notice in the chat thread (e.g. `🔄 Terminal command '<cmd>' failed with exit code 1. Initiating self-healing retry (1/2)...`) so the user maintains complete real-time visibility into the autonomous recovery cycle.

### 5.7 Two-Tier Terminal Command Architecture & Screen Clutter Reduction
- **Problem Solved:** When a model inspects the codebase using inspection commands (`type`, `dir`, `cat`, `ls`, `grep`), rendering full "Terminal Command" cards and raw stdout chat messages generated excessive visual noise.
- **Tier 1 — Read-Only / Inspection Commands:**
  - **Classified Commands:** `type`, `dir`, `cat`, `ls`, `grep`, `find`, `findstr`, `pwd`, `echo`, `head`, `tail`, `wc`, `which`, `where`, `Get-Content`, `Get-ChildItem`, `Select-String`, and git inspection (`git status`, `git diff`, `git log`).
  - **Silent Execution & Zero Clutter:** No `.terminal-card` is rendered in the chat UI, and no raw stdout message (`termMsg`) is appended to chat history. The chat remains clean and readable.
  - **Live Screen Feedback:** While running, the progress bar and status indicator display live real-time feedback (e.g. `Reading file: index.ts...` or `Inspecting directory...`), which automatically disappears upon completion.
  - **Full Context Pipe:** Outputs are captured in `TerminalOutputTracker` and fed to the model context for autonomous continuation and planning.
  - **Zero Permission Friction:** Pure read-only commands do not prompt confirmation dialogs in either `"allow"` or `"ask"` permission modes (as long as `runTerminalCommand` is not `"deny"`).
- **Tier 2 — Side-Effecting / Mutating Commands:**
  - **Commands:** Package managers (`npm`, `yarn`, `pnpm`, `pip`), compiler/build scripts, git mutating commands (`commit`, `push`), file creations/deletions/writes (`rm`, `del`, `mkdir`).
  - **Redirection & Chaining Safety:** Any command containing file redirection (`>` or `>>`) or PowerShell file-writing cmdlets (`Out-File`, `Set-Content`, `Add-Content`) is strictly promoted to Tier 2. Chained commands (`&&`, `;`, `|`) are treated as Tier 2 if any segment is mutating.
  - **Full Visual Treatment:** Interactive `.terminal-card` cards render in chat with action buttons, status badges, and output details. Governed strictly by the "Terminal commands" permission toggle (`allow`, `ask`, `deny`).

### 5.8 Resilient Targeted Edit (SEARCH/REPLACE) Parsing & Extraction
- **Non-Truncating Action Block Extraction:** When parsing model responses, action blocks (`edit_file`, `create_file`, `file`) use a lookahead-aware regex (`/(?:```|````)(?:create_file|edit_file|file):([^\r\n]+)\r?\n((?:[\s\S]*?<<<< SEARCH[\s\S]*?\n>>>>[^\r\n]*|[\s\S]*?))\r?\n(?:```|````)/gi`) that matches through to the terminating `>>>>` marker before closing. Internal code blocks (such as code snippets inside Markdown files like `PRD.md` or accidental model wrapping) do not prematurely sever the edit block or spill the replacement hunk into the chat thread.
- **Marker Tolerances & Git Conflict Disambiguation:** The parser tolerates trailing spaces, tabs, and optional marker annotations on `<<<< SEARCH`, `====`, and `>>>>` lines, while strictly distinguishing 4-character markers from 7-character Git merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`).
- **Spurious Code Fence Auto-Unwrapping:** If the model wraps replacement content in conversational code fences (e.g. ```` ```text\n...\n``` ````) where the search block contains no code fences, the parser automatically unwraps the extraneous backticks so raw content is applied cleanly to disk.
- **Trailing Whitespace Fallback (`trimEnd`):** Line endings are normalized to LF (`\n`). If strict exact matching fails solely due to trailing whitespace discrepancies on lines between the prompt context and on-disk buffer, a line-by-line `trimEnd()` fallback locates the matching hunk and reconstructs the file without dropping boundary newlines.
- **Prompt-Level Invariant:** The system prompt explicitly instructs models that internal backtick fences and markdown language tags are strictly forbidden inside `SEARCH` and `REPLACE` blocks.

### 5.9 Autonomous Plan Continuity & Non-Blocking Execution Engine
- **Non-Blocking File Modifications During Plan Execution (`applyEdit: 'ask'`):**
  - **Philosophy:** Aligns with modern AI coding platforms (Cursor, Windsurf, Copilot Edits). When an implementation plan has been approved by the user, the agent completes all planned modifications continuously without pausing between individual files to ask for approval.
  - **Rollback / Keep-or-Revert Architecture:** Rather than blocking execution, each file edit is automatically staged into a unified shadow-git checkpoint before disk write. The webview diff cards update to `✓ Applied` and provide interactive diff inspection and full per-turn Undo capabilities. The user retains complete review and revert control without the agent grinding to a halt mid-plan.
  - **Deny Permission Invariant:** If `applyEdit` is explicitly toggled to `'deny'`, file edits are strictly prevented from auto-applying and surface a clear rejection audit message.
  - **Isolated Single-Turn Fallback:** When code edits are proposed in isolation outside an active plan and outside autonomous execution, `applyEdit: 'ask'` maintains standard confirmation behavior.
- **Broadened Approval & Execution Intent Recognition:**
  - **Natural Language Command Tolerance:** In `panelProvider.ts`, `isExecutionIntent` matches all natural user approval commands, including `"proceed"`, `"continue"`, `"please continue"`, `"start"`, `"do it"`, `"carry on"`, `"approved"`, `"go ahead"`, `"apply the plan"`, `"yes"`, and `"ok"`.
  - **Plan-Aware Intent Resolution:** If an uncompleted implementation plan exists in the conversation history, any short affirmative user response (e.g. `"yes"`, `"sure"`, `"next"`, `"continue"`) is automatically promoted to execution intent, initializing the autonomous retry/continuation context.
- **OpenRouter Token Limit Cutoff Auto-Resumption (`finish_reason: 'length'`):**
  - **SSE Chunk Parsing:** The streaming parser in `openrouterClient.ts` captures `finish_reason` directly from `choices[0].finish_reason` in Server-Sent Events.
  - **Automated Resume Turn:** When `finish_reason === 'length'` occurs during plan execution, the extension detects that the model was cut off mid-response by `max_tokens`. It applies any complete code blocks already parsed, and automatically triggers a seamless continuation turn prompting the model to resume directly from the exact point where it was cut off.
- **Auto-Continuation on Manual Bulk Acceptance (`ACCEPT_ALL_EDITS`):**
  - When a user manually accepts a batch of edits via `ACCEPT_ALL_EDITS`, the host checks whether an active plan is underway. If more tasks remain (no `walkthrough` emitted), it automatically schedules a continuation turn to implement the next step without requiring a manual user nudge.
- **State Tracking, Plan Checklist Reconciliation & Premature Completion Guard:**
  - **Structured Plan Checklists:** System instructions require all plans to format tasks with structured checklist items (`- [ ] [task_name] path/to/file`).
  - **Execution Checklist Reconciliation:** In multi-step continuation turns, the model is instructed to maintain checklist awareness, check off completed tasks (`- [x]`), and verify that all planned file modifications have been executed before declaring completion.
  - **Premature Walkthrough Prohibition:** Models are strictly forbidden from emitting the ````walkthrough```` block while any checklist items or planned file modifications remain unexecuted.

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
│   │   ├── commandRunner.ts        # Child-process execution + output channel streaming + timeout safety (§14)
│   │   └── terminalOutputTracker.ts # Exit status tracking, secret sanitization & prompt context injection (§14)
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
- "Clarify" aspect quoting: ability to select or quote aspects of agent output directly into context for follow-up clarification
  - **Attachment Chip Representation:** Quoting an assistant response (via the message-header `Clarify` button or the floating `Clarify Selection` toolbar on highlighted text) attaches a compact chip to the attachment preview bar above the input field instead of injecting raw text or Markdown into the textarea.
  - **Sequential Numbering & Dynamic Re-indexing:** Quote chips are numbered sequentially starting at 1 (`Quote 1: "<snippet>..."`, `Quote 2: "<snippet>..."`, etc.). If an intermediate quote is deleted via its `✕` button, the remaining chips automatically re-index dynamically (e.g. `Quote 3` becomes `Quote 2`), ensuring zero numbering gaps and allowing users to address specific quotes directly in their prompt by label (`Quote 1: ...`) or number (`1. ...`).
  - **Scoped Selection Lifecycle:** The floating selection toolbar specifically binds to assistant messages within `#messages-container` while `view-chat` is active, avoiding cross-view toolbar leaks or non-rendering bugs.
  - **Clean Typing Experience:** The input textarea remains clean, unobstructed, and focused, omitting any mandatory `"Can you clarify: "` boilerplate so users can ask specific questions, challenge assumptions, or answer numbered questions freely.
  - **Smart Fallback on Empty Input:** If a user attaches one or more quote chips and sends without typing custom text, the system automatically appends a natural fallback query (`Can you clarify this?`, or `Can you clarify these points?` if multiple quotes exist) directly into the outgoing payload sent to the model.
  - **Multi-Quote Stacking & Deduplication:** Supports highlighting and attaching multiple distinct excerpts across the conversation. Exact duplicate quotes are automatically detected and ignored.
  - **Hover Behavior:** Chips truncate smoothly with an ellipsis without showing distracting hover tooltips.
  - **Grounding in Chat History:** Dispatched quotes are assembled into Markdown blockquotes (`> [line]`) prepended to the user's prompt, preserving explicit conversational grounding and sequential 1-to-1 order for the model and subsequent chat turns.
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
  - When there are 2 or more pending edits ($\ge 2$), displays "Apply All" and "Reject All" bulk action buttons.
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
- Token usage logging (SQLite / local JSON store), cost computation from pricing data
- Terminal command audit logging into the same store (cost: 0, tokens: 0)
- Usage Report view: 4 summary cards (Today, This Week, This Month, Total Cost) with reactive filtering, cascading project/model filters, auto-selected workspace default, table pagination (100 rows + "Show more"), filtered CSV export with live count, and pinned header architecture
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
- At minimum: a direct link from Settings to OpenRouter's own data-policy documentation (`https://openrouter.ai/privacy`), so the extension isn't making privacy claims on providers' behalf that it can't independently confirm.

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
- **Planning-skip exceptions (no user override required):**
  - **Trivial single-file edits:** typo fixes, simple renames, one-line bug fixes.
  - **Documentation and text file tasks:** creating or updating any `.md`, `.txt`, `.rst`, or similar non-executable file — READMEs, PRDs, changelogs, notes, specifications. These carry zero execution risk and no workspace side effects. The Implementation Plan → Proceed → Walkthrough lifecycle must never trigger for these tasks regardless of how the request is phrased (e.g. "generate a PRD", "write specs", "draft a README").
  - **Explicit single-file creation:** any task where the user has specified both *what* to write and *where*, leaving nothing ambiguous to resolve before acting.
- **Planning trigger threshold:** The plan → proceed → walkthrough lifecycle activates only when a task modifies **2 or more interrelated code files**, or involves breaking architectural changes, schema migrations, or package replacements. This threshold is fixed — individual models routed through the extension must not drift below it based on keyword matching (e.g. "PRD", "specifications", "architecture") without meeting the file-count or destructiveness criteria.

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


## Phase 10 — Reviewer Model Settings Configuration

**Goal:** Establish the configuration and settings layer for a dedicated Reviewer Model. This phase encompasses Settings panel controls, per-workspace state isolation, and configuration persistence. It prepares the system for the upcoming Two-Tier Reviewer Model workflow.

> [!NOTE]
> **Out of Scope for Phase 10:** The actual review flow mechanics (the Proceed vs. Review choice in the chat thread, sending plan/walkthrough documents to the reviewer model, and thread/comment-based feedback via VS Code's native Comments API) are a separate, subsequent phase and are NOT part of this configuration feature.

### 10.1 Per-Workspace Scoping & Isolation
- Consistent with other project-sensitive data in this extension (Usage Report per-project filtering, shadow-git checkpoints, chat history, and permissions):
  - All Reviewer Model settings are strictly **scoped per-workspace** using VS Code's `ConfigurationTarget.Workspace` / `workspaceState`.
  - Opening a different workspace displays that workspace's own configuration (off by default, or whatever was specifically saved for that project). Settings never leak or bleed across projects.

### 10.2 Master Toggle (Feature Gate)
- **Setting:** `openrouter.reviewer.enabled` (Boolean, default `false`).
- **Behavior:**
  - **OFF (default):** The reviewer model combobox selector, reasoning-effort control, and system prompt text area are completely hidden from the Settings UI (not merely greyed out or disabled).
  - **ON:** The model combobox selector, reasoning-effort control, and prompt text area become visible for configuration.
  - If the user turns the toggle ON without having chosen a model, an inline prompt/warning reminds them to pick a reviewer model for the workspace.

### 10.3 Reviewer Model & Reasoning Effort Selection
- **Searchable Combobox:** Reuses the model selector combobox component (§3.3), allowing real-time filtering, context-length indicators, and ZDR privacy badges.
- **Model Independence:** Fully independent of the primary chat model. The user may configure a different model (e.g. an analytical or reasoning model), the same model, or a model at a different reasoning-effort tier.
- **Side-by-Side Row Layout (`.reviewer-model-row`):** The Reviewer Model combobox and Reasoning Effort dropdown are positioned horizontally on the exact same row, saving vertical space and maintaining visual balance in the settings panel.
- **Smart Conditional Visibility:** The Reasoning Effort dropdown only renders inline beside the combobox when the selected reviewer model actually supports reasoning effort (`supportsReasoningEffort`, e.g. `o1`, `o3`, `deepseek-r1`). For standard or non-reasoning models, the reasoning effort dropdown is completely hidden from the DOM and the model combobox smoothly expands to 100% full width.

### 10.4 Editable Reviewer System Prompt
- **Text Area:** Multi-line text area showing the active reviewer system prompt for the workspace.
- **Default Prompt:** Pre-filled with a strict, comprehensive default instructing the reviewer to critique correctness, logic bugs, completeness, unhandled edge cases, security vulnerabilities, and architectural regression risks.
- **Reset to Default Action:** A "Reset to Default" button restores the built-in default system prompt for the current workspace only, without altering any other workspace's saved reviewer prompt.

### 10.5 Pinned Context File (Strictly Per-Workspace)
- **Setting:** `openrouter.reviewer.pinnedContextFile` (String, default `""`, workspace-scoped).
- **Behavior:**
  - Displays a text input showing the workspace-relative path (e.g., `docs/spec.md`) and a **"Browse..."** button.
  - Clicking **"Browse..."** opens VS Code's native file picker (`canSelectFiles: true, canSelectFolders: false`) restricted to the workspace root.
  - Path traversal checks: paths resolving outside the active workspace folder (`..`, absolute external paths) are blocked and warned against.
  - A **"Clear"** button allows instantly removing the pinned file setting.
  - **Preserved on Context Reset:** Resetting reviewer context (`🔄`) clears conversation turns but strictly preserves the configured pinned context file for subsequent reviews.

### 10.6 Live Mid-Session Updates
- In accordance with the live mid-session update principle established for permissions (§4.1), updates to any of these settings (toggle, model/effort, system prompt, pinned context file) take effect immediately without requiring a window or extension reload, even if a conversation is actively open.


## Phase 11 — Reviewer Model Review Flow

**Goal:** Implement the end-to-end review flow enabling a dedicated, workspace-configured Reviewer Model to critique implementation plans before execution and verification walkthroughs after completion, operating through a dedicated full-view conversation panel with native VS Code Comments API support and selective feedback return to the main model.

This phase directly builds upon two foundational prerequisites:
1. **Two-Tier Plan/Walkthrough Artifact Architecture:** Detailed plans and verification walkthroughs generated as standalone Markdown documents with byte-for-byte fidelity stored in `HistoryStore` (`planDocument` and `walkthroughDocument`).
2. **Reviewer Model Settings Configuration (Phase 10):** Per-workspace master toggle (`openrouter.reviewer.enabled`), independent model selection, dynamic reasoning effort, and editable custom reviewer system prompt.

---

### 11.1 Trigger Point & Conditional Visibility
- **Artifact Types Covered:**
  - **Implementation Plans (Pre-Execution):** A **"Review"** action button appears alongside **"Proceed"** and **"View"** on the plan's summary card in the chat stream.
  - **Walkthrough / Results (Post-Execution):** A **"Review"** action button appears alongside **"View"** on the completed walkthrough's summary card (standalone, as there is no "Proceed" action after execution).
- **Workspace Feature Gate:**
  - The "Review" action appears **strictly when Reviewer Model is enabled** for the active workspace (`openrouter.reviewer.enabled === true`).
  - When disabled (`false`, the default), existing chat behavior is completely unchanged — no "Review" option appears anywhere.

---

### 11.2 What Happens on "Review"
- **Byte-for-Byte Fidelity Transmission & Hierarchical Payload:**
  - On clicking "Review", the extension extracts the exact stored `planDocument` or `walkthroughDocument` content and transmits it to the reviewer model.
  - **System Prompt Assembly:**
    1. Primary guide: Configured Reviewer System Prompt (or default expert critique instructions).
    2. Background reference: Pinned Workspace Context file contents (`# Pinned Workspace Context (<filename>):`) if configured.
    3. Subject of evaluation: Document under review (`# Document Under Review (<label>):`).
  - **User Message Presentation:**
    - The visible user turn in the chat thread displays concise intent: `"Review this plan"` (or `"Review this walkthrough"`).
    - The target plan/walkthrough is attached as an interactive visual reference card (`[📄 Plan docs]`).
- **Dedicated Full-View Navigation:**
  - Opens a **separate, full view** (`view-reviewer`) within the webview container.
  - Reuses the identical top-level view navigation pattern already established for Settings (`view-settings`) and Usage Report (`view-usage`) (with clean back/forward navigation to return to `view-chat`), avoiding cluttered split-pane layouts that degrade readability on narrow sidebar configurations.

---

### 11.3 The Reviewer Panel
- **Layout & Structure:**
  - **Header Strip:** Features a `‹ Main Chat` back navigation button, in-panel Reviewer model combobox selector, reasoning-effort control, context reset button (`🔄`), and a dynamic **`📌 Pinned Context:`** indicator pill displaying the workspace-pinned file (with click-to-open editor capability).
  - **In-Chat File & Artifact Reference Cards:** Rather than pinning a bulky preview section at the top of the conversation view, the document under review is embedded directly into the user message turn as an interactive reference card (`.reviewer-file-ref-card`). The card displays the file/artifact name, type badge (`Plan`, `Walkthrough`, or amber `Pinned`), and an `Open in Tab ↗` action that immediately opens the document in an active VS Code editor tab.
  - **Reviewer Conversation Stream:** Dedicated back-and-forth chat conversation thread between the user and the reviewer model. Users can ask clarifying questions, challenge critiques, request deeper security analysis, or explore alternatives.
    - **Header Clarify Affordance:** Assistant messages in the Reviewer stream include a `Clarify` button next to `Copy` to quote the full reviewer response directly into the Reviewer's input bar as a chip.
    - **Reviewer Aspect Quoting & Sequential Numbering:** Users can highlight specific critique sentences and click `💬 Clarify Selection` on the selection toolbar to discuss that specific point without cluttering the input textarea. Chips are numbered sequentially (`Quote 1: ...`, `Quote 2: ...`) with dynamic re-indexing upon removal.
    - **Smart Fallback Precedence:** When a quote is attached in the Reviewer input bar and sent without typed text, the smart fallback query (`Can you clarify this?`) takes precedence over the default artifact review prompt (`Please review these Plan docs.`).
    - **Session Switching Cleanup:** Switching between review sessions, creating a new review session, or clicking reset context automatically cleanses any unsent quote chips in the Reviewer input bar.
  - **Input Bar:** Compact prompt input with an attachment preview bar (`#reviewer-attachment-preview-bar`), Send, and Stop streaming controls dedicated strictly to the reviewer model. Users can attach workspace files or revised plan documents for subsequent review turns.
- **Native Comments API Integration (`vscode.comments.createCommentController`):**
  - Integrates VS Code's native Comments API (`openrouter-reviewer`, label: "OpenRouter Reviewer Comments").
  - Comment threads bind directly to the real `file://` URI generated by `ArtifactDocumentManager.prepareArtifactFile()`.
  - Because artifacts are stored outside the user's workspace git tracking (e.g. in `storageUri/artifacts/` or OS temp), users can create threaded, range-specific inline comments without risk of committing reasoning artifacts to git.

---

### 11.4 Returning Feedback to the Main Model & Dual Selection Actions
- **Strict Architectural Isolation:**
  - The reviewer conversation is **NEVER** sent wholesale or automatically to the main model.
  - The main model maintains **zero visibility** into the reviewer conversation, reviewer model identity, reasoning effort, or prompt instructions.
  - Selection listeners and floating action bars are strictly scoped to their respective active views (`view-chat` vs `view-reviewer`), preventing cross-view toolbar leaks.
- **Dual-Action Reviewer Selection Toolbar:**
  Highlighting or selecting text strictly within any Reviewer assistant response reveals a dual-action toolbar:
  1. `💬 Clarify Selection`: Attaches the highlighted excerpt as a quote chip into the **Reviewer's own input bar** to follow up or challenge the critique.
  2. `↵ Send to Main Model`: Transfers only that selected feedback snippet to the **Main Chat's draft prompt input** and returns to the main chat view.
- **Message Action Button:**
  Clicking `Send to Main Model` on any reviewer message card transfers that entire response to the main chat's draft prompt input.
- **Draft Insertion Without Auto-Send:**
  - Selected feedback lands in the **main chat's draft input field** (`#prompt-input`).
  - It is **NOT** sent automatically. The user remains in total control to inspect, edit, prepend their own context or instructions, or combine multiple feedback snippets before pressing Enter/Send.
- **Seamless Main Conversation Continuation:**
  - Once sent by the user, the prompt is processed as a standard user message in the existing chat session.
  - The primary model responds naturally to the user prompt, with no awareness that the feedback originated from an auxiliary reviewer model.

---

### 11.5 Post-Mortem Follow-Through
- Post-mortem walkthrough reviews follow the exact same selective transfer workflow:
  - If a review of a completed task reveals an overlooked edge case or performance issue, transferring feedback to the main chat initiates a standard follow-up turn.
  - This may naturally trigger a fresh plan → execute → verify cycle in the main chat if the issue warrants a code change.

---

### 11.6 Cost & Usage Logging
- **Distinct Logging Tag:**
  - Every call made to the Reviewer Model is logged in the `UsageStore` with `type: "reviewer"`, strictly separate from `type: "chat_completion"` and `type: "summarization"`.
  - Costs and token counts are never blended into the primary model's totals.
- **Explainability & Model Transparency:**
  - The logged model name explicitly records the reviewer model and active reasoning effort tier: `Model Name (Effort)` (e.g. `anthropic/claude-3.7-sonnet (High)`).
- **Audit Table & Model Filtering:**
  - The Usage Report table renders reviewer entries with a dedicated `🔍 Reviewer` type pill.
  - The existing Model Filter dropdown in the Usage Report includes reviewer models, allowing users to filter and audit reviewer consumption independently.

---

### 11.7 Reviewer Consolidation pass & Stream Outcome Handling (Consolidation Amendment)
- **Item 1: Plan Artifact Conversational Summary Guarantee:**
  - Generating an implementation plan or walkthrough artifact must always produce a short conversational summary sentence in the chat stream alongside the artifact card (e.g. "I have prepared an implementation plan for your review.").
  - Fallback parsing ensures that even if model output contains only the fenced document block, a friendly conversational intro sentence accompanies the artifact notice.
- **Item 2: Unified Shared Chat Input Architecture:**
  - Both main chat and reviewer panels share a single controller factory (`createChatInputController`) ensuring full feature parity: auto-growing textarea, multi-line Shift+Enter handling, image/text attachments with preview chips, and drag-and-drop file upload.
- **Item 3: Three-Way Stream Outcome Handling:**
  - **Outcome 1 (Zero chunks received, then failure):** No message bubble is ever created. Renders a distinct error card with a direct Retry button.
  - **Outcome 2 (Full stream completed successfully):** Normal markdown rendering with enabled `Send to Main Model` action.
  - **Outcome 3 (Partial-then-failed stream):**
    - The partial content received is strictly preserved (never discarded).
    - Visually and structurally marked incomplete with an inline warning badge: `⚠️ Response interrupted — incomplete`.
    - Dedicated `Retry` action replaces the partial turn upon restart.
    - Forwarding to the main model via `Send to Main Model` prepends an explicit `[Note: Reviewer response was interrupted/incomplete]` warning banner to prevent sending cut-off critiques unknowingly.
- **Item 4: Shared Capability Detection & Reasoning Effort Selector:**
  - The reviewer configuration dropdown wires into `detectModelCapabilities()` and dynamic reasoning effort selectors (`low`, `medium`, `high`) matching main chat capabilities.
- **Item 5: Direct Reviewer Access & Independent Reviewer Sessions:**
  - Main header includes a dedicated reviewer button (`#reviewer-toggle-btn`) for standalone review mode.
  - Reviewer maintains its own independent session history stored in `reviewer_sessions.json` with full session lifecycle (new session, switch, rename, delete) without bleeding into main chat history.
  - **Session Continuity & Context Reuse:** Clicking "Review" on a plan/walkthrough card checks if a reviewer session is already active/open for the current artifact context; if one exists, it is reused directly (reopening/focusing `#view-reviewer` with existing history) instead of creating duplicate sessions or re-streaming initial prompts. Only when there is genuinely no active reviewer session (first review action, or after explicitly starting a new session or switching away) is a fresh reviewer session created. Sending follow-up messages within an open reviewer conversation always appends to the current session's history without spawning new sessions.
- **Item 6: Reviewer Context Management & In-Panel Model Switching:**
  - Live token meter in the reviewer strip with warning thresholds.
  - Manual context reset ("Start fresh from here").
  - In-panel model combobox and reasoning selector with drop-with-notice warning banner for multimodal capability mismatches.

---

### 11.8 Copy, Rendering & Drag-and-Drop Hardening (Phase 11 Amendment)
- **Item 1: Reviewer Message & Code Block Copy Buttons:**
  - Standardized reviewer message cards (both user and assistant roles) to include full `.message-header` with `.role-tag` ("You" / "Reviewer") and `.message-header-actions` containing `.msg-copy-btn` for 100% parity with main chat.
  - Reviewer message rendering routes through `renderFormattedContent()`, ensuring that every fenced code block automatically receives its own per-block `.code-block-copy-btn` via `renderCodeBlock()`.
- **Item 2: Streaming Performance & Throttling / Debouncing:**
  - Token-by-token reviewer stream chunks (`handleReviewerStreamChunk`) are throttled via `requestAnimationFrame` and a time-window lock (`REVIEWER_RENDER_THROTTLE_MS = 60ms`) to eliminate continuous DOM clearing and full subtree reconstruction on every token.
  - Both stream completion (`handleReviewerStreamDone`) and stream interruption (`handleReviewerStreamError`) execute an immediate synchronous flush (`flushReviewerStreamRender`) to guarantee zero missing content.
  - Copy button listeners and headers are attached once to the outer message shell, preventing listener accumulation, duplicate fires, or event handler leaks across chunk updates.
- **Item 3: Unterminated Code Fence Streaming Parity:**
  - `renderFormattedContent()` detects partially received / open-ended code fences (`/```([^\r\n]*)\r?\n([\s\S]*)$/`) during active streaming and renders them as live pending code blocks via `renderCodeBlock()`, eliminating raw unformatted fence syntax or flickering layout shifts mid-stream.
- **Item 4: Drop-Zone Signature Safety & Parity:**
  - `createChatInputController({ dropZone?: HTMLElement })` safely preserves default drop handling on `inputBoxWrapper` while binding the dedicated reviewer container (`#view-reviewer`) when configured. Main chat call sites omitting `dropZone` retain their exact pre-amendment drag-and-drop behavior.
- **Item 5: Prompt Fencing Directives & Token Budget:**
  - Updated `src/prompt/systemPrompt.ts` (Tone & Style) and `DEFAULT_REVIEWER_SYSTEM_PROMPT` in `src/settings/configuration.ts` to mandate that copy-intended artifacts, snippets, and commands be enclosed in dedicated fenced code blocks with language tags, separate from conversational commentary.
  - Added token length impact is ~30 tokens on the system prompts, representing less than 0.05% of typical context windows, well within any pinned prompt budget.
- **Item 6: Reviewer Session Continuity & Artifact Context Attachment:**
  - Extended `ChatSession` in `HistoryStore` to track `artifactType`, `artifactMessageId`, and `artifactContent`.
  - When "Review" is clicked while a reviewer session is already open/active (whether from the same or a different plan/walkthrough card), the extension does NOT create a new session and does NOT auto-send.
  - Instead, the artifact document is added to the current session's input box as an attachment chip (reusing `reviewerChatInputController.addAttachment()`), focusing the textarea and allowing the user to optionally type a note (e.g. "check again") before clicking Send explicitly.
  - When the user sends this attachment, the plan/walkthrough content is transmitted as system-role context (never printed as raw markdown in the chat bubble), and the visible user-turn displays only the user's typed note (or clean default instruction), preserving single-session integrity.
  - Retained explicit `NEW_REVIEWER_SESSION` control (+ New Session) as the single intentional mechanism for initiating fresh standalone review sessions.
- **Item 7: First Reviewer User Turn Displays Configured Reviewer System Prompt:**
  - On initial "Review" click for a plan or walkthrough artifact, the visible user turn rendered in the reviewer conversation thread displays the workspace's configured Reviewer System Prompt text (custom or default) rather than a generic placeholder, giving the user direct visibility into the critique instructions.
  - The model request includes this prompt in both system role (with full byte-for-byte artifact document context) and user turn, while the document itself is rendered exclusively in the top Collapsible Artifact Section.

---

### 11.9 Attachment Preview Bar Wrapping, Stacking & Viewport Parity (Phase 11 Amendment)
- **Item 1: Multi-line Wrapping & Stacking (`flex-wrap: wrap`):**
  - Updated `.attachment-preview-bar` with `display: flex; flex-wrap: wrap; gap: 6px 8px; width: 100%; box-sizing: border-box;` in both Main Chat (`#attachment-preview-bar`) and Reviewer Chat (`#reviewer-attachment-preview-bar`).
  - Quote attachment chips, files, and image preview chips now dynamically wrap and stack across lines instead of overflowing horizontally past the right edge of the screen.
- **Item 2: Viewport Constrained Scrolling & Ellipsis Protection:**
  - Added `max-height: 140px; overflow-y: auto; overflow-x: hidden;` with custom compact scrollbars to `.attachment-preview-bar`, allowing numerous quotes (e.g. 4–6 multi-select questions) to stack comfortably while preventing displacement of the input textarea.
  - Enforced `max-width: min(240px, 100%)` and `box-sizing: border-box; flex-shrink: 0;` on `.attachment-chip`, coupled with `min-width: 0; flex: 1 1 auto;` on `.attachment-name` so labels truncate with an ellipsis (`...`) under narrow sidebar conditions while protecting quote icons and remove buttons (`flex-shrink: 0;`).

---

## Phase 12 — Usage Report & Settings Architecture Streamlining

**Goal:** Upgrade the Usage Report audit view with comprehensive multi-dimensional financial tracking (4-card metric grid with Total Cost), real-time reactive filtering, cascading dependent project-model dropdowns, and high-performance table pagination; streamline the in-panel Settings surface by eliminating redundant controls and pinning headers for frictionless navigation.

### 12.1 4-Card Spend Metric Grid & Reactive Filtering
- **Total Cost Metric Card (`#spend-total`):**
  - Added a 4th metric card displaying cumulative lifetime spend alongside Today (`#spend-today`), This Week (`#spend-week`), and This Month (`#spend-month`).
  - Layout: Fluid 4-column responsive grid (`repeat(4, 1fr)`) with an `@media (max-width: 360px)` breakpoint that wraps into an ergonomic 2x2 grid for narrow sidebar configurations.
- **Dynamic Reactive Re-Aggregation:**
  - All 4 spend cards reactively recompute whenever `#filter-project` or `#filter-model` changes.
  - Selecting a specific project or model updates Today, Week, Month, and Total Cost cards to show the exact financial metrics for that slice, rather than static global totals.

### 12.2 Contextual Workspace Filtering & Cascading Dropdowns
- **Auto-Selected Workspace Project Default:**
  - On opening the Usage Report, `#filter-project` automatically detects and selects the active workspace project name.
  - "All Projects" remains available at the top of the dropdown for viewing organization-wide spend.
- **Cascading / Dependent Model Filter:**
  - Selecting a project in `#filter-project` queries the usage dataset and updates the `#filter-model` dropdown options to include only models that were actually invoked within that project.
  - Prevents confusing zero-result states caused by selecting incompatible project/model filter combinations.

### 12.3 Table Pagination & Export Fidelity
- **Audit Table Pagination (100-Row Chunks):**
  - The audit log table renders up to 100 rows initially with a smooth "Show more" button for subsequent 100-row chunks, preventing DOM bloat and UI lag on large audit logs.
- **Full-Dataset CSV Export:**
  - The Export CSV button dynamically updates its label with the total filtered record count (`📥 Export CSV (N)`).
  - Clicking Export writes all records matching the active filters to the CSV file, regardless of visual table pagination limit.

### 12.4 Terminal Command Audit Logging Integrity
- Terminal commands executed via the chat proposal pipeline log directly to `UsageStore` with `cost: 0`, `promptTokens: 0`, `completionTokens: 0`, `totalTokens: 0`, and the active workspace project name.
- Ensures terminal commands appear in audit logs and project usage views without artificially inflating token counters or financial metrics.

### 12.5 Settings Surface Streamlining & Privacy Link
- **Elimination of Redundant Controls:**
  - Removed manual "Panel position" Left/Right segmented buttons and guide box from the Settings view, relying on VS Code's native drag-and-drop view container management.
  - Removed duplicate "Default model" dropdown from Settings, directing users to the primary type-to-search combobox in the chat header.
- **Updated Privacy Policy Link:**
  - Updated the official OpenRouter data policy link in Settings to point to `https://openrouter.ai/privacy`.

### 12.6 Pinned Header Navigation & Scroll Position Resets
- **Fixed Header Architecture (`.settings-header-strip`):**
  - Both `#view-settings` and `#view-usage` utilize a pinned header strip containing back navigation buttons and view titles.
  - Content scrolls inside dedicated containers (`#settings-scroll-body`, `#usage-scroll-body`), ensuring navigation controls are always accessible without scrolling back to top.
- **Scroll Position Reset:**
  - Navigating into Settings or Usage Report automatically resets `scrollTop = 0` on the respective scrollable body for a clean starting view.

### 12.7 Reviewer Model Inline Layout & Smart Visibility
- **Side-by-Side Presentation (`.reviewer-model-row`):**
  - Reviewer Model combobox and Reasoning Effort dropdown sit on the same horizontal row within `#reviewer-config-section`.
- **Smart Conditional Visibility:**
  - Reasoning Effort dropdown renders inline beside the combobox only when the selected model supports reasoning (`supportsReasoningEffort`).
  - For standard models, the reasoning effort dropdown collapses completely, and the model selector expands to 100% width.

---

## Phase 13 — Planning Artifact Lifecycle, Reviewer Integration & File Automation UX

**Goal:** Establish end-to-end reliability for implementation plans and verification walkthroughs across all planning phrasings (including generic "plan only"), guarantee immediate disk persistence of reasoning artifacts, make the Review action unconditionally active on all artifact cards with graceful model fallbacks, and deliver seamless in-editor file handling through auto-saving, auto-opening of newly created files, and interactive clickable file paths.

### 13.1 Generic Plan Request Handling & Multi-Tier Code Fence Aliases
- **Universal Trigger for Planning Requests:**
  - The assistant responds to ANY user phrasing requesting a plan (including `"plan"`, `"plan only"`, `"make a plan"`, `"plan this"`, `"create a plan"`, `"implementation plan"`, or `"plan out..."`) by always outputting a standalone plan document inside an artifact code fence.
  - Eliminated the restriction that suppressed plan blocks on fewer than 3 files when the user explicitly requested planning.
- **Code Fence Tag Aliases (`findTopLevelFence`):**
  - Broadened regex matching to accept:
    - Plans: ````plan````, ````implementation_plan````, ````implementation-plan````, ````implementationplan````, ````plan_document````, ````plan_docs````.
    - Walkthroughs: ````walkthrough````, ````results````, ````result````, ````result_walkthrough````, ````verification_walkthrough````, ````walkthrough_document````.
- **Resilient Fallback for Unfenced Model Responses:**
  - If a model (particularly lower-tier or open-weights models) outputs a plan without markdown code fences, `extractArtifacts` detects top-level markdown headings (`# Implementation Plan`, `# Plan`, `## Implementation Plan`), extracts the plan document with byte-for-byte fidelity, and injects the `📄 Plan docs ready — [view]` notice card into the chat summary.
  - The same resilient fallback applies for walkthrough documents (`# Walkthrough`, `# Verification & Walkthrough`, `# Results`).

### 13.2 Conversational Confirmation & Steerability Directives
- **Model Confirmation Prompting:**
  - Outside the ````plan```` block, the assistant outputs a 1–2 sentence conversational summary explicitly asking whether the user would like to proceed with the proposed plan, review it, or make adjustments first (e.g. *"I have prepared an implementation plan for creating the notepad app. Would you like me to proceed with this plan, or would you like to review or make adjustments first?"*).
  - When analyzing new complex requests, the model can also ask if a plan should be created first or if it should proceed directly.

### 13.3 Immediate Artifact Disk Persistence
- **Proactive Document Generation:**
  - In `panelProvider.ts` upon message completion stream finish (`onDone`), `ArtifactDocumentManager.prepareArtifactFile` is immediately executed for any extracted `planDocument` or `walkthroughDocument`.
  - Guarantees the markdown artifact file (`implementation_plan_<id>.md` or `walkthrough_<id>.md`) is immediately created and saved in the extension's workspace storage directory (`storageUri/artifacts/`) without requiring the user to click "View" or "Review" first.

### 13.4 Unconditionally Active Review Button & Active Model Fallback
- **Universal Review Action on Artifact Cards:**
  - The **Review** button (`.chat-artifact-review-btn`) is unconditionally active and visible on all artifact cards:
    - On **Plan docs** cards: View, Proceed, Review buttons are all available.
    - On **Results docs** / Walkthrough cards: View, Review buttons are both available.
  - Removed the `if (isReviewerEnabled)` UI gate that previously hid the button when workspace reviewer setting was false.
- **Reviewer Model Fallback:**
  - Clicking "Review" when no specific Reviewer Model has been configured in workspace settings automatically falls back to `Configuration.getLastModel()` (the currently selected chat model) or the first available model, allowing reviews to start immediately without presenting an error toast or blocking workflow.

### 13.5 File Creation Auto-Open, Auto-Save & Interactive Navigation
- **Automatic Document Saving (`applyEdit`):**
  - Applying an edit or new file immediately executes `await doc.save()`, eliminating unsaved/dirty buffer states and keeping files in sync with disk.
- **Auto-Open Newly Created Files:**
  - Newly created files via `create_file` automatically open in an editor tab with `{ preview: true, preserveFocus: true }`. Developers immediately see the new file's content, location, and syntax highlighting without losing keyboard focus in the chat input.
- **Single Edit Focus:**
  - When manually applying a single edit via the "Apply" button on a proposed edit card, the file is opened/brought into view with `{ preview: true, preserveFocus: true }`.
  - Batch edits (`Apply All` or multi-file auto-execution) suppress bulk tab opening to prevent tab explosion while ensuring all files are saved to disk.
- **Interactive Clickable File Paths in Chat UI:**
  - Proposed file paths in the diff card headers and pending edit rows are clickable (`OPEN_FILE`), enabling one-click opening of any referenced file at any time.

---

## Phase 14 — Reliable Child-Process Terminal Execution, Output Capture & Exit Status Feedback

**Goal:** Replace the fire-and-forget, shell-integration-dependent terminal execution mechanism with a dedicated Node.js `child_process.spawn` execution engine. This guarantees immediate and reliable capture of stdout, stderr, process exit codes (status), timeout safety, and real-time output channel streaming, while delivering live execution feedback, completion badges, and expandable output viewers in the webview chat interface and subsequent model prompt context.

### 14.1 Problem Statement & Architectural Motivation
- **Fire-and-Forget Limitation:** Previously, commands routed through VS Code's integrated terminal shell integration (`terminal.shellIntegration.executeCommand`) or `terminal.sendText()`. On newly created terminals, `shellIntegration` was almost always `undefined`, forcing an immediate fallback to `terminal.sendText()`.
- **Zero API Status Capture:** `terminal.sendText()` simply injects keystrokes into the pty without any API in VS Code to capture stdout, stderr, or process exit codes.
- **Immediate Return with Incomplete Status:** `executeCommand` returned synchronously within 1ms as `executed: true` before the command even started running, causing auto-run and UI buttons to falsely claim completion before any output existed.
- **Context Blindness:** The model could not determine whether a build, lint, or test command actually succeeded or failed with an error, preventing true autonomous verification loops.

### 14.2 Child Process Execution Engine (`CommandRunner`)
- **Direct Child Process Spawning:** Commands execute directly via Node's `child_process.spawn(command, { cwd, shell: true, windowsHide: true, env: process.env })`.
  - Supports Windows (PowerShell/cmd), macOS, and Linux seamlessly.
  - Automatically verifies cwd existence on disk, falling back to `process.cwd()` to prevent `ENOENT` spawn crashes when workspace paths are unmounted or mocked.
- **Live Output Streaming (`vscode.OutputChannel`):**
  - Live stdout and stderr chunks stream in real time to a dedicated `OpenRouter: Terminal` output channel.
  - Developers can open the Output panel in VS Code to watch live builds, installations, and test execution as they run.
- **Timeout Safety & Process-Tree Termination:**
  - Configurable 60-second default execution timeout prevents forgotten or hanging processes from running indefinitely.
  - On timeout or abort, cleanly terminates the entire process tree using `taskkill /pid <PID> /T /F` on Windows or `SIGKILL` on Unix to eliminate orphaned background zombie processes.
- **Memory Buffer Protection:** Stdout and stderr memory accumulation is capped at 512 KB to avoid memory leaks on excessively verbose commands.
- **Interactive Terminal Fallback:** Preserves an optional fallback flag (`interactiveInTerminal: true`) and UI button (`Integrated Terminal`) for commands that inherently require user stdin interaction (e.g. interactive setup wizards, pagers, or dev servers).

### 14.3 Output & Exit Status Tracking (`TerminalOutputTracker`)
- **Structured Result Recording (`recordExecutionResult`):**
  - Records completed executions with `command`, `cwd`, `exitCode: number | null`, `status: 'success' | 'failed' | 'timed_out'`, and sanitized output.
  - Secret redaction (`SecretScanner.redact`) is applied to the combined raw stdout/stderr before storage or context injection.
- **Prompt Context Status Injection:**
  - In `getRecentOutputsFormatted()`, recent terminal executions injected into the assistant's context are explicitly formatted with exit status headers:
    ```
    [Command executed at 2026-09-19T22:00:00.000Z]
    $ npm test
    [Exit code: 0 (Success)]
    <output>
    ```
    or `[Exit code: 1 (Failed)]` / `[Timed out (Process killed after 60s)]`.
  - The model immediately knows whether its proposed commands succeeded or failed, enabling true autonomous verification loops.

### 14.4 Webview UI Feedback & Terminal Result Cards
- **Dual-Action Terminal Cards:**
  - Primary button: `▶ Run Command` (executes via child process, captures output and status).
  - Secondary button: `Integrated Terminal` (launches in standard interactive VS Code terminal).
- **Live Execution Feedback:**
  - Clicking `▶ Run Command` disables the button and displays a live `⏳ Running...` state.
  - Host broadcasts `TERMINAL_RUNNING` and `TERMINAL_RESULT` messages across the webview protocol.
- **Status Badges & Expandable Output Accordion:**
  - Upon completion, the card updates with a distinct status badge:
    - `✓ Completed (Exit Code: 0)` in green.
    - `✗ Failed (Exit Code: N)` in red.
    - `⏰ Timed out after 60s (Process killed)` in warning amber.
    - `⚠️ Cancelled by user` if blocked by permission.
  - A collapsible `<details>` section displays the captured, sanitized output (`View Output (N chars)`) in a styled monospace box.
  - Allows re-running via `↻ Re-run`.
- **Auto-Execution Chat Summaries:**
  - When `runTerminalCommand === 'allow'`, auto-executed commands post an enriched summary message into chat with the exact exit code and a formatted code snippet of the stdout/stderr output.

---

## Phase 15 — Reviewer In-Chat Workspace File Referencing & Multi-Turn System Prompt Inheritance

**Goal:** Eliminate bulky, pinned artifact preview UI from the top of the Reviewer view, embed all reviewed files and artifacts directly within conversation message turns as interactive, clickable cards that open in VS Code editor tabs, support reviewing additional workspace files or revised plans as distinct conversation turns, and strictly preserve the Reviewer Model System Prompt across all multi-turn review interactions.

### 15.1 Elimination of Pinned Artifact Preview Section
- **Problem Statement:** The pinned preview container (`#reviewer-artifact-section`) consumed significant vertical space at the top of the Reviewer view, displaying raw document text, collapse toggles, and duplicate buttons that constrained conversation thread readability.
- **Resolution:**
  - `#reviewer-artifact-section` is marked with `display: none !important;` in `style.css` and given the `.hidden` class in DOM templates.
  - The Reviewer conversation thread expands to occupy 100% of the available panel height, delivering a clean, uncluttered chat layout.

### 15.2 In-Chat Clickable File & Artifact Reference Cards
- **Message Turn Card Embedding:**
  - When a review starts or when a user attaches an artifact or workspace file, an interactive `.reviewer-file-ref-card` is rendered directly inside the message body of that turn.
  - **Visual Elements:**
    - Document SVG icon (`📄`).
    - File/artifact name (e.g. `Plan docs`, `Results docs`, or `src/auth.ts`).
    - Distinction badge (`Plan`, `Walkthrough`, or `File`).
    - Interactive `Open in Tab ↗` action button (`.reviewer-file-ref-open-btn`).
- **One-Click VS Code Tab Opening:**
  - Clicking the card or the `Open in Tab` button dispatches `OPEN_FILE` across the webview protocol.
  - The host handler in `panelProvider.ts` resolves `file://` URIs, absolute disk paths, and workspace-relative paths, opening the file directly via `vscode.workspace.openTextDocument()` and `vscode.window.showTextDocument()` with `preview: false` (permanent independent tab) and preserved focus.

### 15.3 Multi-Turn File Reviews as Separate Turns
- **Attaching Additional Files in Active Sessions:**
  - Users can attach new files or revised plans into the Reviewer chat input via the document upload button, file drag-and-drop, or subsequent "Review with Reviewer" button clicks in the main chat.
  - Files appear as preview chips in the Reviewer attachment bar (`#reviewer-attachment-preview-bar`).
- **Discrete Turn Separation:**
  - Submitting a message attaches the file reference to that specific turn.
  - The user's typed prompt is displayed alongside the interactive reference card without dumping voluminous raw file content as text into the chat bubble.
  - Each review turn operates as a separate evaluation milestone in the ongoing thread.

### 15.4 Strict Reviewer System Prompt Inheritance Across Turns
- **Architectural Guarantee:**
  - Every review turn continues to inherit the workspace's configured Reviewer System Prompt (critique criteria, security audits, architecture logic, and edge-case requirements).
  - When streaming completions (`_streamReviewerResponse`), the effective system prompt combines the base instructions with the active document under review:
    ```
    <Reviewer System Prompt>

    # Document Under Review (<FileName>):
    <File Content>
    ```
  - The conversation history (including previous reviewer critiques and user follow-ups) is passed alongside the current turn prompt, ensuring the reviewer maintains full conversational context while evaluating the newly submitted file against the comprehensive reviewer standard.

---

## Phase 16: Smart Autoscroll & Scroll-Fighting Elimination

### 16.1 Context & Problem Definition
When the Main Model or Reviewer is generating responses, incoming chunks and periodic re-renders update the chat DOM at high frequencies (up to 50+ times per second). Previously, each chunk unconditionally set `container.scrollTop = container.scrollHeight`. This caused severe "scroll fighting", snapping the scroll view to the bottom whenever the user attempted to scroll up to inspect previous answers, verify code snippets, or compare instructions during an active stream.

### 16.2 Smart Scroll Controller Architecture
- **Proximity & Intent Detection (`SmartScrollController`):**
  - Uses a proximity threshold (60px) to determine whether the user is actively viewing the latest stream tokens (`scrollHeight - scrollTop - clientHeight <= 60`).
  - Listens to `wheel` events (`deltaY < 0`) for instant recognition of upward intent before browser inertia finishes.
  - Listens to `scroll` and `touchmove` events for continuous tracking.
- **Selective Autoscroll:**
  - `scrollToBottomIfAtBottom()`: Only applies `scrollTop = scrollHeight` if `userScrolledUp === false`. If the user has scrolled up, incoming chunks render in the DOM without altering the scroll offset, allowing uninterrupted reading.
  - When the user scrolls back to within 60px of the bottom, autoscroll automatically re-engages for subsequent tokens.
- **Forced Snapping on Intentional Actions:**
  - `scrollToBottom(force = true)`: Resets `userScrolledUp = false` and jumps immediately to the bottom when the user submits a new prompt, switches chat sessions, or clicks the floating jump-to-bottom button.

### 16.3 Floating Jump-to-Bottom Indicator
- Both the Main Chat and Reviewer chat containers include a discreet, circular floating button (`.scroll-bottom-btn`).
- The button smoothly appears when the user is scrolled away from the bottom during generation or history review.
- Clicking the button instantly animates/scrolls the viewport to the latest message and re-engages autoscroll.
- **Scoping & Positioning Invariant:** The floating button is placed strictly inside the messages feed container (`position: relative; flex: 1; min-height: 0;`), positioned `bottom: 12px; right: 16px;`. This guarantees that the button floats above the messages viewport without bleeding down into or overlapping the input box, attachments bar, or footer strip across both Main Chat and Reviewer views.

---

## Phase 17: Independent Editor Tab Management

### 17.1 Context & Problem Definition
In standard VS Code / Antigravity IDE behavior, files opened with `{ preview: true }` or single-clicked in the explorer open in "Preview Mode" (indicated by italic tab titles). When in Preview Mode, opening any subsequent file replaces the existing tab on screen instead of opening alongside it in a new tab.

### 17.2 Extension Tab Invariants
To guarantee that user work and AI operations never overwrite active editor tabs:
- **Explicit `preview: false` Enforcement:**
  - All host calls to `vscode.window.showTextDocument()` across the extension explicitly configure `{ preview: false }`:
    - Newly created files after applied edits (`diffPreview.ts`).
    - Open-in-tab actions from main chat or file cards (`panelProvider.ts`).
    - Artifact document reviews such as Plans and Walkthroughs (`artifactDocumentManager.ts`).
- **Workbench Setting Alignment:**
  - Users seeking global single-click independent tab behavior across VS Code Explorer and Quick Open configure:
    ```json
    "workbench.editor.enablePreview": false,
    "workbench.editor.enablePreviewFromQuickOpen": false
    ```

---

## Phase 18: Prompt Fence Disambiguation & Robust EOF Append Resolution

### 18.1 Context & Root Cause Analysis
When users asked the AI to append comments or sections to documents (e.g. `please append a comment "thank you" to PRD.md`), two interacting failure modes caused the edit to fail with *"The AI's proposed edit no longer matches this file's current content"*:
1. **Prompt Wrapper Collisions on Markdown Files:**
   - Injected active file buffers and referenced workspace files were previously delimited using triple backticks (```` ```markdown\n<content>\n``` ````).
   - The LLM mistook the system prompt's closing triple backticks as the actual final line of the document and emitted ````<<<< SEARCH\n```\n====\n```\n\nthank you\n>>>>````.
   - Because the real target file on disk did not contain trailing triple backticks, the search match failed.
2. **Accidental Inner Fence Enclosure:**
   - LLMs frequently wrap search or replace blocks in accidental internal code fences (e.g. ````<<<< SEARCH\n```ts\n...\n```\n====\n```ts\n...\n```\n>>>>````).

### 18.2 Architectural Resolutions
- **XML Tag Boundary Isolation (`systemPrompt.ts`):**
  - Active editor file contents and referenced workspace files are enclosed in structured XML boundary tags (`<file_content file="...">` ... `</file_content>`), completely eliminating closing triple backtick collisions at the end of injected files.
  - Prompt instructions explicitly clarify that XML tags are prompt boundaries and show clear anchor patterns for appending to files.
- **Accidental Search Block Fence Unwrapping (`diffPreview.ts`):**
  - `resolveProposedContent` detects and unwraps outer code fence wrappers (`^```...\n([\s\S]*?)\n```$`) from `searchBlock` in addition to `replaceBlock`.
- **EOF Append Fallback (`diffPreview.ts`):**
  - If a model proposes `searchBlock.trim() === '```'` or ````'```markdown'```` on a file that does not contain triple backticks, the diff preview engine recognizes the EOF append intent, strips any accidental code fences from `replaceBlock`, and safely appends the addition to the end of the file.

---

## Phase 19: Response Execution Duration & Generation Latency Metrics

### 19.1 Context & Problem Definition
Developers interact with various LLMs (from lightweight instruction models to deep reasoning models like `o1`/`o3-mini`) with varying latency profiles. Previously, users had no visibility into how long a generation took once complete. To provide transparency and performance feedback, the extension displays the execution duration for every assistant response across both the Main Chat and Reviewer panels.

### 19.2 Timing & Host-Side Measurement Architecture
- **Host-Side Precision Timing:**
  - Measurement begins immediately when the chat completion stream request is dispatched to OpenRouter (`streamStartTime` in Main Chat, `reviewerStartTime` in Reviewer).
  - Measurement concludes when the stream finishes emitting tokens (`MESSAGE_STREAM_DONE` / `REVIEWER_STREAM_DONE`).
  - Total elapsed duration is computed in milliseconds (`Date.now() - startTime`).
- **Persistence Across Sessions & Reloads:**
  - Stored on `StoredChatMessage.executionDurationMs` in `HistoryStore` (for main chat) and `_historyStore.appendReviewerMessage` (for reviewer history).
  - Maintained across session switches (`SWITCH_SESSION`, `SWITCH_REVIEWER_SESSION`, `_loadChatHistory`, `OPEN_REVIEWER_VIEW`), guaranteeing that historical conversation turns retain their generation duration badges upon reload.

### 19.3 Visual Presentation & Formatting Specifications
- **Formatting Rules:**
  - **Sub-Minute Durations (< 60s):** Formatted with **exactly one decimal place** (e.g. `0.5s`, `14.2s`, `59.9s`).
  - **Minute-Scale Durations (≥ 60s):** Formatted in minutes and integer seconds (e.g. `1m 0s`, `1m 24s`, `2m 5s`).
  - Rounding boundaries: Values rounding up to a minute boundary (e.g. `59.96s`) transition cleanly to `1m 0s`.
  - Non-positive or missing durations: Gracefully omitted without rendering empty badges.
- **UI Placement & Aesthetics:**
  - **Location Invariant:** Rendered inside `.message-header-actions` directly **preceding** the Clarify button (`.msg-quote-btn`).
  - Order in header actions: `[Duration Badge]` → `[Clarify Button]` → `[Copy Button]`.
  - Styled with `.msg-duration-badge`:
    - Monospace font (`var(--vscode-editor-font-family)`), muted color (`#8b949e`), 10px text, inline clock/stopwatch SVG icon, and hover opacity transition.
    - Tooltip displays descriptive title: `Generation time: <formatted duration>`.
  - Synchronized across both live streaming completion and historical message replay in both Main Chat and Reviewer panels.

---

## Phase 20: Large File Context Management & Non-Truncating Batch Processing

### 20.1 Context & Problem Definition
Previously, workspace files read by `contextReader.ts` were arbitrarily capped at a hardcoded 25,000 character limit. For large source files or specifications exceeding this cap, the tail was silently or crudely truncated with `[... truncated]`. Truncation prevented models from viewing critical EOF structures, schema declarations, or appending updates to the end of documents without error.

### 20.2 Non-Truncating Batch Chunk Architecture (`chunkManager.ts`)
- **Zero-Data-Loss Processing:**
  - Eliminates blind 25k character truncation. Files are read completely from disk or active editor buffers.
- **Syntactic Line-Preserving Chunking:**
  - Files exceeding the configured or model-available context window are partitioned by `ChunkManager` into structured batches using natural line boundaries (`\n`) rather than slicing arbitrary byte/character offsets.
- **Context Allocation & Token Headroom:**
  - Calculates chunk sizes based on model context limits (with safe headroom for system prompts and conversational turns).
  - Batches include structured chunk envelope headers:
    ```markdown
    [Chunk 1 of 3: lines 1-450 of 1200]
    ```
- **Context Injection & Prompt Grounding:**
  - Integrates seamlessly with Phase 18 XML isolation tags (`<file_content file="...">`).
  - Provides clear model directives allowing the LLM to inspect, reference, and target specific line ranges without context corruption.

---

## Phase 21: Multi-Turn Reviewer Artifact Context Injection & Attachment Turn Grounding

### 21.1 Context & Problem Definition
In the Dedicated Reviewer Panel (Phase 11), users frequently iterate on implementation plans and walkthrough verification documents across multiple conversational turns:
1. Turn 1: Reviewer critiques the initial document and produces specific actionable items (e.g. key lifecycle, durability tests, autosave semantics).
2. Follow-up Turn: The user addresses these items in the main chat, produces an updated document (`Plan docs` or `Results docs`), and attaches the new artifact to the active reviewer session with a prompt like `"review this new one"` or `"please review"`.

Previously, attaching a revised document in a follow-up reviewer message only mutated the session's system-role context at index 0 (`role: 'system'`), while the conversational user message (`role: 'user'`) was dispatched with only the user's brief text note (e.g. `"review this new one"`). Because LLMs in multi-turn dialogues perceive system messages as static initial configuration set at session launch and inspect the latest user message for referenced entities, models routinely reported failure:
> *"It looks like the new document didn't come through — I only see your request, not the updated plan. Please paste the revised implementation plan..."*

### 21.2 Architectural Resolutions & Invariants

- **Strict Separation Between UI Presentation and Model Payload:**
  - **Chat Bubble Presentation Invariant:** In `HistoryStore` and the webview UI, the user message bubble maintains clean readability. `StoredChatMessage.content` preserves only the concise user note (e.g. `"review this new one"`), while attachment metadata (`name`, `uri`, `artifactType`, `content`) is stored inside `AttachedFileRef`. The visual badge card (`[📄 Plan docs] [PLAN] [Open in Tab]`) is rendered cleanly without flooding chat bubbles with raw markdown.
  - **Outgoing Conversational Turn Grounding:** When `_streamReviewerResponse` in `panelProvider.ts` maps `this._reviewerHistory` to the API `messages` payload for `OpenRouterClient.sendChatCompletionStream`, any user turn containing an attached file or artifact is dynamically augmented:
    ```markdown
    ${m.content}

    ---
    # Attached Document Under Review (${docLabel}):
    ${m.attachedFile.content}
    ---
    ```
- **System-Role & Turn-Role Dual Context:**
  - The system prompt continues to maintain `# Document Under Review` for baseline role grounding.
  - The latest conversational turn contains the exact revised document alongside the user's critique instruction, enabling the LLM to directly compare previous critique points against the newly attached revision.
- **Session Continuity & Persistence:**
  - `AttachedFileRef` in `messages.ts` explicitly includes optional `content?: string`.
  - Serialized within `HistoryStore.reviewerSessions`, guaranteeing that session switches (`SWITCH_REVIEWER_SESSION`) and retries (`RETRY_REVIEWER_MESSAGE`) retain document context across app restarts without requiring file re-reads from disk.

---

## Phase 22: Persistent Execution State, Process Tree Cancellation, & Workspace Analysis First

### 22.1 Context & Problem Definition
During multi-step implementation tasks, terminal executions, and file operations, users experienced several friction points:
1. The Send/Stop button would prematurely flip back to Send during active terminal or file operations, making the extension appear frozen without visual cues.
2. Clicking the Stop button failed to kill background child process trees, leaving orphaned processes running.
3. Chat logs showed duplicate terminal output bubbles when commands executed automatically in `allow` mode.
4. When given complex multi-file tasks or reviewer feedback, models prematurely refused to act, claiming *"the extension only injected file paths, not actual contents"*, rather than analyzing the codebase.

### 22.2 Process Tree Cancellation via `AbortSignal`
- **Full Process-Tree Cleanup:**
  - `CommandRunner.executeCommand` accepts an optional `AbortSignal`.
  - When the user cancels execution (by clicking the red Stop button), the signal fires and kills the entire spawned process tree:
    - Windows: `taskkill /pid <PID> /T /F`
    - POSIX / Unix: `child.kill('SIGKILL')`
  - Returns `{ cancelled: true }` cleanly without leaving lingering background processes or locked files.

### 22.3 Workspace Analysis First Directive & Multi-File Context Injection
- **Multi-File Auto-Discovery:**
  - At send-time, the extension scans the prompt, attached reviewer feedback, and workspace file list to discover all explicitly referenced files (`recovery_screen.dart`, `main.dart`, `failure_taxonomy.dart`, `pubspec.yaml`).
  - Pre-reads all discovered files up to token limits and injects live `<file_content>` XML blocks into the prompt context.
- **System Prompt Directive:**
  - Added **Workspace Analysis First (CRITICAL)** in Phase 1 of `systemPrompt.ts`.
  - Strictly prohibits models from complaining about missing file contents or asking the user to manually open files when workspace inspection tools and terminal commands (`type <path>`, `cat <path>`) are available.

---

## Phase 23: Live Streaming Activity Visibility, Reasoning Token Streaming, & Intelligent Activity Timeouts

### 23.1 Context & Problem Definition
In long sessions or when routing to slow, queue-congested, or deep reasoning models (e.g. `GLM 5.3 Flash`, `o3-mini`, `DeepSeek R1`), the UI previously remained frozen on `● Working ...` for several minutes with zero feedback. Users could not tell if the extension was reading files, connecting, thinking, writing, or completely hung.

### 23.2 Live Lifecycle Activity Tracking (`AGENT_PROGRESS`)
- **Granular Execution Phases:**
  - `loading`: `Loading workspace files...` during initial repository tree indexing.
  - `reading`: `Reading file: <filename>...` during active editor buffer and referenced file extraction.
  - `connecting`: `Connecting to <modelName>...` while constructing payloads and dispatching the HTTP request.
  - `thinking`: `Thinking...` (styled with a purple accent) when reasoning tokens are received.
  - `writing`: `Writing...` (styled with a blue accent) as response token streaming begins.
  - `applying`: `Applying edit: <filename>...` during diff application.
  - `terminal`: `Running in terminal: <cmd>...` (styled with an amber accent) during command execution.
- **Dual UI Synchronization:**
  - Live status text updates both the in-chat progress pill (`agentProgress.ts`) and the bottom footer status bar simultaneously.

### 23.3 OpenRouter Reasoning Token Streaming
- **SSE Stream Capture:**
  - Extended `StreamChunkChoice.delta` in `openrouterClient.ts` to capture `reasoning` and `thought` tokens.
  - Emits `onReasoningChunk` on the first thinking token, immediately updating the status pill to `Thinking...` and preventing the model from appearing frozen during extended reasoning intervals.

### 23.4 Dual Activity Timeouts
- **75-Second Initial Connection Timeout:** Protects against unresponsive upstream provider queues before response headers arrive.
- **45-Second Idle Chunk Timeout:** Detects stalled SSE streams and surfaces an interactive error card with a `↻ Retry` action rather than hanging indefinitely.

---

## Phase 24: Reasoning Effort Recording & High-Visibility Audit Badging

### 24.1 Context & Problem Definition
Reasoning effort selection (`Low`, `Medium`, `High`) previously disappeared from the Usage Data report across multi-turn autonomous executions, terminal retries, and model switches. Additionally, long model strings in the audit table cell were CSS-truncated to 140px, hiding the reasoning tier from view.

### 24.2 Comprehensive Model Capability Detection
- Expanded `isReasoningModel` in `modelCapabilities.ts` to detect reasoning capacity across model IDs, names, descriptions, and parameter definitions matching `r1`, `reason`, `thinking`, `qwq`, `glm`, `o1`, and `o3`.

### 24.3 Persistence & Explicit Audit Attributes
- **Data Model:** Added `reasoningEffort?: string` directly to `UsageAuditRecord` in `usageStore.ts`.
- **Session-Wide Tracking:** `_activeReasoningEffort` is maintained across all autonomous continuation steps, terminal self-healing retries, and empty-completion recovery turns.
- **Model Switch Preservation:** User effort preferences persist during model exploration in `main.ts` rather than being wiped to `undefined`.

### 24.4 Visual Badging in Usage Reports
- **Styling:** Added `.effort-badge` with a glowing purple glassmorphism pill (`background: rgba(210, 168, 255, 0.18); border: 1px solid rgba(210, 168, 255, 0.4); font-weight: 600;`).
- **Layout:** Expanded the audit table model column width to `260px` to prevent label truncation.

---

## Phase 25: Autonomous Execution Continuity & Multi-Layered Self-Healing Engine

### 25.1 Context & Problem Definition
During multi-step plan execution, terminal tasks, and file modifications, execution frequently halted prematurely mid-operation, forcing the user to repeatedly prompt *"continue"* or *"go on"*.

Root causes identified:
1. **Continuation Nested Under Terminal Permissions:** The multi-step continuation turn for file edits was nested directly inside `if (runTerminalPerm === 'allow')`. Because terminal permissions default to `'ask'`, applying file edits without terminal commands never triggered the continuation turn.
2. **Permission Check Missed `'allow_session'`:** Checks such as `applyEditPerm === 'allow'` evaluated to `false` when permissions were set to `'allow_session'`.
3. **No File Edit Self-Healing:** Unlike terminal commands, when an edit encountered a minor line drift or search block mismatch, the extension logged a red warning and halted execution immediately rather than asking the model to fix the block.
4. **Conversational Pauses Mid-Task:** If the model emitted intermediate thoughts without generating code or concluding with a walkthrough, the extension released the busy state and stalled.
5. **Terminal Timeouts Stalled Loops:** Commands running over 60s timed out and were dropped from both continuation and retries.
6. **Syntax Variations in Code Fences:** Fences such as ````edit:path````, ````create:path````, and ````dart:path```` failed the restrictive `create_file|edit_file|file` regex.

### 25.2 Un-nested Multi-Step Execution Lifecycle
- Moved file-edit continuation to the top level of `_handleAutoExecution` in `panelProvider.ts`.
- Applying file edits immediately triggers the next implementation step, completely independent of whether terminal permissions are `'ask'`, `'deny'`, or `'allow'`.

### 25.3 Live File Edit Self-Healing Loop
- When a file edit fails (e.g. `SEARCH block not found in file` or malformed search/replace blocks), the extension records it in `failedEdits`.
- If retries remain (`retryCount < 5`), the extension reads the actual current content of the target file and dispatches an automated self-healing retry turn:
  ```markdown
  🔄 File edit to `<path>` failed: <error>. Initiating self-healing retry (<attempt>/5)...
  ```
- The model is supplied with the live file excerpt and prompted to emit a corrected `edit_file` block with exact matching lines, allowing execution to self-heal and proceed automatically.

### 25.4 Extended Terminal Timeout & Timeout Self-Healing
- Increased default command timeout from 60s to 120s in `commandRunner.ts` to support Flutter/Dart compilation, dependency resolution (`pub get`), and test runs.
- Timeout events (`result.timedOut`) are routed to diagnostic self-healing prompts rather than being dropped, allowing the model to adjust commands or proceed.

### 25.5 Conversational Stall Recovery & Execution Intent Tracking
- In `case 'SEND_MESSAGE'`, user execution commands (`"Proceed with the plan"`, `"implement"`, `"execute"`) automatically initialize the autonomous execution context (`isAutoFollowUp: true`).
- If an autonomous execution turn produces neither file edits nor terminal commands nor a concluding `walkthrough` block, the extension automatically prompts the model:
  *"Please proceed directly with the implementation without pausing for confirmation. Emit the required file edits or terminal commands for the next step, or provide the final walkthrough if all implementation and verification steps are complete."*

### 25.6 Unified Permission Support & Expanded Code Fence Matching
- **Permission States:** Both `applyEdit` and `runTerminalCommand` accept `'allow'` and `'allow_session'` identically.
- **Expanded Code Fences:** Updated `fileActionRegex` in both `panelProvider.ts` and `main.ts` to match `create_file:`, `edit_file:`, `file:`, `create:`, `edit:`, `patch:`, and language-prefixed paths (e.g. `dart:lib/...`).
- **Manual Command Continuation:** In `case 'RUN_TERMINAL'`, manual execution from chat cards automatically feeds results back to the model, ensuring seamless continuity even when terminal permissions are set to `'ask'`.

---

## Phase 26: Proactive Workspace File Discovery Rule

### 26.1 Context & Problem Definition
When users referenced a file by name (e.g. `prd.md`, `schema.prisma`) in a prompt, the assistant occasionally responded claiming the file did not exist — even when the file was present in a subdirectory — because it only checked the top-level root directory or currently open editor tabs.

### 26.2 Workspace Rule: `file_discovery.md`
- A dedicated workspace rule (`.agents/rules/file_discovery.md`) was added to enforce **Mandatory Silent Pre-Search** before any claim of file absence.
- **Rule invariants:**
  1. **Never claim a file is missing without searching first.** If a file name is referenced and is not immediately visible, the assistant must run a workspace search (`dir /s /b`, ripgrep, or directory tree traversal) before responding.
  2. **Search subdirectories.** The search must recurse through the full workspace tree (e.g. `Docs\PRD.md`, `specs/`, nested source directories).
  3. **Only fallback on zero matches.** Only if all search attempts across all subfolders yield no results may the assistant ask for clarification or report the file as missing.
- This eliminates premature hallucination / bail-out behavior on fresh model turns where the file context was not pre-injected into the prompt.

---

## Phase 27: Stop Button Race Condition Fix

### 27.1 Context & Problem Definition
The Stop button (`STOP_STREAM`) correctly set `_isUserCancelled = true` and called `_activeAbortController.abort()`. However, a race condition existed in the auto-follow-up / autonomous continuation path:

1. Auto-turn N+1 enters `_handleSendMessage`.
2. The `else` branch (auto-follow-up path) checks `_isUserCancelled` → `false`. ✅
3. A **new** `AbortController` is created and assigned to `_activeAbortController`.
4. **Stop fires here** → calls `abort()` on the **old** controller (now discarded). ❌ New controller is never aborted.
5. Turn N+1 streams to completion and triggers turn N+2.

### 27.2 Double-Check Fix
- After creating the new `AbortController` in the auto-follow-up path, `_isUserCancelled` is checked **a second time** (closing the race window):
  ```typescript
  this._activeAbortController = new AbortController();
  if (this._isUserCancelled) {
    this._activeAbortController.abort();
    this._postMessage({ type: 'SET_BUSY', busy: false });
    return;
  }
  ```
- This guarantees that any Stop signal arriving between the first flag check and the controller swap is honored on the new controller before any streaming begins.
- JavaScript's single-threaded execution model ensures the only interleaving point is across `await` boundaries; the double-check closes that window.

---

## Phase 28: Reviewer Session Lifecycle Overhaul — No New Sessions on Startup

### 28.1 Context & Problem Definition
Every time VS Code launched fresh and the user clicked **Review** on an artifact, a **new empty reviewer session** was created on disk — despite a fully populated previous session existing. After several sessions, the sessions list accumulated many empty entries. Root cause:

- `RESET_REVIEWER_CONTEXT` called `startNewReviewerSession()` → created a new **empty** session on disk.
- On next startup, `_reviewerHistory = []` (never loaded from disk yet) and `activeSession.messages.length === 0` (the empty reset session) → `isSessionActive = false` → `_handleStartReview` called `startNewReviewerSession()` again → another new empty session.
- This repeated on every cold-start.

### 28.2 `clearActiveReviewerSession()` — In-Place Wipe
- Added `clearActiveReviewerSession()` to `HistoryStore`:
  - Clears `messages`, resets `title`, `artifactContent`, `artifactType`, `artifactMessageId` on the **active session in-place**.
  - Saves to disk. No new session entry is created.
- `RESET_REVIEWER_CONTEXT` now calls `clearActiveReviewerSession()` instead of `startNewReviewerSession('Review Session (Fresh)')`.

### 28.3 Disk-First Session Sync in `_handleStartReview`
- `_handleStartReview` now **always** calls `loadReviewerSessions()` first and syncs `_reviewerHistory` from the persisted active session if in-memory history is empty.
- After syncing, `hasExistingMessages` is evaluated accurately even on cold-start (no reviewer tab opened yet this session).
- If the active session is **empty** (fresh or after a reset), it is **reused in-place** (title + artifact context updated, no new entry created).
- If the active session **has messages**, the full history and model data are sent to the webview.

---

## Phase 29: Reviewer Panel Cold-Start Initialization Fix

### 29.1 Context & Problem Definition
When the user pushed an artifact for review **without** first clicking the reviewer tab (cold-start push), the reviewer panel opened in a blank state:
- **Messages area:** empty — no conversation history visible.
- **Model selector:** showed "Reviewer Model…" placeholder instead of the configured model name.
- **Reasoning effort control:** hidden (because `updateReviewerPanelReasoningControl` returned early when `loadedModels` was empty).

The AI still understood the request (session was synced from disk), but the UI appeared completely blank.

Two distinct failure modes:

**Failure A — Wrong message type sent:** The `hasExistingMessages = true` branch of `_handleStartReview` sent only `REVIEWER_ATTACH_ARTIFACT`. This function only opens the view and adds the doc chip — it never sets `activeReviewerModelId`, never renders history, and never calls `updateReviewerPanelReasoningControl`.

**Failure B — Model list race:** `REVIEWER_VIEW_DATA` could arrive before `MODELS_LOADED` completed. `loadedModels = []` → `foundModel = undefined` → raw model ID shown instead of display name → reasoning effort hidden.

### 29.2 Fix A — Dual Message Sequence for Existing Sessions
The `hasExistingMessages` branch now sends **two messages** in sequence:
1. **`REVIEWER_VIEW_DATA`** — renders full history, sets `activeReviewerModelId`, shows model display name, populates reasoning effort control.
2. **`REVIEWER_ATTACH_ARTIFACT`** — adds the newly pushed doc chip to the input bar.

`openReviewerView` already handles clearing and re-rendering history correctly; `handleReviewerAttachArtifact` adds the chip right after — the sequence is clean with no duplication.

### 29.3 Fix B — Deferred Reviewer Panel Refresh After Model List Load
In the `MODELS_LOADED` handler, after populating `loadedModels`, a check is added:
```typescript
if (viewReviewer && !viewReviewer.classList.contains('hidden') && activeReviewerModelId) {
  // Re-apply reviewer panel display now that model list is available
  const foundReviewerModel = loadedModels.find((m) => m.id === activeReviewerModelId);
  if (foundReviewerModel) {
    reviewerPanelModelInput.value = foundReviewerModel.name || foundReviewerModel.id;
  }
  updateReviewerPanelReasoningControl(activeReviewerModelId);
  updateReviewerTokenMeter();
}
```
If `REVIEWER_VIEW_DATA` arrived before models loaded (race), this deferred refresh corrects the model display name and reasoning effort visibility as soon as the model catalog is available.

---

## Phase 30: Diagnostic Logging System & Execution Visibility

### 30.1 Purpose & Problem Statement
When models stall, hit rate limits, terminate unexpectedly mid-stream, or fail permission checks, non-technical users and developers need clear, comprehensive diagnostic telemetry without exposing sensitive credentials or file contents. Furthermore, sessions need distinct visibility between the Main Agent workflow and the secondary Reviewer workflow.

### 30.2 Diagnostic Logger Architecture (`src/logger.ts`)
- **Storage & Rotation:**
  - Persisted in VS Code's global storage directory: `log-today.txt`, `log-yesterday.txt`, and `log-2daysago.txt` (rolling 3-day history).
  - Maximum size bounded at 2MB per file to prevent unbounded disk growth.
  - In-memory ring buffer (1,000 lines) for fast access without disk thrashing.
  - Asynchronous non-blocking file append pipeline with safe write queueing.
- **Privacy & Safety Guards:**
  - Strictly sanitizes outputs: API keys, tokens, prompt text, and full file contents are never written to disk.
  - Only event categories, metadata, timestamps, token counts, error codes, and relative file paths are logged.
- **Commands:**
  - `OpenRouter: Copy Diagnostic Logs to Clipboard` (`openrouter.copyDiagnosticLogs`) — reads today's log directly into the OS clipboard and surfaces an informative notification.
  - `OpenRouter: Open Diagnostic Log File` (`openrouter.openDiagnosticLog`) — opens the active `log-today.txt` file directly inside the VS Code editor tab.

### 30.3 Event Taxonomy & Categorization Tags

| Category Tag | Component | Description & Event Details |
|---|---|---|
| `[LOGGER  ]` | Logger Core | Logger initialization, storage path verification, and date rotation. |
| `[EXT     ]` | Extension Lifecycle | Extension activation and clean deactivation/shutdown events. |
| `[AUTH    ]` | Authentication | API key presence checks, validation success, or validation failures. |
| `[MODELS  ]` | Catalog | Fetching `/models` catalog count, refresh triggers, and network errors. |
| `[CHAT    ]` | User Interaction | User message submissions with estimated draft tokens and active model ID. |
| `[AGENT   ]` | Main Agent Workflow | Agent turn initialization, context window calculations, token budgets (`history` vs `model limit`). |
| `[REVIEW  ]` | Reviewer Workflow | Reviewer session lifecycle, reviewer stream initiation, artifact attachment token estimates (`artifact: ~N tokens`). |
| `[API     ]` | OpenRouter Client | Stream requests (with attempt number / retries), completion statuses, token metrics (`INPUT` and `OUTPUT` on separate lines), and stream termination reasons. |
| `[PERM    ]` | Permission Manager | Evaluations for `runTerminalCommand`, `applyEdit`, `createDeleteFiles`: records whether action was `ALLOWED`, `DENIED`, or `ASKING user` (including session/permanent grants). |
| `[EDIT    ]` | Diff Preview / Workspace | Diff preview openings (`Opened diff preview for <path>`) and patch applications (`Applied edit successfully` or `Failed to apply edit`). |
| `[TERM    ]` | Command Runner | Terminal command executions, exact commands, process exit codes, timeouts, cancellations, and self-healing retries. |
| `[FILE    ]` | Context Reader | Active document inspections, read requests, batching triggers, and missing referenced files. |
| `[CMD     ]` | Command Palette | User triggering diagnostic log commands. |

### 30.4 Stream Mid-Execution Termination Diagnostics (`finish_reason`)
To explain why a model stopped or cut off mid-response, the SSE stream parser captures the chunk-level `finish_reason` and outputs explicit diagnostic diagnostics:
- **`stop`**: `Stop reason: "stop" — model finished normally ✓`
- **`length`**: `Stop reason: "length" — model hit its max_tokens limit and was CUT OFF mid-response!`
- **`content_filter`**: `Stop reason: "content_filter" — response was blocked by the provider content policy`
- **`tool_calls`**: `Stop reason: "tool_calls" — model requested tool/function calls`
- **Missing / Free Tier**: `Stop reason: unknown — finish_reason was not included in stream (free model or provider limitation)`

### 30.5 Streamlined Token Usage Formatting
Stream completion logs format input and output tokens onto distinct lines for clarity:
```text
[INFO ] [API     ] Stream complete ✓ — INPUT  tokens: 4200
[INFO ] [API     ] Stream complete ✓ — OUTPUT tokens: 312 (total: 4512)
```

### 30.6 Main Agent vs. Reviewer Stream Differentiation
Differentiating actions between the main agent and the reviewer is accomplished through explicit category tagging and sequencing:
- Main agent turns emit `[AGENT   ] Turn start` followed by `[API     ] Stream request`.
- Reviewer runs emit `[REVIEW  ] Reviewer stream start — model: <id>, artifact: ~N tokens` followed by `[API     ] Stream request`.
- Both stream completions are tagged with `[API     ]`, traceable directly to their initiating block.