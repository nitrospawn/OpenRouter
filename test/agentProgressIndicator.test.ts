import test from 'node:test';
import * as assert from 'node:assert';
import {
  detectMainAgentStep,
  detectReviewerStep,
  MAIN_AGENT_LABELS,
  REVIEWER_LABELS,
  MainProgressState,
  ReviewerProgressState,
  createStepPill,
  updateStepPillLabel,
  removePillImmediately,
  removePillWithFade,
  BubbleActivityController,
  MainProgressManager,
  ReviewerProgressManager,
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
    newChild.parentNode = this;
    if (idx !== -1) {
      this.children.splice(idx, 0, newChild);
    } else {
      this.children.push(newChild);
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

  addEventListener(event: string, callback: Function) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(callback);
  }

  removeEventListener(event: string, callback: Function) {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter((cb) => cb !== callback);
    }
  }

  dispatchEvent(event: { type: string; propertyName?: string }) {
    const handlers = this.events[event.type] || [];
    for (const h of handlers) {
      h(event);
    }
  }

  querySelector(selector: string): MockElement | undefined {
    for (const child of this.children) {
      if (
        child.tagName.toLowerCase() === selector.toLowerCase() ||
        (selector.startsWith('.') && child.classList.contains(selector.substring(1)))
      ) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return undefined;
  }

  style = {
    setProperty: (prop: string, val: string) => {
      this.styleProps[prop] = val;
    },
    removeProperty: (prop: string) => {
      delete this.styleProps[prop];
    },
    getPropertyValue: (prop: string) => {
      return this.styleProps[prop] || '';
    },
  };
}

// Set up global document and window mocks if not in browser
if (typeof globalThis.document === 'undefined') {
  (globalThis as any).document = {
    createElement: (tag: string) => new MockElement(tag),
  };
}

if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = {
    matchMedia: () => ({ matches: false }),
  };
}

test('Main Chat State: Initial state returns fallback "Working"', () => {
  const state: MainProgressState = {
    phase: 'working',
    prefixLocked: false,
    codeBlockDetected: false,
  };
  const res = detectMainAgentStep('', state);
  assert.strictEqual(res.phase, 'working');
  assert.strictEqual(res.label, 'Working');
  assert.strictEqual(res.changed, false);
});

test('Main Chat State: Detects context resolution keywords in prefix', () => {
  const testKeywords = ['search', 'looking', 'found', 'clarif', 'resolv'];

  for (const kw of testKeywords) {
    const state: MainProgressState = {
      phase: 'working',
      prefixLocked: false,
      codeBlockDetected: false,
    };
    const sample = `I am ${kw}ing the project files for relevant symbols.`;
    const res = detectMainAgentStep(sample, state);
    assert.strictEqual(res.phase, 'context', `Failed to match context keyword: ${kw}`);
    assert.strictEqual(res.label, 'Resolving context');
    assert.strictEqual(state.prefixLocked, true);
  }
});

test('Main Chat State: Detects planning keywords in prefix', () => {
  const testPhrases = ['plan', 'I will', "here's what", 'step 1', 'implementation'];

  for (const phrase of testPhrases) {
    const state: MainProgressState = {
      phase: 'working',
      prefixLocked: false,
      codeBlockDetected: false,
    };
    const sample = `Let's formulate the ${phrase} for this task.`;
    const res = detectMainAgentStep(sample, state);
    assert.strictEqual(res.phase, 'planning', `Failed to match planning phrase: ${phrase}`);
    assert.strictEqual(res.label, 'Drawing up a plan');
    assert.strictEqual(state.prefixLocked, true);
  }
});

