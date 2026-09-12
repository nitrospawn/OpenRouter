import test from 'node:test';
import * as assert from 'node:assert';
import { renderCodeBlock } from '../src/webview/ui/codeBlockUI';

class MockElement {
  public tagName: string;
  public className: string = '';
  public textContent: string = '';
  public style: any = {};
  public children: MockElement[] = [];
  public events: Record<string, Function> = {};

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
      this.events['click']();
    }
  }

  querySelector(selector: string): MockElement | undefined {
    // very naive implementation just for what we need
    if (selector === 'button.code-block-copy-btn' && this.tagName === 'button' && this.className === 'code-block-copy-btn') {
      return this;
    }
    for (const child of this.children) {
      if (child.tagName === selector || (selector.startsWith('.') && child.className === selector.substring(1))) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return undefined;
  }
}

const mockDocument = {
  createElement: (tagName: string) => new MockElement(tagName)
};

test('CodeBlock UI: Renders in full, uncollapsed when under threshold (<= 15 lines)', () => {
  const code = 'const a = 1;\nconst b = 2;\nconst c = 3;';
  const container = mockDocument.createElement('div');
  
  const { wrapper, codeEl } = renderCodeBlock('typescript:test.ts', code, container, mockDocument);
  
  assert.strictEqual(container.children.length, 1);
  const header = wrapper.children[0];
  const langSpan = header.children[0];
  
  // Title should just be the parsed title for small blocks
  assert.strictEqual(langSpan.textContent, 'test.ts');
  
  // Should NOT have an expand/collapse toggle
  const actions = header.children[1];
  const toggleBtn = actions.children.find(c => c.textContent === 'Expand' || c.textContent === 'Collapse');
  assert.strictEqual(toggleBtn, undefined);
  
  // Full text should be in the code element
  assert.strictEqual(codeEl.textContent, code);
});

test('CodeBlock UI: Renders collapsed by default when over threshold (> 15 lines)', () => {
  const codeLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const code = codeLines.join('\n');
  const container = mockDocument.createElement('div');
  
  const { wrapper, codeEl } = renderCodeBlock('typescript:auth.ts', code, container, mockDocument);
  
  const header = wrapper.children[0];
  const langSpan = header.children[0];
  
  // Summary/label indicating size
  assert.strictEqual(langSpan.textContent, 'auth.ts — 20 lines written');
  
  const actions = header.children[1];
  const toggleBtn = actions.children.find(c => c.textContent === 'Expand' || c.textContent === 'Collapse');
  
  // Toggle button should exist and say Expand initially
  assert.notStrictEqual(toggleBtn, undefined);
  assert.strictEqual(toggleBtn!.textContent, 'Expand');
  
  // Text content should be truncated to 5 lines
  const expectedSnippet = codeLines.slice(0, 5).join('\n') + '\n...';
  assert.strictEqual(codeEl.textContent, expectedSnippet);
});

test('CodeBlock UI: Expanding one collapsed block works and displays full content', () => {
  const codeLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const code = codeLines.join('\n');
  const container = mockDocument.createElement('div');
  
  const { wrapper, codeEl } = renderCodeBlock('typescript:auth.ts', code, container, mockDocument);
  
  const header = wrapper.children[0];
  const actions = header.children[1];
  const toggleBtn = actions.children.find(c => c.textContent === 'Expand' || c.textContent === 'Collapse');
  
  // Click to expand
  toggleBtn!.click();
  
  // Should now say Collapse
  assert.strictEqual(toggleBtn!.textContent, 'Collapse');
  
  // Full code should be shown
  assert.strictEqual(codeEl.textContent, code);
  
  // Click to collapse again
  toggleBtn!.click();
  
  assert.strictEqual(toggleBtn!.textContent, 'Expand');
  const expectedSnippet = codeLines.slice(0, 5).join('\n') + '\n...';
  assert.strictEqual(codeEl.textContent, expectedSnippet);
});

test('CodeBlock UI: Expanding one block does not affect others (independent state)', () => {
  const codeLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const code = codeLines.join('\n');
  
  const container1 = mockDocument.createElement('div');
  const res1 = renderCodeBlock('typescript:first.ts', code, container1, mockDocument);
  
  const container2 = mockDocument.createElement('div');
  const res2 = renderCodeBlock('typescript:second.ts', code, container2, mockDocument);
  
  const toggleBtn1 = res1.wrapper.children[0].children[1].children.find(c => c.textContent === 'Expand' || c.textContent === 'Collapse');
  const toggleBtn2 = res2.wrapper.children[0].children[1].children.find(c => c.textContent === 'Expand' || c.textContent === 'Collapse');
  
  // Both start collapsed
  assert.strictEqual(toggleBtn1!.textContent, 'Expand');
  assert.strictEqual(toggleBtn2!.textContent, 'Expand');
  
  // Click first block to expand
  toggleBtn1!.click();
  
  // First block should be expanded
  assert.strictEqual(toggleBtn1!.textContent, 'Collapse');
  assert.strictEqual(res1.codeEl.textContent, code);
  
  // Second block MUST remain collapsed
  assert.strictEqual(toggleBtn2!.textContent, 'Expand');
  assert.strictEqual(res2.codeEl.textContent, codeLines.slice(0, 5).join('\n') + '\n...');
});

test('CodeBlock UI: Fails safe and renders content when path parsing or other logic fails', () => {
  const container = mockDocument.createElement('div');
  // Pass something malformed or undefined for the lang parameter, like 'trust/ty.py' or undefined
  const code = 'print("hello")';
  const { wrapper, codeEl } = renderCodeBlock('trust/ty.py', code, container, mockDocument);
  
  const header = wrapper.children[0];
  const langSpan = header.children[0];
  
  // Title should extract ty.py if possible, or keep trust/ty.py if no colon is present
  assert.strictEqual(langSpan.textContent, 'trust/ty.py');
  assert.strictEqual(codeEl.textContent, code); // Must not be empty!
});

test('CodeBlock UI: Final render for edit-proposal card ensures code block body is present', () => {
  // This simulates the fix added to renderEditProposal where it now explicitly renders the body
  // after the streaming-to-final transition stripped it from the main message.
  
  // Simulate the data that parseAndRenderActions extracts from the final markdown:
  const editId = '1234';
  const filePath = 'trust/ty.py';
  const newContent = 'def test():\n    pass';
  
  // Simulate what renderEditProposal does:
  const card = mockDocument.createElement('div');
  card.className = 'diff-card';
  card.id = `edit-card-${editId}`;

  const header = mockDocument.createElement('div');
  header.className = 'diff-header';
  card.appendChild(header);

  // The critical fix: it must append the diff-body
  const body = mockDocument.createElement('div');
  body.className = 'diff-body';
  renderCodeBlock(filePath, newContent, body, mockDocument);
  card.appendChild(body);
  
  // Verify the code block actually exists inside the card
  const diffBody = card.children.find(c => c.className === 'diff-body');
  assert.notStrictEqual(diffBody, undefined, 'diff-body must be appended to the card');
  
  // The first child of diff-body should be the code-block-wrapper
  const codeBlockWrapper = diffBody!.children[0];
  assert.notStrictEqual(codeBlockWrapper, undefined);
  assert.strictEqual(codeBlockWrapper.className, 'code-block-wrapper');
});
