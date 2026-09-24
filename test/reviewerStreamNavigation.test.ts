import test from 'node:test';
import * as assert from 'node:assert';
import {
  shouldSwitchDirectToReviewer,
  setReviewerButtonActivity,
  preserveStreamingElements,
} from '../src/webview/ui/reviewerNavigation';
import {
  ReviewerProgressManager,
  MainProgressManager,
} from '../src/webview/ui/agentProgress';

// Minimal DOM mock for Node environment tests
class MockElement {
  public tagName: string;
  private _className: string = '';
  get className(): string {
    return this._className;
  }
  set className(val: string) {
    this._className = val;
    this.classList.classes = new Set(val ? val.split(/\s+/).filter(Boolean) : []);
  }

  public textContent: string = '';
  public parentNode: MockElement | null = null;
  public children: MockElement[] = [];
  public events: Record<string, Function[]> = {};
  public styleProps: Record<string, string> = {};

  public classList = {
    classes: new Set<string>(),
    add: (c: string) => {
      this.classList.classes.add(c);
      this._className = Array.from(this.classList.classes).join(' ');
    },
    remove: (c: string) => {
      this.classList.classes.delete(c);
      this._className = Array.from(this.classList.classes).join(' ');
    },
    contains: (c: string) => this.classList.classes.has(c),
  };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(child: MockElement) {
    child.parentNode = this;
    this.children.push(child);
  }

  insertBefore(newChild: MockElement, refChild: MockElement) {
    const idx = this.children.indexOf(refChild);
    if (idx !== -1) {
      newChild.parentNode = this;
      this.children.splice(idx, 0, newChild);
    } else {
      this.appendChild(newChild);
    }
  }

  removeChild(child: MockElement) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      if (this.classList.contains(cls)) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  get innerHTML(): string {
    return this.children.map((c) => `<${c.tagName}>${c.textContent}</${c.tagName}>`).join('');
  }

  set innerHTML(val: string) {
    if (val === '') {
      for (const child of this.children) {
        child.parentNode = null;
      }
      this.children = [];
    }
  }

  get style() {
    return {
      setProperty: (prop: string, val: string) => {
        this.styleProps[prop] = val;
      },
      removeProperty: (prop: string) => {
        delete this.styleProps[prop];
      },
      getPropertyValue: (prop: string) => this.styleProps[prop] || '',
    };
  }
}

// Setup global document mock for pill / progress manager creation
(global as any).document = {
  createElement: (tag: string) => new MockElement(tag),
};

test('shouldSwitchDirectToReviewer: cold open triggers OPEN_DIRECT_REVIEWER', () => {
  const res = shouldSwitchDirectToReviewer({
    hasStreamingAssistant: false,
    hasProgressManager: false,
    activeSessionId: '',
  });
  assert.strictEqual(res, false, 'Cold open with no active session or stream should not switch direct');
});

test('shouldSwitchDirectToReviewer: switches direct when reviewer assistant is actively streaming', () => {
  const res = shouldSwitchDirectToReviewer({
    hasStreamingAssistant: true,
    hasProgressManager: false,
    activeSessionId: '',
  });
  assert.strictEqual(res, true, 'Active streaming assistant must switch direct locally without reloading');
});

test('shouldSwitchDirectToReviewer: switches direct when progress manager is active', () => {
  const res = shouldSwitchDirectToReviewer({
    hasStreamingAssistant: false,
    hasProgressManager: true,
    activeSessionId: '',
  });
  assert.strictEqual(res, true, 'Active reviewer progress manager must switch direct locally');
});

test('shouldSwitchDirectToReviewer: switches direct when a session is already loaded in memory', () => {
  const res = shouldSwitchDirectToReviewer({
    hasStreamingAssistant: false,
    hasProgressManager: false,
    activeSessionId: 'sess-reviewer-42',
  });
  assert.strictEqual(res, true, 'Loaded session must switch direct locally to preserve scroll and draft');
});

test('setReviewerButtonActivity: adds and removes reviewer-streaming-active class', () => {
  const btn = new MockElement('button') as any;

  setReviewerButtonActivity(btn, true);
  assert.strictEqual(btn.classList.contains('reviewer-streaming-active'), true);

  setReviewerButtonActivity(btn, false);
  assert.strictEqual(btn.classList.contains('reviewer-streaming-active'), false);

  // Safe with null
  assert.doesNotThrow(() => setReviewerButtonActivity(null, true));
  assert.doesNotThrow(() => setReviewerButtonActivity(null, false));
});

test('preserveStreamingElements: retains pill and assistant bubble across session history re-render', () => {
  const container = new MockElement('div') as any;

  // Simulate existing turn in container
  const oldTurn = new MockElement('div') as any;
  oldTurn.textContent = 'Prior turn';
  container.appendChild(oldTurn);

  // Simulate in-flight pill and assistant bubble
  const pill = new MockElement('div') as any;
  pill.className = 'agent-step-pill';
  container.appendChild(pill);

  const bubble = new MockElement('div') as any;
  bubble.className = 'message assistant';
  bubble.textContent = 'Streaming partial text...';
  container.appendChild(bubble);

  assert.strictEqual(container.children.length, 3);

  // Simulate preserveStreamingElements running when REVIEWER_VIEW_DATA arrives
  preserveStreamingElements(container, pill, bubble, () => {
    const reloadedTurn = new MockElement('div') as any;
    reloadedTurn.textContent = 'Prior turn (from disk)';
    container.appendChild(reloadedTurn);
  });

  // Container must now have: reloaded turn, preserved pill, and preserved bubble
  assert.strictEqual(container.children.length, 3);
  assert.strictEqual(container.children[0].textContent, 'Prior turn (from disk)');
  assert.strictEqual(container.children[1], pill);
  assert.strictEqual(container.children[2], bubble);
  assert.strictEqual(bubble.parentNode, container);
  assert.strictEqual(pill.parentNode, container);
});

test('preserveStreamingElements: handles null pill or bubble gracefully', () => {
  const container = new MockElement('div') as any;

  preserveStreamingElements(container, null, null, () => {
    const turn = new MockElement('div') as any;
    turn.textContent = 'Turn 1';
    container.appendChild(turn);
  });

  assert.strictEqual(container.children.length, 1);
  assert.strictEqual(container.children[0].textContent, 'Turn 1');
});

test('ReviewerProgressManager & MainProgressManager: expose getPillElement() during lifecycle', () => {
  const container = new MockElement('div') as any;
  const bubble = new MockElement('div') as any;
  container.appendChild(bubble);

  const mainMgr = new MainProgressManager(container, bubble);
  const mainPill = mainMgr.getPillElement();
  assert.ok(mainPill, 'MainProgressManager should expose pill element');
  assert.strictEqual(mainPill?.classList.contains('agent-step-pill'), true);

  mainMgr.cleanupImmediate();
  assert.strictEqual(mainMgr.getPillElement(), null, 'Pill should be null after cleanup');

  const reviewerContainer = new MockElement('div') as any;
  const reviewerMgr = new ReviewerProgressManager(reviewerContainer);
  const reviewerPill = reviewerMgr.getPillElement();
  assert.ok(reviewerPill, 'ReviewerProgressManager should expose pill element');
  assert.strictEqual(reviewerPill?.classList.contains('agent-step-pill'), true);

  reviewerMgr.cleanupImmediate();
  assert.strictEqual(reviewerMgr.getPillElement(), null, 'Pill should be null after cleanup');
});
