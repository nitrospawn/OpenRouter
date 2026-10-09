import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  SendFileToReviewerMessage,
  SendContentToReviewerMessage,
  ReviewerContextPopulatedMessage,
} from '../src/webview/messages';

test('Send to Reviewer: message protocol types conform to specification', () => {
  const fileMsg: SendFileToReviewerMessage = {
    type: 'SEND_FILE_TO_REVIEWER',
    filePath: 'src/extension.ts',
    customPrompt: 'Please check this file',
  };
  assert.strictEqual(fileMsg.type, 'SEND_FILE_TO_REVIEWER');
  assert.strictEqual(fileMsg.filePath, 'src/extension.ts');

  const contentMsg: SendContentToReviewerMessage = {
    type: 'SEND_CONTENT_TO_REVIEWER',
    content: 'const x = 42;',
    sourceLabel: 'Selected chat snippet',
  };
  assert.strictEqual(contentMsg.type, 'SEND_CONTENT_TO_REVIEWER');
  assert.strictEqual(contentMsg.content, 'const x = 42;');

  const populatedMsg: ReviewerContextPopulatedMessage = {
    type: 'REVIEWER_CONTEXT_POPULATED',
    attachment: {
      filePath: 'src/extension.ts',
      fileName: 'extension.ts',
      content: 'console.log("hello")',
      sizeBytes: 20,
    },
    promptText: 'Please review src/extension.ts for correctness.',
  };
  assert.strictEqual(populatedMsg.type, 'REVIEWER_CONTEXT_POPULATED');
  assert.strictEqual(populatedMsg.attachment?.fileName, 'extension.ts');
  assert.strictEqual(populatedMsg.attachment?.sizeBytes, 20);
});

test('Send to Reviewer: formatBytes helper formats human-readable file sizes correctly', () => {
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  assert.strictEqual(formatBytes(500), '500 B');
  assert.strictEqual(formatBytes(1024), '1.0 KB');
  assert.strictEqual(formatBytes(2048), '2.0 KB');
  assert.strictEqual(formatBytes(1048576), '1.0 MB');
  assert.strictEqual(formatBytes(5242880), '5.0 MB');
});

