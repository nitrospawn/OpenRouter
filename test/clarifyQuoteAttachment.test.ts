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
  public style: any = {};
  public children: MockElement[] = [];
  public events: Record<string, Function> = {};
  public dataset: Record<string, string> = {};
  public value: string = '';
  public disabled: boolean = false;
  public title: string = '';
  public classList = {
    classes: new Set<string>(),
    add: (c: string) => { this.classList.classes.add(c); this.className = Array.from(this.classList.classes).join(' '); },
    remove: (c: string) => { this.classList.classes.delete(c); this.className = Array.from(this.classList.classes).join(' '); },
    contains: (c: string) => this.classList.classes.has(c),
  };

  constructor(tagName: string = 'div') {
    this.tagName = tagName;
  }

  appendChild(child: MockElement) {
    this.children.push(child);
  }

  addEventListener(event: string, callback: Function) {
    this.events[event] = callback;
  }

  querySelector(selector: string): MockElement | undefined {
    for (const child of this.children) {
      if (child.tagName === selector || (selector.startsWith('.') && child.className.includes(selector.substring(1)))) {
        return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return undefined;
  }
}

// Replicate controller attachment logic
interface ChatInputAttachment {
  id: string;
  name: string;
  data: string;
  isImage: boolean;
  isArtifact?: boolean;
  artifactType?: 'plan' | 'walkthrough';
  isQuote?: boolean;
}

function assemblePrompt(
  userInput: string,
  attachments: ChatInputAttachment[]
): string {
  let text = userInput.trim();
  const quoteAttachments: string[] = [];

  attachments.forEach((att) => {
    if (att.isQuote) {
      quoteAttachments.push(att.data);
    } else if (!att.isImage) {
      const formatted = `\n\`\`\`${att.name}\n${att.data}\n\`\`\`\n`;
      text = text ? text.trimEnd() + formatted : formatted.trimStart();
    }
  });

  if (quoteAttachments.length > 0) {
    const quotedBlocks = quoteAttachments
      .map((quote) =>
        quote
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      )
      .join('\n\n');

    if (text) {
      text = `${quotedBlocks}\n\n${text}`;
    } else {
      const fallbackQuery =
        quoteAttachments.length > 1
          ? 'Can you clarify these points?'
          : 'Can you clarify this?';
      text = `${quotedBlocks}\n\n${fallbackQuery}`;
    }
  }

  return text;
}

test('Clarify Quote: Single quote with custom user question formats as blockquote without boilerplate', () => {
  const quote: ChatInputAttachment = {
    id: '1',
    name: 'Quote: "const x = 1..."',
    data: 'const x = 1;',
    isImage: false,
    isQuote: true,
  };

  const result = assemblePrompt('Why is x initialized to 1?', [quote]);
  assert.strictEqual(
    result,
    '> const x = 1;\n\nWhy is x initialized to 1?'
  );
  assert.ok(!result.includes('Can you clarify:'));
});

test('Clarify Quote: Single quote with empty user input triggers smart fallback', () => {
  const quote: ChatInputAttachment = {
    id: '1',
    name: 'Quote: "const x = 1..."',
    data: 'const x = 1;',
    isImage: false,
    isQuote: true,
  };

  const result = assemblePrompt('', [quote]);
  assert.strictEqual(
    result,
    '> const x = 1;\n\nCan you clarify this?'
  );
});

test('Clarify Quote: Multiple stacked quotes with custom user input', () => {
  const quotes: ChatInputAttachment[] = [
    {
      id: '1',
      name: 'Quote: "tokenExpiry = 24h"',
      data: "tokenExpiry = '24h'",
      isImage: false,
      isQuote: true,
    },
    {
      id: '2',
      name: 'Quote: "maxAge = 1h"',
      data: "maxAge = '1h'",
      isImage: false,
      isQuote: true,
    },
  ];

  const result = assemblePrompt('Why do these durations differ?', quotes);
  assert.strictEqual(
    result,
    "> tokenExpiry = '24h'\n\n> maxAge = '1h'\n\nWhy do these durations differ?"
  );
});

test('Clarify Quote: Multiple stacked quotes with empty input triggers plural smart fallback', () => {
  const quotes: ChatInputAttachment[] = [
    {
      id: '1',
      name: 'Quote: "first snippet"',
      data: 'first snippet',
      isImage: false,
      isQuote: true,
    },
    {
      id: '2',
      name: 'Quote: "second snippet"',
      data: 'second snippet',
      isImage: false,
      isQuote: true,
    },
  ];

  const result = assemblePrompt('', quotes);
  assert.strictEqual(
    result,
    '> first snippet\n\n> second snippet\n\nCan you clarify these points?'
  );
});

test('Clarify Quote: Duplicate quote detection prevents adding identical quote twice', () => {
  let attachmentsList: ChatInputAttachment[] = [];

  function addAttachment(name: string, data: string, isQuote?: boolean) {
    if (isQuote && attachmentsList.some((a) => a.isQuote && a.data === data)) {
      return;
    }
    attachmentsList.push({
      id: String(attachmentsList.length + 1),
      name,
      data,
      isImage: false,
      isQuote,
    });
  }

  addAttachment('Quote: "snippet A"', 'snippet A', true);
  assert.strictEqual(attachmentsList.length, 1);

  // Attempt duplicate
  addAttachment('Quote: "snippet A"', 'snippet A', true);
  assert.strictEqual(attachmentsList.length, 1, 'Duplicate quote should not be added');

  // Distinct quote
  addAttachment('Quote: "snippet B"', 'snippet B', true);
  assert.strictEqual(attachmentsList.length, 2, 'Distinct quote should be added');
});

function assembleReviewerPrompt(
  userInput: string,
  attachments: ChatInputAttachment[],
  attachedArtifact?: { content: string; type: 'plan' | 'walkthrough' }
): string {
  let text = userInput.trim();
  const quoteAttachments: string[] = [];

  attachments.forEach((att) => {
    if (att.isQuote) {
      quoteAttachments.push(att.data);
    } else if (!att.isImage && !att.isArtifact) {
      const formatted = `\n\`\`\`${att.name}\n${att.data}\n\`\`\`\n`;
      text = text ? text.trimEnd() + formatted : formatted.trimStart();
    }
  });

  if (quoteAttachments.length > 0) {
    const quotedBlocks = quoteAttachments
      .map((quote) =>
        quote
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      )
      .join('\n\n');

    if (text) {
      text = `${quotedBlocks}\n\n${text}`;
    } else {
      const fallbackQuery =
        quoteAttachments.length > 1
          ? 'Can you clarify these points?'
          : 'Can you clarify this?';
      text = `${quotedBlocks}\n\n${fallbackQuery}`;
    }
  }

  const defaultPrompt = attachedArtifact
    ? (attachedArtifact.type === 'walkthrough' ? 'Please review these Results docs.' : 'Please review these Plan docs.')
    : '';
  return text || defaultPrompt || 'Please review';
}

test('Reviewer Clarify: Empty input with quote takes precedence over artifact default prompt', () => {
  const quote: ChatInputAttachment = {
    id: '1',
    name: 'Quote: "Consider SQLite instead"',
    data: 'Consider SQLite instead',
    isImage: false,
    isQuote: true,
  };
  const artifact = { content: 'Plan document...', type: 'plan' as const };

  const result = assembleReviewerPrompt('', [quote], artifact);
  assert.strictEqual(
    result,
    '> Consider SQLite instead\n\nCan you clarify this?'
  );
  assert.ok(!result.includes('Please review these Plan docs.'));
});

test('Reviewer Clarify: Custom input with quote in Reviewer combines cleanly with artifact active', () => {
  const quote: ChatInputAttachment = {
    id: '1',
    name: 'Quote: "Consider SQLite instead"',
    data: 'Consider SQLite instead',
    isImage: false,
    isQuote: true,
  };
  const artifact = { content: 'Plan document...', type: 'plan' as const };

  const result = assembleReviewerPrompt('Why SQLite over PostgreSQL here?', [quote], artifact);
  assert.strictEqual(
    result,
    '> Consider SQLite instead\n\nWhy SQLite over PostgreSQL here?'
  );
});

test('Clarify Quote: Sequential numbering increments (Quote 1, Quote 2) and re-indexes on removal', () => {
  let attachmentsList: ChatInputAttachment[] = [];

  function getRenderedNames() {
    let quoteIndex = 0;
    return attachmentsList.map((att) => {
      if (att.isQuote) {
        quoteIndex++;
        return att.name.replace(/^Quote(?:\s*\d+)?:/i, `Quote ${quoteIndex}:`);
      }
      return att.name;
    });
  }

  // Add 3 quotes
  attachmentsList.push(
    { id: '1', name: 'Quote 1: "first snippet"', data: 'first snippet', isImage: false, isQuote: true },
    { id: '2', name: 'Quote 2: "second snippet"', data: 'second snippet', isImage: false, isQuote: true },
    { id: '3', name: 'Quote 3: "third snippet"', data: 'third snippet', isImage: false, isQuote: true }
  );

  assert.deepStrictEqual(getRenderedNames(), [
    'Quote 1: "first snippet"',
    'Quote 2: "second snippet"',
    'Quote 3: "third snippet"',
  ]);

  // Remove Quote 2
  attachmentsList = attachmentsList.filter((a) => a.id !== '2');

  // Verify Quote 3 dynamically becomes Quote 2 without gaps
  assert.deepStrictEqual(getRenderedNames(), [
    'Quote 1: "first snippet"',
    'Quote 2: "third snippet"',
  ]);
});
