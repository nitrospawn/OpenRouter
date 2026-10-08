# Implementation Plan: Universal "Send to Reviewer" from Chat

## 1. Overview & Objective
Allow users to easily forward **any real workspace file** (or selected chat message text) directly to the **Reviewer** model from the main chat webview interface with a single click, without hardcoding file patterns or manual copy-pasting.

---

## 2. User Experience & UI Specifications

### A. Proposed Edit Card Header
- In the file edit banner (`📁 Proposed Edit: <filePath>`), add a `🔍 Review File` action button alongside `Expand Diff`.
- Clicking `🔍 Review File` reads the file from disk, attaches it to the Reviewer panel, and switches focus to the Reviewer tab.

### B. In-Chat File Links & Chips
- When markdown file links (`[file.md](file://...)`) or file chips (`📄 path/to/file.ext`) are rendered in chat bubbles:
- On hover/interaction, provide a secondary action button or menu option: `🔍 Send to Reviewer`.

### C. Message Bubble Action ("Review Selection / Message")
- In the action footer of each assistant message bubble (alongside `Copy`, `Clarify`):
- Add a `🔍 Review Message` button.
- If text is highlighted within the bubble, it forwards the highlighted selection; otherwise, it forwards the complete message content as a review subject.

### D. Reviewer Panel Target State
- Switches active tab to the Reviewer view.
- Injects the referenced file as an attachment chip: `📎 <relativePath> (size) [×]`.
- Pre-fills a clean prompt: `Please review <filePath> for correctness, potential regressions, and alignment with project requirements.` with a one-click `[Submit Review]` button.

---

## 3. Architecture & Messaging Protocol

### New Webview Message Types (`src/webview/messages.ts`)
```typescript
// Webview -> Host
export interface SendFileToReviewerMessage {
  type: 'SEND_FILE_TO_REVIEWER';
  filePath: string;
  customPrompt?: string;
}

export interface SendContentToReviewerMessage {
  type: 'SEND_CONTENT_TO_REVIEWER';
  content: string;
  sourceLabel?: string; // e.g. "Chat Turn from Assistant"
}

// Host -> Webview
export interface ReviewerContextPopulatedMessage {
  type: 'REVIEWER_CONTEXT_POPULATED';
  attachment?: {
    filePath: string;
    content: string;
    sizeBytes: number;
  };
  promptText: string;
}
```

---

## 4. Implementation Steps

### Phase 1: Host Backend Logic (`src/webview/panelProvider.ts`)
1. Handle `SEND_FILE_TO_REVIEWER` in `_handleWebviewMessage`:
   - Resolve `filePath` against `vscode.workspace.workspaceFolders`.
   - Verify file existence via `vscode.workspace.fs.stat`.
   - Read file bytes and decode to UTF-8.
   - Dispatch `REVIEWER_CONTEXT_POPULATED` to the webview with attachment metadata.
2. Handle `SEND_CONTENT_TO_REVIEWER`:
   - Pass message or selected text snippet to the Reviewer context.

### Phase 2: Webview UI Rendering (`src/webview/ui/main.ts` & `src/webview/ui/style.css`)
1. **Edit Card Button:**
   - In `renderEditCard(edit)`: inject `<button class="btn-review-file" data-filepath="...">🔍 Review File</button>`.
   - Wire click handler to dispatch `SEND_FILE_TO_REVIEWER`.
2. **Chat Bubble Action:**
   - In assistant message action bar: inject `<button class="btn-review-msg">🔍 Review</button>`.
   - Detect `window.getSelection()`; if non-empty, forward selected text, else forward message body.
3. **Reviewer Tab Auto-Switch & Pre-Fill:**
   - On `REVIEWER_CONTEXT_POPULATED`, toggle UI tab to Reviewer mode.
   - Render the attachment pill inside the reviewer input box.
   - Populate suggested review prompt and focus the submit button.

---

## 5. Verification & Testing
1. **File Edit Review Test:**
   - Trigger a task that proposes an edit (e.g. `docs/walkthrough.md` or `test/example_test.dart`).
   - Click `🔍 Review File`.
   - Verify Reviewer tab opens with the file attached and the Reviewer analyzes the exact code.
2. **Text Selection Test:**
   - Highlight a specific block of text in chat.
   - Click `🔍 Review`.
   - Verify only the highlighted snippet is forwarded to the Reviewer.
3. **Non-Existent File Guard:**
   - Ensure clicking a file that was deleted or invalid displays a graceful warning without crashing the panel.
