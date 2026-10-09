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
    add: (c: string) => {
      this.classList.classes.add(c);
      this.className = Array.from(this.classList.classes).join(' ');
    },
    remove: (c: string) => {
      this.classList.classes.delete(c);
      this.className = Array.from(this.classList.classes).join(' ');
    },
    contains: (c: string) => this.classList.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const shouldAdd = force !== undefined ? force : !this.classList.classes.has(c);
      if (shouldAdd) {
        this.classList.classes.add(c);
      } else {
        this.classList.classes.delete(c);
      }
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

  querySelector(selector: string): MockElement | undefined {
    if (selector === 'span' && this.tagName === 'span') return this;
    for (const child of this.children) {
      if (
        child.tagName === selector ||
        (selector.startsWith('.') && child.className.split(' ').includes(selector.substring(1)))
      ) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return undefined;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    for (const child of this.children) {
      if (
        child.tagName === selector ||
        (selector.startsWith('.') && child.className.split(' ').includes(selector.substring(1)))
      ) {
        results.push(child);
      }
      results.push(...child.querySelectorAll(selector));
    }
    return results;
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
  querySelectorAll: () => [],
};

(global as any).document = mockDocument;
(global as any).window = { addEventListener: () => {} };
(global as any).acquireVsCodeApi = () => ({
  postMessage: () => {},
  getState: () => ({}),
  setState: () => {},
});

Object.defineProperty(global, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  writable: true,
  configurable: true,
});

const { formatExecutionDuration, createDurationBadge, appendMessage } = require('../src/webview/ui/main');

test('formatExecutionDuration: handles invalid and non-positive inputs', () => {
  assert.strictEqual(formatExecutionDuration(undefined), '');
  assert.strictEqual(formatExecutionDuration(null as any), '');
  assert.strictEqual(formatExecutionDuration(NaN), '');
  assert.strictEqual(formatExecutionDuration(0), '');
  assert.strictEqual(formatExecutionDuration(-500), '');
});

test('formatExecutionDuration: formats durations under 60s with exactly 1 decimal place', () => {
  assert.strictEqual(formatExecutionDuration(500), '0.5s');
  assert.strictEqual(formatExecutionDuration(1200), '1.2s');
  assert.strictEqual(formatExecutionDuration(14200), '14.2s');
  assert.strictEqual(formatExecutionDuration(14280), '14.3s');
  assert.strictEqual(formatExecutionDuration(59900), '59.9s');
});

test('formatExecutionDuration: formats durations >= 60s as minutes and seconds', () => {
  assert.strictEqual(formatExecutionDuration(59960), '1m 0s');
  assert.strictEqual(formatExecutionDuration(60000), '1m 0s');
  assert.strictEqual(formatExecutionDuration(65000), '1m 5s');
  assert.strictEqual(formatExecutionDuration(84200), '1m 24s');
  assert.strictEqual(formatExecutionDuration(125000), '2m 5s');
  assert.strictEqual(formatExecutionDuration(3600000), '60m 0s');
});

test('createDurationBadge: creates element with SVG icon and title', () => {
  const badge = createDurationBadge(14200);
  assert.strictEqual(badge.className, 'msg-duration-badge');
  assert.strictEqual(badge.title, 'Generation time: 14.2s');
  assert.ok(badge.innerHTML.includes('14.2s'));
  assert.ok(badge.innerHTML.includes('<svg'));
});

test('Message Header Placement: duration badge is rendered directly before clarify button in assistant messages', () => {
  const container = mockDocument.getElementById('messages-container');
  container.children = [];

  appendMessage('assistant', 'Here is the response.', undefined, false, 'msg-timing-1', undefined, undefined, 14200);

  assert.strictEqual(container.children.length, 1);
  const msgEl = container.children[0];
  const headerActions = msgEl.querySelector('.message-header-actions');
  assert.ok(headerActions, 'message-header-actions must exist');

  // Verify child order: duration badge -> clarify (quoteBtn) -> copy (copyBtn)
  assert.strictEqual(headerActions.children.length >= 3, true, 'headerActions should have duration, clarify, and copy buttons');
  assert.strictEqual(headerActions.children[0].className, 'msg-duration-badge');
  assert.strictEqual(headerActions.children[1].className, 'msg-quote-btn');
  assert.strictEqual(headerActions.children[2].className, 'msg-copy-btn');
});
