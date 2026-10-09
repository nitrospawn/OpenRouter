import test from 'node:test';
import * as assert from 'node:assert';

class MockElement {
  public tagName: string;
  public className: string = '';
  public textContent: string = '';
  private _innerHTML: string = '';
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(val: string) {
    this._innerHTML = val;
    if (val === '') {
      this.children = [];
    }
  }

  public id: string = '';
  public title: string = '';
  public style: any = {};
  public children: MockElement[] = [];
  public events: Record<string, Function> = {};
  public dataset: Record<string, string> = {};
  public value: string = '';
  public disabled: boolean = false;
  public classList = {
    classes: new Set<string>(),
    add: (c: string) => { this.classList.classes.add(c); this.className = Array.from(this.classList.classes).join(' '); },
    remove: (c: string) => { this.classList.classes.delete(c); this.className = Array.from(this.classList.classes).join(' '); },
    contains: (c: string) => this.classList.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const shouldAdd = force !== undefined ? force : !this.classList.classes.has(c);
      if (shouldAdd) { this.classList.classes.add(c); } else { this.classList.classes.delete(c); }
      this.className = Array.from(this.classList.classes).join(' ');
      return shouldAdd;
    },
  };
  
  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(child: MockElement) {
    this.children.push(child);
  }

  addEventListener(event: string, callback: Function) {
    this.events[event] = callback;
  }

  click() {
    if (this.events['click']) {
      this.events['click']({ preventDefault: () => {} });
    }
  }

  querySelector(selector: string): MockElement | undefined {
    if (selector === 'span' && this.tagName === 'span') return this;
    for (const child of this.children) {
      const isClassMatch = selector.startsWith('.') && child.className.split(/\s+/).includes(selector.substring(1));
      if (child.tagName === selector || isClassMatch) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return undefined;
  }

  querySelectorAll(selector: string): MockElement[] {
    return [];
  }
  
  closest(selector: string): MockElement | undefined {
    return this;
  }
}

const mockElements = new Map<string, MockElement>();

const mockDocument = {
  createElement: (tagName: string) => new MockElement(tagName),
  getElementById: (id: string) => {
    if (!mockElements.has(id)) {
      const el = new MockElement('div');
      el.id = id;
      mockElements.set(id, el);
    }
    return mockElements.get(id);
  },
  createTextNode: (text: string) => {
    const el = new MockElement('#text');
    el.textContent = text;
    return el;
  },
  addEventListener: () => {},
  body: new MockElement('body'),
  querySelectorAll: () => []
};

(global as any).document = mockDocument;
(global as any).window = { addEventListener: () => {} };
(global as any).acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => ({}),
  setState: () => {}
});

Object.defineProperty(global, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  writable: true,
  configurable: true
});

// Dynamic require after globals are set
test('User Message Collapsing: appendMessage routes user unfenced large content through code block logic', () => {
  const { appendMessage } = require('../src/webview/ui/main');
  
  const userLines = Array.from({ length: 50 }, (_, i) => `user pasted line ${i + 1}`);
  const userCode = userLines.join('\n');
  
  // The user message does NOT have fences. This simulates pasting directly into input.
  appendMessage('user', userCode);
  
  const messagesContainer = mockDocument.getElementById('messages-container');
  assert.ok(messagesContainer, 'messages container should exist');
  
  const lastMessage = messagesContainer!.children[messagesContainer!.children.length - 1];
  assert.strictEqual(lastMessage.className, 'message user');
  
  const bodyEl = lastMessage.children.find(c => c.className === 'message-body');
  assert.ok(bodyEl, 'body element should exist');
  
  // With our fix, a 50-line unfenced text block from 'user' should be wrapped in a code-block-wrapper
  const codeBlockWrapper = bodyEl!.children.find(c => c.className === 'code-block-wrapper');
  assert.ok(codeBlockWrapper, 'User message > 15 lines should be rendered inside a code-block-wrapper so it collapses');
  
  const header = codeBlockWrapper!.children.find(c => c.className === 'code-block-header');
  assert.ok(header, 'code block should have a header');
  
  const langSpan = header!.children[0];
  // Verify label contains "lines pasted"
  assert.ok(langSpan.textContent.includes('lines pasted'), `Expected label to contain "lines pasted", got "${langSpan.textContent}"`);
});