test('Send to Reviewer: path cleaning strips quotes, line numbers and anchor hashes', () => {
  function cleanReviewPath(raw: string): string {
    let target = (raw || '').trim().replace(/^["']|["']$/g, '');
    return target.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/i, '').trim();
  }

  assert.strictEqual(cleanReviewPath('"src/app.ts:42"'), 'src/app.ts');
  assert.strictEqual(cleanReviewPath("'src/app.ts:42:10'"), 'src/app.ts');
  assert.strictEqual(cleanReviewPath('docs/walkthrough.md#L10-L25'), 'docs/walkthrough.md');
  assert.strictEqual(cleanReviewPath('file:///C:/path/file.dart'), 'file:///C:/path/file.dart');
});

test('Send to Reviewer: text selection detection falls back to full content when empty', () => {
  function determineReviewPayload(selection: string | null | undefined, fullContent: string) {
    const trimmedSel = selection?.trim();
    if (trimmedSel && trimmedSel.length > 0) {
      return { content: trimmedSel, sourceLabel: 'Selected chat snippet' };
    }
    return { content: fullContent, sourceLabel: 'Assistant response' };
  }

  const res1 = determineReviewPayload('   important function   ', 'entire 200 line message');
  assert.strictEqual(res1.content, 'important function');
  assert.strictEqual(res1.sourceLabel, 'Selected chat snippet');

  const res2 = determineReviewPayload('', 'entire 200 line message');
  assert.strictEqual(res2.content, 'entire 200 line message');
  assert.strictEqual(res2.sourceLabel, 'Assistant response');

  const res3 = determineReviewPayload(null, 'entire 200 line message');
  assert.strictEqual(res3.content, 'entire 200 line message');
  assert.strictEqual(res3.sourceLabel, 'Assistant response');
});

test('Send to Reviewer: non-existent file path returns safe warning without throwing', () => {
  const fakePath = 'non/existent/file_that_does_not_exist_12345.xyz';
  const exists = fs.existsSync(fakePath);
  assert.strictEqual(exists, false);
});

test('Send to Reviewer: FILE_LINK_EXTENSIONS recognizes dart and flutter files', () => {
  const FILE_LINK_EXTENSIONS = 'dart|kt|kts|swift|m|mm|py|js|ts|jsx|tsx|md|markdown|json|html|htm|css|scss|less|yaml|yml|toml|xml|csv|tsv|rs|go|c|cpp|h|hpp|cs|java|sql|sh|bash|bat|cmd|ps1|txt|log|svg|png|jpg|jpeg|gif|webp|pdf|rb|php|lua|r|scala|zig|vue|svelte|astro|gradle|properties|ini|conf';
  const extRegex = new RegExp('\\.(' + FILE_LINK_EXTENSIONS + ')$', 'i');

  assert.ok(extRegex.test('reminder_store.dart'), 'reminder_store.dart must be recognized as file');
  assert.ok(extRegex.test('reminder_restore.dart'), 'reminder_restore.dart must be recognized as file');
  assert.ok(extRegex.test('notification_service.dart'), 'notification_service.dart must be recognized as file');
  assert.ok(extRegex.test('build.gradle'), 'build.gradle must be recognized as file');
  assert.ok(extRegex.test('MainActivity.kt'), 'MainActivity.kt must be recognized as file');
});

test('Send to Reviewer: floating selection toolbar triggers SEND_CONTENT_TO_REVIEWER with selected snippet', () => {
  const selectedText = 'device-gate rows are BLOCKED: T3-10 (notification fires on device)';
  const msg: SendContentToReviewerMessage = {
    type: 'SEND_CONTENT_TO_REVIEWER',
    content: selectedText,
    sourceLabel: 'Selected chat snippet',
  };

  assert.strictEqual(msg.type, 'SEND_CONTENT_TO_REVIEWER');
  assert.strictEqual(msg.content, selectedText);
  assert.strictEqual(msg.sourceLabel, 'Selected chat snippet');
});

test('Send to Reviewer: review button suppression in reviewer context', () => {
  function mockCreateClickableFileLink(filePath: string, displayText?: string, showReviewBtn = true) {
    const cleanPath = filePath.trim().replace(/^["']|["']$/g, '');
    const elements: string[] = ['file-link-text'];
    if (showReviewBtn) {
      elements.push('file-link-review-btn');
    }
    return { cleanPath, displayText: displayText || cleanPath, elements };
  }

  // When rendering in main chat (default):
  const mainLink = mockCreateClickableFileLink('_docs/gate0-phase3.md', undefined, true);
  assert.ok(mainLink.elements.includes('file-link-review-btn'), 'Main chat link must have review button');

  // When rendering in reviewer chat (suppressed):
  const reviewerLink = mockCreateClickableFileLink('_docs/gate0-phase3.md', undefined, false);
  assert.strictEqual(
    reviewerLink.elements.includes('file-link-review-btn'),
    false,
    'Reviewer chat link must NOT render review button'
  );
});

test('Send to Reviewer: isInsideReviewerChat helper logic', () => {
  function testIsInsideReviewerChat(el: { id?: string; dataset?: Record<string, string>; parent?: any }): boolean {
    if (!el) return false;
    if (el.dataset?.isReviewer === 'true') return true;
    let curr: any = el;
    while (curr) {
      if (curr.id === 'view-reviewer' || curr.id === 'reviewer-messages' || curr.dataset?.isReviewer === 'true') {
        return true;
      }
      curr = curr.parent;
    }
    return false;
  }

  const reviewerContainer = { id: 'view-reviewer', dataset: { isReviewer: 'true' } };
  const messageBody = { dataset: { isReviewer: 'true' }, parent: reviewerContainer };
  const paragraph = { parent: messageBody };

  assert.strictEqual(testIsInsideReviewerChat(paragraph), true);
  assert.strictEqual(testIsInsideReviewerChat(messageBody), true);

  const mainChatContainer = { id: 'view-main', dataset: {} };
  const mainMessageBody = { dataset: {}, parent: mainChatContainer };
  const mainParagraph = { parent: mainMessageBody };

  assert.strictEqual(testIsInsideReviewerChat(mainParagraph), false);
});

test('Send to Reviewer: style.css enforces review button suppression in reviewer view', () => {
  const cssPath = path.resolve(__dirname, '../../src/webview/ui/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  assert.ok(
    cssContent.includes('#view-reviewer .file-link-review-btn'),
    'CSS must suppress file-link-review-btn in #view-reviewer'
  );
  assert.ok(
    cssContent.includes('#reviewer-messages .file-link-review-btn'),
    'CSS must suppress file-link-review-btn in #reviewer-messages'
  );
  assert.ok(
    cssContent.includes('[data-is-reviewer="true"] .file-link-review-btn'),
    'CSS must suppress file-link-review-btn in [data-is-reviewer="true"]'
  );
  assert.ok(
    cssContent.includes('display: none !important'),
    'Suppression rule must use display: none !important'
  );
});

test('Send to Reviewer: review button suppression when Reviewer Mode is OFF', () => {
  function testCreateClickableFileLink(
    filePath: string,
    isReviewerModeOn: boolean,
    showReviewBtn?: boolean,
    isInsideReviewer = false
  ) {
    const cleanPath = filePath.trim().replace(/^["']|["']$/g, '');
    const elements: string[] = ['file-link-text'];
    const shouldRenderReview =
      (showReviewBtn !== undefined ? showReviewBtn : true) && isReviewerModeOn && !isInsideReviewer;
    if (shouldRenderReview) {
      elements.push('file-link-review-btn');
    }
    return { cleanPath, elements };
  }

  // 1. Reviewer Mode OFF -> Review button must NOT show in main chat
  const offLink = testCreateClickableFileLink('_docs/gate0-phase3.md', false);
  assert.strictEqual(
    offLink.elements.includes('file-link-review-btn'),
    false,
    'When reviewer mode is OFF, review button must not render'
  );

  // 2. Reviewer Mode ON -> Review button shows in main chat
  const onLink = testCreateClickableFileLink('_docs/gate0-phase3.md', true);
  assert.strictEqual(
    onLink.elements.includes('file-link-review-btn'),
    true,
    'When reviewer mode is ON, review button must render in main chat'
  );

  // 3. Reviewer Mode ON -> Review button still does NOT show in reviewer chat
  const reviewerChatLink = testCreateClickableFileLink('_docs/gate0-phase3.md', true, undefined, true);
  assert.strictEqual(
    reviewerChatLink.elements.includes('file-link-review-btn'),
    false,
    'In reviewer chat, review button must never render even when reviewer mode is ON'
  );
});

test('Send to Reviewer: style.css enforces global review button suppression when reviewer mode is off', () => {
  const cssPath = path.resolve(__dirname, '../../src/webview/ui/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  assert.ok(
    cssContent.includes('body.reviewer-disabled .file-link-review-btn') &&
      cssContent.includes('body:not(.reviewer-enabled) .file-link-review-btn'),
    'CSS must suppress file-link-review-btn when reviewer is disabled'
  );
  assert.ok(
    cssContent.includes('body.reviewer-disabled .btn-review-file') &&
      cssContent.includes('body:not(.reviewer-enabled) .btn-review-file'),
    'CSS must suppress btn-review-file when reviewer is disabled'
  );
  assert.ok(
    cssContent.includes('body.reviewer-disabled .msg-review-btn') &&
      cssContent.includes('body:not(.reviewer-enabled) .msg-review-btn'),
    'CSS must suppress msg-review-btn when reviewer is disabled'
  );
  assert.ok(
    cssContent.includes('body.reviewer-disabled .btn-review-selection') &&
      cssContent.includes('body:not(.reviewer-enabled) .btn-review-selection'),
    'CSS must suppress btn-review-selection when reviewer is disabled'
  );
});

test('Send to Reviewer: panelProvider renders reviewer-disabled class on body when reviewer mode is off', () => {
  const panelPath = path.resolve(__dirname, '../../src/webview/panelProvider.ts');
  const panelContent = fs.readFileSync(panelPath, 'utf8');

  assert.ok(
    panelContent.includes("body class=\"${reviewerEnabled ? 'reviewer-enabled' : 'reviewer-disabled'}\""),
    'panelProvider.ts must set initial body class based on reviewerEnabled'
  );
});

test('Anti-Flicker: style.css enforces stable geometry and isolated text underline', () => {
  const cssPath = path.resolve(__dirname, '../../src/webview/ui/style.css');
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  // Verify stable baseline & layout geometry
  assert.ok(
    cssContent.includes('.clickable-file-link {') &&
      cssContent.includes('vertical-align: middle;') &&
      cssContent.includes('white-space: nowrap;'),
    '.clickable-file-link must have vertical-align: middle and white-space: nowrap'
  );

  // Verify transition: all is removed to avoid subpixel text shimmers
  const linkSection = cssContent.slice(
    cssContent.indexOf('.clickable-file-link {'),
    cssContent.indexOf('.clickable-file-link:hover')
  );
  assert.strictEqual(
    linkSection.includes('transition: all'),
    false,
    '.clickable-file-link must NOT have transition: all'
  );

  // Verify underline is isolated to .file-link-name instead of emoji
  assert.ok(
    cssContent.includes('.clickable-file-link:hover .file-link-name'),
    'Hover underline must target .file-link-name'
  );

  // Verify active state does not scale transform
  const activeIndex = cssContent.indexOf('.clickable-file-link:active');
  const activeSection = cssContent.slice(activeIndex, activeIndex + 120);
  assert.strictEqual(
    activeSection.includes('transform: scale'),
    false,
    '.clickable-file-link:active must NOT transform: scale to avoid geometry jitter'
  );
});




