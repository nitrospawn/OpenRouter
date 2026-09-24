import test from 'node:test';
import * as assert from 'node:assert';
import { SmartScrollController } from '../src/webview/ui/smartScroll';

class MockScrollElement {
  public scrollTop: number = 0;
  public scrollHeight: number = 1000;
  public clientHeight: number = 400;
  public listeners: Record<string, Function[]> = {};

  public classList = {
    classes: new Set<string>(),
    add: (c: string) => this.classList.classes.add(c),
    remove: (c: string) => this.classList.classes.delete(c),
    contains: (c: string) => this.classList.classes.has(c),
  };

  addEventListener(type: string, handler: Function, _options?: any) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(handler);
  }

  trigger(type: string, eventObj: any = {}) {
    for (const h of this.listeners[type] || []) {
      h(eventObj);
    }
  }
}

test('SmartScrollController: initializes with userScrolledUp = false and keeps scroll button hidden', () => {
  const mockEl = new MockScrollElement();
  mockEl.scrollTop = 600; // 1000 - 600 - 400 = 0 (at bottom)
  const mockBtn = new MockScrollElement();
  mockBtn.classList.add('hidden');

  const controller = new SmartScrollController(mockEl as any, mockBtn as any, 60);

  assert.strictEqual(controller.isUserScrolledUp(), false);
  assert.strictEqual(mockBtn.classList.contains('hidden'), true);
});

test('SmartScrollController: wheel up immediately pauses autoscroll and displays jump-to-bottom button', () => {
  const mockEl = new MockScrollElement();
  mockEl.scrollTop = 600;
  const mockBtn = new MockScrollElement();
  mockBtn.classList.add('hidden');

  const controller = new SmartScrollController(mockEl as any, mockBtn as any, 60);

  // User flicks mouse wheel upwards (deltaY < 0)
  mockEl.trigger('wheel', { deltaY: -50 });

  assert.strictEqual(controller.isUserScrolledUp(), true);
  assert.strictEqual(mockBtn.classList.contains('hidden'), false);

  // Incoming stream chunks should NOT force scroll to bottom while user is looking up
  mockEl.scrollTop = 300;
  mockEl.scrollHeight = 1100;
  controller.scrollToBottomIfAtBottom();

  assert.strictEqual(mockEl.scrollTop, 300, 'scrollTop should remain untouched during streaming when scrolled up');
});

test('SmartScrollController: scroll event detects threshold crossing away from bottom and back to bottom', () => {
  const mockEl = new MockScrollElement();
  mockEl.scrollTop = 600; // at bottom (1000 - 600 - 400 = 0 <= 60)
  const mockBtn = new MockScrollElement();
  mockBtn.classList.add('hidden');

  const controller = new SmartScrollController(mockEl as any, mockBtn as any, 60);

  // User scrolls up past threshold (e.g. scrollTop = 500, dist = 100 > 60)
  mockEl.scrollTop = 500;
  mockEl.trigger('scroll');

  assert.strictEqual(controller.isUserScrolledUp(), true);
  assert.strictEqual(mockBtn.classList.contains('hidden'), false);

  // User scrolls back down near bottom (dist = 10 <= 60)
  mockEl.scrollTop = 590;
  mockEl.trigger('scroll');

  assert.strictEqual(controller.isUserScrolledUp(), false);
  assert.strictEqual(mockBtn.classList.contains('hidden'), true);

  // Incoming chunk autoscrolls cleanly now that user is back at bottom
  mockEl.scrollHeight = 1200;
  controller.scrollToBottomIfAtBottom();
  assert.strictEqual(mockEl.scrollTop, 1200);
});

test('SmartScrollController: clicking jump-to-bottom button force scrolls to bottom and resets state', () => {
  const mockEl = new MockScrollElement();
  mockEl.scrollTop = 200;
  const mockBtn = new MockScrollElement();

  const controller = new SmartScrollController(mockEl as any, mockBtn as any, 60);
  controller.setUserScrolledUp(true);
  assert.strictEqual(controller.isUserScrolledUp(), true);
  assert.strictEqual(mockBtn.classList.contains('hidden'), false);

  // Click scrollBtn
  mockBtn.trigger('click');

  assert.strictEqual(controller.isUserScrolledUp(), false);
  assert.strictEqual(mockBtn.classList.contains('hidden'), true);
  assert.strictEqual(mockEl.scrollTop, mockEl.scrollHeight);
});

test('SmartScrollController: force scrollToBottom(true) resets userScrolledUp and jumps to bottom', () => {
  const mockEl = new MockScrollElement();
  mockEl.scrollTop = 100;
  mockEl.scrollHeight = 1500;
  const mockBtn = new MockScrollElement();

  const controller = new SmartScrollController(mockEl as any, mockBtn as any, 60);
  controller.setUserScrolledUp(true);

  controller.scrollToBottom(true);

  assert.strictEqual(controller.isUserScrolledUp(), false);
  assert.strictEqual(mockEl.scrollTop, 1500);
});