test('Main Chat State: Locks prefix after initial match and does not flutter on subsequent prefix text', () => {
  const state: MainProgressState = {
    phase: 'working',
    prefixLocked: false,
    codeBlockDetected: false,
  };

  // First chunk has 'search'
  const res1 = detectMainAgentStep('I am searching for files.', state);
  assert.strictEqual(res1.phase, 'context');
  assert.strictEqual(state.prefixLocked, true);

  // Subsequent chunk contains 'plan' still within first 200 chars
  const res2 = detectMainAgentStep('I am searching for files. Here is the plan now.', state);
  // Must remain locked to context until code block appears
  assert.strictEqual(res2.phase, 'context');
  assert.strictEqual(res2.label, 'Resolving context');
});

test('Main Chat State: Stays at fallback "Working" while text is neutral, transitions to "Drawing up a plan" when ```plan block appears', () => {
  const state: MainProgressState = {
    phase: 'working',
    prefixLocked: false,
    codeBlockDetected: false,
  };

  const longNeutralText = 'A'.repeat(210);
  const res = detectMainAgentStep(longNeutralText, state);
  assert.strictEqual(res.phase, 'working');

  // When ```plan block appears, transitions to planning
  const res2 = detectMainAgentStep(longNeutralText + '\n```plan\n# Plan\n```', state);
  assert.strictEqual(res2.phase, 'planning');
  assert.strictEqual(res2.label, 'Drawing up a plan');
});

test('Main Chat State: Recognizes ```walkthrough block as "Verifying results"', () => {
  const state: MainProgressState = {
    phase: 'writing',
    prefixLocked: true,
    codeBlockDetected: true,
  };

  const stream = '```edit_file:test.ts\ncode\n```\n```walkthrough\n# Results\n```';
  const res = detectMainAgentStep(stream, state);
  assert.strictEqual(res.phase, 'verifying');
  assert.strictEqual(res.label, 'Verifying results');
});

test('Main Chat State: Code block trigger transitions to "Writing changes" regardless of position', () => {
  const state: MainProgressState = {
    phase: 'planning',
    prefixLocked: true,
    codeBlockDetected: false,
  };

  const textWithCode = 'Here is the plan:\n```edit_file:src/index.ts\nconst x = 1;\n```';
  const res = detectMainAgentStep(textWithCode, state);
  assert.strictEqual(res.phase, 'writing');
  assert.strictEqual(res.label, 'Writing changes');
  assert.strictEqual(state.codeBlockDetected, true);

  // Supports bash and create_file as well
  const bashState: MainProgressState = { phase: 'working', prefixLocked: false, codeBlockDetected: false };
  const resBash = detectMainAgentStep('```bash\nnpm run test\n```', bashState);
  assert.strictEqual(resBash.phase, 'writing');

  const createBlockState: MainProgressState = { phase: 'working', prefixLocked: false, codeBlockDetected: false };
  const resCreate = detectMainAgentStep('```create_file:new.txt\nhi\n```', createBlockState);
  assert.strictEqual(resCreate.phase, 'writing');
});

test('Main Chat State: Verification keywords AFTER code block transition to "Verifying results"', () => {
  const state: MainProgressState = {
    phase: 'working',
    prefixLocked: false,
    codeBlockDetected: false,
  };

  let stream = 'Here is my plan.\n';
  detectMainAgentStep(stream, state);

  stream += '```edit_file:src/app.ts\nconst y = 2;\n```\n';
  const resWriting = detectMainAgentStep(stream, state);
  assert.strictEqual(resWriting.phase, 'writing');

  // Stream text after code block with test/verif keywords
  stream += 'Now running diagnostic tests to verify the changes...';
  const resVerify = detectMainAgentStep(stream, state);
  assert.strictEqual(resVerify.phase, 'verifying');
  assert.strictEqual(resVerify.label, 'Verifying results');
});

