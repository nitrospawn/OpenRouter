import { test, describe } from 'node:test';
import * as assert from 'node:assert';

describe('Collapsible Proposed Edit Cards & Chronological Ordering', () => {
  interface MockElement {
    className: string;
    id?: string;
    style: Record<string, string>;
    children: MockElement[];
    textContent: string;
    innerHTML: string;
    classList: {
      contains: (cls: string) => boolean;
      add: (cls: string) => void;
      remove: (cls: string) => void;
      toggle: (cls: string) => boolean;
    };
    dataset: Record<string, string>;
    appendChild: (child: MockElement) => MockElement;
    querySelector: (selector: string) => MockElement | null;
    querySelectorAll: (selector: string) => MockElement[];
    addEventListener: (event: string, handler: Function) => void;
  }

  function createMockElement(tag: string): MockElement {
    const classes = new Set<string>();
    const el: MockElement = {
      className: '',
      style: {},
      children: [],
      textContent: '',
      innerHTML: '',
      classList: {
        contains: (cls: string) => classes.has(cls),
        add: (cls: string) => {
          classes.add(cls);
          el.className = Array.from(classes).join(' ');
        },
        remove: (cls: string) => {
          classes.delete(cls);
          el.className = Array.from(classes).join(' ');
        },
        toggle: (cls: string) => {
          if (classes.has(cls)) {
            classes.delete(cls);
            el.className = Array.from(classes).join(' ');
            return false;
          } else {
            classes.add(cls);
            el.className = Array.from(classes).join(' ');
            return true;
          }
        },
      },
      dataset: {},
      appendChild: (child: MockElement) => {
        el.children.push(child);
        return child;
      },
      querySelector: (selector: string) => {
        if (selector.startsWith('.')) {
          const cls = selector.slice(1);
          const find = (node: MockElement): MockElement | null => {
            if (node.classList.contains(cls)) return node;
            for (const c of node.children) {
              const res = find(c);
              if (res) return res;
            }
            return null;
          };
          return find(el);
        }
        return null;
      },
      querySelectorAll: (selector: string) => {
        const results: MockElement[] = [];
        if (selector.startsWith('.')) {
          const cls = selector.slice(1);
          const find = (node: MockElement) => {
            if (node.classList.contains(cls)) results.push(node);
            for (const c of node.children) {
              find(c);
            }
          };
          find(el);
        }
        return results;
      },
      addEventListener: () => {},
    };
    return el;
  }

  // Simulates renderEditProposal logic
  function renderMockEditProposal(
    editId: string,
    filePath: string,
    newContent: string,
    isApplied: boolean = false
  ): { card: MockElement; toggleBtn: MockElement; badge: MockElement } {
    const card = createMockElement('div');
    card.className = 'diff-card collapsed';
    card.id = `edit-card-${editId}`;
    card.classList.add('diff-card');
    card.classList.add('collapsed');

    const lines = newContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const lineCountText = `${lines.length} lines written`;

    const header = createMockElement('div');
    header.className = 'diff-header';

    const left = createMockElement('div');
    left.className = 'diff-header-left';
    left.innerHTML = `Proposed Edit: ${filePath} (${lineCountText})`;
    header.appendChild(left);

    const right = createMockElement('div');
    right.className = 'diff-header-right';

    const badge = createMockElement('div');
    badge.id = `edit-status-${editId}`;
    badge.className = 'diff-status-badge';
    badge.textContent = isApplied ? '✓ Applied' : '⏳ Pending';
    right.appendChild(badge);

    const toggleBtn = createMockElement('button');
    toggleBtn.className = 'diff-toggle-btn';
    toggleBtn.textContent = 'Expand Diff ▾';
    right.appendChild(toggleBtn);

    header.appendChild(right);
    card.appendChild(header);

    const body = createMockElement('div');
    body.className = 'diff-body';
    body.textContent = newContent;
    card.appendChild(body);

    return { card, toggleBtn, badge };
  }

  test('Proposed Edit Cards: initialized in collapsed state by default', () => {
    const { card, toggleBtn } = renderMockEditProposal('edit-1', 'Docs/PRD.md', '<<<< SEARCH\nfoo\n====\nbar\n>>>>');

    assert.strictEqual(card.classList.contains('collapsed'), true, 'Card must be collapsed by default');
    assert.strictEqual(toggleBtn.textContent, 'Expand Diff ▾');
  });

  test('Proposed Edit Cards: clicking toggle expands diff and updates button text', () => {
    const { card, toggleBtn } = renderMockEditProposal('edit-1', 'Docs/PRD.md', '<<<< SEARCH\nfoo\n====\nbar\n>>>>');

    // Expand
    const isNowCollapsed = card.classList.toggle('collapsed');
    toggleBtn.textContent = isNowCollapsed ? 'Expand Diff ▾' : 'Collapse Diff ▴';

    assert.strictEqual(card.classList.contains('collapsed'), false, 'Card must be expanded');
    assert.strictEqual(toggleBtn.textContent, 'Collapse Diff ▴');

    // Collapse back
    const isCollapsedAgain = card.classList.toggle('collapsed');
    toggleBtn.textContent = isCollapsedAgain ? 'Expand Diff ▾' : 'Collapse Diff ▴';

    assert.strictEqual(card.classList.contains('collapsed'), true, 'Card must be collapsed again');
    assert.strictEqual(toggleBtn.textContent, 'Expand Diff ▾');
  });

  test('Proposed Edit Cards: applying edit keeps card collapsed and displays ✓ Applied', () => {
    const { card, toggleBtn, badge } = renderMockEditProposal('edit-1', 'Docs/PRD.md', 'some edit', false);

    assert.strictEqual(badge.textContent, '⏳ Pending');

    // Simulate Apply All / EDIT_APPLIED
    card.classList.add('collapsed');
    toggleBtn.textContent = 'Expand Diff ▾';
    badge.textContent = '✓ Applied';

    assert.strictEqual(card.classList.contains('collapsed'), true, 'Card must remain collapsed after apply');
    assert.strictEqual(toggleBtn.textContent, 'Expand Diff ▾');
    assert.strictEqual(badge.textContent, '✓ Applied');
  });

  test('Chronological Flow: edit blocks parsed in-place so concluding summary/plan is last', () => {
    const rawAiResponse = `I will first apply the Android-only updates to the PRD.
\`\`\`edit_file:Docs/PRD.md
<<<< SEARCH
# Cross-platform
====
# Android-only
>>>>
\`\`\`
All Android-only updates are now applied. Here is your Phase 1 implementation plan. Would you like me to proceed?`;

    const fileActionRegex = /(?:```|````)(?:create_file|edit_file|file):([^\r\n]+)\r?\n((?:[\s\S]*?<<<< SEARCH[\s\S]*?\n>>>>[^\r\n]*|[\s\S]*?))\r?\n(?:```|````)/gi;

    const sequence: Array<{ type: 'text' | 'edit_card'; content: string }> = [];
    let lastIndex = 0;
    let match;

    while ((match = fileActionRegex.exec(rawAiResponse)) !== null) {
      const preText = rawAiResponse.slice(lastIndex, match.index);
      if (preText.trim()) {
        sequence.push({ type: 'text', content: preText.trim() });
      }
      sequence.push({ type: 'edit_card', content: match[1].trim() });
      lastIndex = fileActionRegex.lastIndex;
    }

    const remaining = rawAiResponse.slice(lastIndex);
    if (remaining.trim()) {
      sequence.push({ type: 'text', content: remaining.trim() });
    }

    assert.strictEqual(sequence.length, 3);
    assert.strictEqual(sequence[0].type, 'text');
    assert.ok(sequence[0].content.includes('I will first apply'));

    assert.strictEqual(sequence[1].type, 'edit_card');
    assert.strictEqual(sequence[1].content, 'Docs/PRD.md');

    assert.strictEqual(sequence[2].type, 'text');
    assert.ok(sequence[2].content.includes('All Android-only updates are now applied'));
    assert.ok(sequence[2].content.includes('Would you like me to proceed?'), 'Final question must be at the very bottom');
  });
});