test('User Message Collapsing: Long forwarded reviewer feedback renders collapsed with working expand/collapse toggle', () => {
  const { appendMessage } = require('../src/webview/ui/main');
  
  const reviewerLines = [
    'Reviewer feedback on authentication implementation:',
    '1. Potential vulnerability in token validation logic.',
    '2. Missing expiration check on cached credentials.',
    ...Array.from({ length: 27 }, (_, i) => `- Observation ${i + 3}: Consider adding automated test case ${i + 3}`)
  ];
  const feedbackContent = reviewerLines.join('\n');
  assert.strictEqual(reviewerLines.length, 30);
  
  appendMessage('user', feedbackContent, undefined, false, 'user-reviewer-feedback-msg');
  
  const messagesContainer = mockDocument.getElementById('messages-container');
  const lastMessage = messagesContainer!.children[messagesContainer!.children.length - 1];
  assert.strictEqual(lastMessage.className, 'message user');
  
  const bodyEl = lastMessage.children.find(c => c.className === 'message-body');
  assert.ok(bodyEl, 'message-body should exist');
  
  // Verify collapsed wrapper is rendered
  const codeBlockWrapper = bodyEl!.children.find(c => c.className === 'code-block-wrapper');
  assert.ok(codeBlockWrapper, 'Long forwarded reviewer feedback must render inside code-block-wrapper');
  
  const header = codeBlockWrapper!.children.find(c => c.className === 'code-block-header');
  assert.ok(header, 'Header must exist');
  
  // Verify label format for reviewer feedback
  const langSpan = header!.children[0];
  assert.strictEqual(langSpan.textContent, 'Forwarded reviewer feedback — 30 lines');
  
  // Verify expand/collapse toggle button
  const actions = header!.children[1];
  const toggleBtn = actions.children.find(c => c.textContent === 'Expand' || c.textContent === 'Collapse');
  assert.ok(toggleBtn, 'Toggle button must exist in header actions');
  assert.strictEqual(toggleBtn!.textContent, 'Expand', 'Must be collapsed by default with Expand label');
  
  // Click Expand
  toggleBtn!.click();
  assert.strictEqual(toggleBtn!.textContent, 'Collapse', 'Toggle button must change to Collapse after click');
  
  // Click Collapse again
  toggleBtn!.click();
  assert.strictEqual(toggleBtn!.textContent, 'Expand', 'Toggle button must revert to Expand');
});

test('User Message Collapsing: Short user message does NOT collapse and renders directly in message body', () => {
  const { appendMessage } = require('../src/webview/ui/main');
  
  const shortMessage = 'Can you explain how the authentication middleware functions?';
  appendMessage('user', shortMessage, undefined, false, 'short-user-msg');
  
  const messagesContainer = mockDocument.getElementById('messages-container');
  const lastMessage = messagesContainer!.children[messagesContainer!.children.length - 1];
  assert.strictEqual(lastMessage.className, 'message user');
  
  const bodyEl = lastMessage.children.find(c => c.className === 'message-body');
  assert.ok(bodyEl, 'message-body should exist');
  
  // Verify NO code-block-wrapper is rendered for short messages
  const codeBlockWrapper = bodyEl!.children.find(c => c.className === 'code-block-wrapper');
  assert.strictEqual(codeBlockWrapper, undefined, 'Short user message must NOT render inside code-block-wrapper');
});

test('User Message Collapsing: Full content is preserved in message dataset and HistoryStore contract', () => {
  const { appendMessage } = require('../src/webview/ui/main');
  
  const longPastedText = Array.from({ length: 40 }, (_, i) => `config.property.${i} = value_${i};`).join('\n');
  appendMessage('user', longPastedText, undefined, false, 'msg-uncollapsed-integrity');
  
  const messagesContainer = mockDocument.getElementById('messages-container');
  const lastMessage = messagesContainer!.children[messagesContainer!.children.length - 1];
  
  // Verify rawContent dataset stores the full, untruncated content
  assert.strictEqual(
    lastMessage.dataset.rawContent,
    longPastedText,
    'Message element dataset.rawContent must retain the exact 100% full content regardless of UI collapse'
  );
});