test('Reviewer State: Prefix keywords detect "Identifying issues", "Formulating feedback", and "Reviewing"', () => {
  // Issues
  const issueState: ReviewerProgressState = { phase: 'reviewing', locked: false };
  const resIssue = detectReviewerStep('I have identified several concerns and a potential bug.', issueState);
  assert.strictEqual(resIssue.phase, 'issues');
  assert.strictEqual(resIssue.label, 'Identifying issues');
  assert.strictEqual(issueState.locked, true);

  // Feedback
  const feedbackState: ReviewerProgressState = { phase: 'reviewing', locked: false };
  const resFeedback = detectReviewerStep('I suggest you consider refactoring this loop.', feedbackState);
  assert.strictEqual(resFeedback.phase, 'feedback');
  assert.strictEqual(resFeedback.label, 'Formulating feedback');
  assert.strictEqual(feedbackState.locked, true);

  // Reviewing
  const reviewState: ReviewerProgressState = { phase: 'reviewing', locked: false };
  const resReview = detectReviewerStep('Let me assess and analyze this pull request.', reviewState);
  assert.strictEqual(resReview.phase, 'reviewing');
  assert.strictEqual(resReview.label, 'Reviewing');
  assert.strictEqual(reviewState.locked, true);
});

test('Reviewer State: Fallback remains "Reviewing" when no keywords match in prefix window', () => {
  const state: ReviewerProgressState = { phase: 'reviewing', locked: false };
  const longText = 'Hello. ' + 'Z'.repeat(360);
  const res = detectReviewerStep(longText, state);
  assert.strictEqual(res.phase, 'reviewing');
  assert.strictEqual(res.label, 'Reviewing');
  assert.strictEqual(state.locked, true);
});

test('DOM Step-Label Pill: Creation, update, and immediate removal', () => {
  const container = new MockElement('div') as any;
  const pill = createStepPill(MAIN_AGENT_LABELS.working);
  container.appendChild(pill);

  assert.strictEqual(container.children.length, 1);
  assert.strictEqual(pill.classList.contains('agent-step-pill'), true);

  const dot = pill.querySelector('.pill-dot');
  const label = pill.querySelector('.pill-label');
  const ellipsis = pill.querySelector('.pill-ellipsis');

  assert.ok(dot, 'Pill dot should exist');
  assert.ok(label, 'Pill label should exist');
  assert.strictEqual(label.textContent, 'Working');
  assert.ok(ellipsis, 'Pill ellipsis should exist');
  assert.strictEqual(ellipsis.textContent, '...');

  // Update label
  updateStepPillLabel(pill, 'Resolving context');
  assert.strictEqual(label.textContent, 'Resolving context');

  // Immediate removal
  removePillImmediately(pill);
  assert.strictEqual(container.children.length, 0);
  assert.strictEqual(pill.parentNode, null);
});

test('DOM Step-Label Pill: Animated fade-out teardown invokes callback only after DOM removal', (t, done) => {
  const container = new MockElement('div') as any;
  const pill = createStepPill('Working');
  container.appendChild(pill);

  let callbackFired = false;
  removePillWithFade(pill, () => {
    callbackFired = true;
    assert.strictEqual(container.children.length, 0, 'Pill must be removed from DOM before callback');
    assert.strictEqual(pill.parentNode, null);
    done();
  });

  assert.strictEqual(pill.classList.contains('pill-fading-out'), true);
  assert.strictEqual(callbackFired, false, 'Callback must not fire before transition completion');

  // Dispatch transitionend for opacity
  pill.dispatchEvent({ type: 'transitionend', propertyName: 'opacity' } as any);
  assert.strictEqual(callbackFired, true);
});

test('BubbleActivityController: Initializes idle pulse and accelerates on chunk arrival', (t, done) => {
  const bubble = new MockElement('div') as any;
  const controller = new BubbleActivityController(bubble);

  assert.strictEqual(bubble.classList.contains('streaming-active'), true);
  assert.strictEqual(bubble.style.getPropertyValue('--streaming-pulse-speed'), '2.2s');

  // Chunk arrives -> switches to fast
  controller.onChunk();
  assert.strictEqual(bubble.style.getPropertyValue('--streaming-pulse-speed'), '0.6s');

  // Wait 450ms -> should reset to idle (2.2s)
  setTimeout(() => {
    assert.strictEqual(bubble.style.getPropertyValue('--streaming-pulse-speed'), '2.2s');

    // Clean up
    controller.cleanup();
    assert.strictEqual(bubble.classList.contains('streaming-active'), false);
    assert.strictEqual(bubble.style.getPropertyValue('--streaming-pulse-speed'), '');
    done();
  }, 450);
});

