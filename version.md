# OpenRouter Extension Version History & Changelog

All notable changes, bug fixes, architectural enhancements, and operational updates are documented in this file whenever a version number is bumped or a release milestone is reached.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