test('User Message Collapsing: Collapsed state is independent per message', () => {
  const { appendMessage } = require('../src/webview/ui/main');
  
  const msg1Text = Array.from({ length: 25 }, (_, i) => `msg1 line ${i}`).join('\n');
  const msg2Text = Array.from({ length: 25 }, (_, i) => `msg2 line ${i}`).join('\n');
  
  appendMessage('user', msg1Text, undefined, false, 'indep-msg-1');
  const messagesContainer = mockDocument.getElementById('messages-container')!;
  const msg1 = messagesContainer.children[messagesContainer.children.length - 1];
  
  appendMessage('user', msg2Text, undefined, false, 'indep-msg-2');
  const msg2 = messagesContainer.children[messagesContainer.children.length - 1];
  
  const wrapper1 = msg1.children.find(c => c.className === 'message-body')!.children.find(c => c.className === 'code-block-wrapper')!;
  const wrapper2 = msg2.children.find(c => c.className === 'message-body')!.children.find(c => c.className === 'code-block-wrapper')!;
  
  const toggle1 = wrapper1.children[0].children[1].children.find((c: any) => c.textContent === 'Expand' || c.textContent === 'Collapse')!;
  const toggle2 = wrapper2.children[0].children[1].children.find((c: any) => c.textContent === 'Expand' || c.textContent === 'Collapse')!;
  
  assert.strictEqual(toggle1.textContent, 'Expand');
  assert.strictEqual(toggle2.textContent, 'Expand');
  
  // Expand only message 1
  toggle1.click();
  assert.strictEqual(toggle1.textContent, 'Collapse');
  assert.strictEqual(toggle2.textContent, 'Expand', 'Expanding message 1 must not expand message 2');
  
  // Expand message 2
  toggle2.click();
  assert.strictEqual(toggle1.textContent, 'Collapse');
  assert.strictEqual(toggle2.textContent, 'Collapse');
});

test('Main Chat Input: Renders file attachment button and routes dropped files to attachments bar', () => {
  const { OpenRouterPanelProvider } = require('../src/webview/panelProvider');
  const mockWebview = {
    asWebviewUri: (uri: any) => uri.toString(),
    cspSource: 'https:',
  };
  const provider = new OpenRouterPanelProvider({ fsPath: 'C:/mock/extension' } as any);
  const html = (provider as any)._getHtmlForWebview(mockWebview);

  assert.ok(html.includes('id="attach-file-btn"'), 'Main chat markup must render #attach-file-btn');
  assert.ok(html.includes('id="doc-file-input"'), 'Main chat markup must render #doc-file-input');
  assert.ok(html.includes('id="upload-img-btn"'), 'Main chat markup must render #upload-img-btn');

  const { createChatInputController } = require('../src/webview/ui/main');

  const textarea = new MockElement('textarea');
  const inputBoxWrapper = new MockElement('div');
  const attachmentBar = new MockElement('div');
  const viewChat = new MockElement('div');

  const controller = createChatInputController({
    textarea: textarea as any,
    inputBoxWrapper: inputBoxWrapper as any,
    attachmentBar: attachmentBar as any,
    dropZone: viewChat as any,
    onSend: () => {},
  });

  // Verify dropZone (viewChat) has listeners
  assert.ok(viewChat.events['dragenter'], 'viewChat must have dragenter listener');
  assert.ok(viewChat.events['dragover'], 'viewChat must have dragover listener');
  assert.ok(viewChat.events['dragleave'], 'viewChat must have dragleave listener');
  assert.ok(viewChat.events['drop'], 'viewChat must have drop listener');

  // Drag over viewChat sets drag-over class and dropEffect
  let prevented = false;
  const dragEvent: any = {
    preventDefault: () => { prevented = true; },
    stopPropagation: () => {},
    dataTransfer: { dropEffect: 'none' },
  };
  viewChat.events['dragenter'](dragEvent);
  assert.strictEqual(inputBoxWrapper.classList.contains('drag-over'), true);
  assert.strictEqual(dragEvent.dataTransfer.dropEffect, 'copy');
  assert.strictEqual(prevented, true);

  // Drop onto viewChat
  const dropEvent: any = {
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: {
      files: [
        { name: 'document.txt', data: 'hello world', type: 'text/plain' },
        { name: 'screenshot.png', data: 'data:image/png;base64,123', type: 'image/png' },
      ],
    },
  };
  viewChat.events['drop'](dropEvent);
  assert.strictEqual(inputBoxWrapper.classList.contains('drag-over'), false, 'drop must remove drag-over class');

  const atts = controller.getAttachments();
  assert.strictEqual(atts.length, 2, 'Controller must have 2 attachments');
  assert.strictEqual(atts[0].name, 'document.txt');
  assert.strictEqual(atts[0].isImage, false);
  assert.strictEqual(atts[1].name, 'screenshot.png');
  assert.strictEqual(atts[1].isImage, true);
});