test('Teardown Invariant: Pill and interrupted badge never coexist in DOM on partial failure', (t, done) => {
  const container = new MockElement('div') as any;
  const bubble = new MockElement('div') as any;
  container.appendChild(bubble);

  const manager = new MainProgressManager(container, bubble);
  assert.strictEqual(container.children.length, 2); // [pill, bubble]

  // Simulate chunk streaming
  manager.onChunk('Here is partial output before network cuts out.');

  let interruptedBadgeMounted = false;
  manager.cleanupWithFade(() => {
    interruptedBadgeMounted = true;
    const badge = new MockElement('div') as any;
    badge.className = 'stream-error-card';
    bubble.appendChild(badge);

    // Invariant verification: pill is gone, only bubble with badge remains
    assert.strictEqual(container.children.length, 1);
    assert.strictEqual(container.children[0], bubble);
    assert.strictEqual(bubble.children.length, 1);
    assert.strictEqual(bubble.children[0].className, 'stream-error-card');
    done();
  });

  // Pill must still be in fading-out state, badge not yet mounted
  assert.strictEqual(interruptedBadgeMounted, false);
  const pillEl = container.children[0];
  assert.strictEqual(pillEl.classList.contains('pill-fading-out'), true);

  // Trigger transition completion
  pillEl.dispatchEvent({ type: 'transitionend', propertyName: 'opacity' });
});

test('MainProgressManager: setStep updates pill label dynamically with live status and detail', () => {
  const container = new MockElement('div') as any;
  const bubble = new MockElement('div') as any;
  container.appendChild(bubble);

  const manager = new MainProgressManager(container, bubble);
  assert.strictEqual(manager.getLabel(), 'Working');

  // Transition to Loading workspace
  manager.setStep('Loading workspace files');
  assert.strictEqual(manager.getLabel(), 'Loading workspace files');
  const pillEl = manager.getPillElement();
  const labelSpan = pillEl?.querySelector('.pill-label');
  assert.strictEqual(labelSpan?.textContent, 'Loading workspace files');

  // Transition to Reading file
  manager.setStep('Reading file', 'orphan_sweep.dart');
  assert.strictEqual(manager.getLabel(), 'Reading file: orphan_sweep.dart');
  assert.strictEqual(labelSpan?.textContent, 'Reading file: orphan_sweep.dart');

  // Transition to Connecting
  manager.setStep('Connecting to model', 'Z.ai: GLM 5.3 Flash');
  assert.strictEqual(manager.getLabel(), 'Connecting to model: Z.ai: GLM 5.3 Flash');

  // Transition to Thinking
  manager.setStep('Thinking');
  assert.strictEqual(manager.getLabel(), 'Thinking');
  assert.strictEqual(labelSpan?.textContent, 'Thinking');

  // Transition to Writing
  manager.setStep('Writing');
  assert.strictEqual(manager.getLabel(), 'Writing');
  assert.strictEqual(labelSpan?.textContent, 'Writing');

  manager.cleanupImmediate();
});

test('ReviewerProgressManager: setStep updates reviewer pill label dynamically', () => {
  const container = new MockElement('div') as any;
  const manager = new ReviewerProgressManager(container);
  assert.strictEqual(manager.getLabel(), 'Reviewing');

  manager.setStep('Inspecting code');
  assert.strictEqual(manager.getLabel(), 'Inspecting code');

  manager.setStep('Formulating feedback', 'performance');
  assert.strictEqual(manager.getLabel(), 'Formulating feedback: performance');

  manager.cleanupImmediate();
});