test('Reviewer Feedback Attachment: controller adds reviewer chip and deduplicates', () => {
  const { createChatInputController } = require('../src/webview/ui/main');
  const textarea = new MockElement('textarea') as any;
  const inputBoxWrapper = new MockElement('div') as any;
  const attachmentBar = new MockElement('div') as any;

  const controller = createChatInputController({
    textarea,
    inputBoxWrapper,
    attachmentBar,
    onSend: () => {},
  });

  controller.addAttachment('Reviewer Feedback: "Fix memory leak..."', 'Detailed leak report', false, false, undefined, false, true);

  const atts = controller.getAttachments();
  assert.strictEqual(atts.length, 1);
  assert.strictEqual(atts[0].isReviewerFeedback, true);
  assert.strictEqual(atts[0].data, 'Detailed leak report');
  assert.ok(attachmentBar.children.length > 0);
  assert.ok(attachmentBar.children[0].className.includes('reviewer-chip'));

  // Deduplicate identical reviewer feedback
  controller.addAttachment('Reviewer Feedback: "Fix memory leak..."', 'Detailed leak report', false, false, undefined, false, true);
  assert.strictEqual(controller.getAttachments().length, 1, 'Duplicate reviewer feedback must not be added');
});

test('Reviewer Feedback Attachment: appendMessage does NOT render reviewer feedback attachment in chat bubble', () => {
  const { appendMessage } = require('../src/webview/ui/main');

  const rawModelPayload = `<!-- reviewer-feedback:start -->\n[Reviewer Feedback]:\nPotential security vulnerability in auth header parser.\n<!-- reviewer-feedback:end -->\n\nPlease fix the auth header parser.`;

  appendMessage('user', rawModelPayload);

  const messagesContainer = mockDocument.getElementById('messages-container')!;
  const lastMsg = messagesContainer.children[messagesContainer.children.length - 1];
  assert.ok(lastMsg);

  const bodyEl = lastMsg.querySelector('.message-body') as MockElement;
  assert.ok(bodyEl, 'message body must exist');

  function getAllText(el: MockElement): string {
    let result = el.textContent || '';
    for (const child of el.children) {
      result += ' ' + getAllText(child);
    }
    return result;
  }

  const allBodyText = getAllText(bodyEl);
  // Verify that the reviewer feedback context is NOT rendered in the user message bubble
  assert.strictEqual(allBodyText.includes('Potential security vulnerability'), false, 'Reviewer feedback attachment content must NOT be rendered in user chat bubble');
  assert.ok(allBodyText.includes('Please fix the auth header parser'), 'User typed instructions must be rendered');
});

test('Undo reattachment: extractAttachmentsAndPrompt extracts file, quote, reviewer, and image', () => {
  const { extractAttachmentsAndPrompt } = require('../src/webview/ui/main');

  const content = `<!-- reviewer-feedback:start -->\n[Reviewer Feedback]:\nConsider edge case handling.\n<!-- reviewer-feedback:end -->\n\n> const existing = 123;\n\n\`\`\`helper.ts\nexport const add = (a: number, b: number) => a + b;\n\`\`\`\n\nCan you optimize this function?`;

  const images = [{ name: 'diagram.png', dataUrl: 'data:image/png;base64,abc123' }];

  const result = extractAttachmentsAndPrompt(content, images);

  assert.strictEqual(result.cleanText, 'Can you optimize this function?');
  assert.strictEqual(result.attachments.length, 4);

  const reviewerAtt = result.attachments.find((a: any) => a.isReviewerFeedback);
  assert.ok(reviewerAtt);
  assert.strictEqual(reviewerAtt.data, 'Consider edge case handling.');

  const quoteAtt = result.attachments.find((a: any) => a.isQuote);
  assert.ok(quoteAtt);
  assert.strictEqual(quoteAtt.data, 'const existing = 123;');

  const fileAtt = result.attachments.find((a: any) => a.name === 'helper.ts');
  assert.ok(fileAtt);
  assert.strictEqual(fileAtt.isImage, false);
  assert.ok(fileAtt.data.includes('export const add'));

  const imgAtt = result.attachments.find((a: any) => a.isImage);
  assert.ok(imgAtt);
  assert.strictEqual(imgAtt.name, 'diagram.png');
  assert.strictEqual(imgAtt.data, 'data:image/png;base64,abc123');
});

test('Undo reattachment: appendMessage stores userTypedText and attachments in dataset and map', () => {
  const { appendMessage, messageAttachmentsMap } = require('../src/webview/ui/main');

  const messageId = 'test-msg-123';
  const userTypedText = 'Refactor this module';
  const attachments = [
    {
      id: 'att-1',
      name: 'foo.ts',
      data: 'console.log("test");',
      isImage: false,
    },
  ];

  appendMessage(
    'user',
    '```foo.ts\nconsole.log("test");\n```\n\nRefactor this module',
    undefined,
    false,
    messageId,
    undefined,
    undefined,
    undefined,
    false,
    userTypedText,
    attachments
  );

  const messagesContainer = mockDocument.getElementById('messages-container')!;
  const msgEl = messagesContainer.children[messagesContainer.children.length - 1];
  assert.ok(msgEl);
  assert.strictEqual(msgEl.dataset.userTypedText, userTypedText);
  assert.ok(msgEl.dataset.attachments);

  const inMap = messageAttachmentsMap.get(messageId);
  assert.ok(inMap);
  assert.strictEqual(inMap.typedText, userTypedText);
  assert.strictEqual(inMap.attachments.length, 1);
  assert.strictEqual(inMap.attachments[0].name, 'foo.ts');
});

test('Model Display Name: getModelDisplayName formats model ID or returns friendly name', () => {
  const { getModelDisplayName } = require('../src/webview/ui/main');
  assert.strictEqual(getModelDisplayName(''), 'OpenRouter');
  assert.strictEqual(getModelDisplayName(undefined), 'OpenRouter');
  assert.strictEqual(getModelDisplayName('anthropic/claude-3.5-sonnet'), 'claude-3.5-sonnet');
  assert.strictEqual(getModelDisplayName('openai/gpt-4o'), 'gpt-4o');
});

test('Model Role Tag: appendMessage renders model name instead of generic OpenRouter', () => {
  const { appendMessage } = require('../src/webview/ui/main');
  const messagesContainer = mockDocument.getElementById('messages-container')!;
  const countBefore = messagesContainer.children.length;

  appendMessage(
    'assistant',
    'Hello from Claude!',
    undefined,
    false,
    'msg-model-test-1',
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    'anthropic/claude-3.5-sonnet'
  );

  assert.strictEqual(messagesContainer.children.length, countBefore + 1);
  const msgEl = messagesContainer.children[messagesContainer.children.length - 1]!;
  const roleTag = msgEl.querySelector('.role-tag')!;
  assert.ok(roleTag, 'Role tag must exist in message header');
  assert.strictEqual(roleTag.textContent, 'claude-3.5-sonnet');
  assert.strictEqual(roleTag.title, 'anthropic/claude-3.5-sonnet');
});

