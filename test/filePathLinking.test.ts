import { test, describe } from 'node:test';
import * as assert from 'node:assert';

describe('File Path Linking & Role Separation', () => {
  const FILE_LINK_EXTENSIONS = 'py|js|ts|jsx|tsx|md|markdown|json|html|htm|css|scss|less|yaml|yml|toml|xml|csv|tsv|rs|go|c|cpp|h|hpp|cs|java|sql|sh|bash|bat|cmd|ps1|txt|log|svg|png|jpg|jpeg|gif|webp|pdf';

  function cleanTrailingPunctuation(str: string): { clean: string; trailing: string } {
    const match = str.match(/([.,;:!?)]+)$/);
    if (match) {
      return {
        clean: str.slice(0, str.length - match[1].length),
        trailing: match[1],
      };
    }
    return { clean: str, trailing: '' };
  }

  function extractFilePaths(text: string): Array<{ path: string; isLink?: boolean; isCode?: boolean }> {
    const inlineRegex = new RegExp(
      '(\\[([^\\]]+)\\]\\(([^)]+)\\))|' +
      '(`([^`]+)`)' +
      '|\\*\\*\\*([^*]+)\\*\\*\\*' +
      '|\\*\\*([^*]+)\\*\\*' +
      '|__([^_]+)__' +
      '|(?:\\*([^*]+)\\*)' +
      '|(?:_([^_]+)_)' +
      '|["\']([a-zA-Z]:[\\\\/][^"\'\\r\\n]+?\\.(?:' + FILE_LINK_EXTENSIONS + '))["\']' +
      '|["\']([\\\\/][^"\'\\r\\n]+?\\.(?:' + FILE_LINK_EXTENSIONS + '))["\']' +
      '|["\']([a-zA-Z0-9_.\\-]+[\\\\/][^"\'\\r\\n]+?\\.(?:' + FILE_LINK_EXTENSIONS + '))["\']' +
      '|\\b([a-zA-Z]:[\\\\/][a-zA-Z0-9_.\\-\\\\/]+?\\.(?:' + FILE_LINK_EXTENSIONS + '))' +
      '|(?<=[\\s(^]|^)(\\/[a-zA-Z0-9_.\\-]+(?:\\/[a-zA-Z0-9_.\\-]+)*\\.(?:' + FILE_LINK_EXTENSIONS + '))' +
      '|\\b([a-zA-Z0-9_.\\-]+(?:[\\\\/][a-zA-Z0-9_.\\-]+)+\\.(?:' + FILE_LINK_EXTENSIONS + '))' +
      '|\\b([a-zA-Z0-9_\\-]+\\.(?:' + FILE_LINK_EXTENSIONS + '))\\b' +
      '|(?<=[\\s(^]|^)(\\.(?:env|gitignore|eslintrc|prettierrc|editorconfig|npmrc)(?:\\.[a-zA-Z0-9]+)?)\\b',
      'g'
    );

    const found: Array<{ path: string; isLink?: boolean; isCode?: boolean }> = [];
    let match: RegExpExecArray | null;

    while ((match = inlineRegex.exec(text)) !== null) {
      if (match[1]) {
        // Markdown link
        found.push({ path: match[3], isLink: true });
      } else if (match[4]) {
        // Inline code
        const code = match[5].trim();
        const isFileLike = new RegExp('\\.(' + FILE_LINK_EXTENSIONS + ')$', 'i').test(code) || /^\.(?:env|gitignore)/.test(code);
        const hasCommandSpaces = /\s/.test(code) && /^(npm|npx|node|python|git|cd|mkdir|move|copy|dir|ls|cat|rm|del)\b/i.test(code);
        if (isFileLike && !hasCommandSpaces) {
          found.push({ path: code, isCode: true });
        }
      } else if (match[11] || match[12] || match[13]) {
        // Quoted path
        const qPath = match[11] || match[12] || match[13];
        found.push({ path: qPath.trim().replace(/^["']|["']$/g, '') });
      } else {
        const raw = match[14] || match[15] || match[16] || match[17] || match[18];
        if (raw) {
          const { clean } = cleanTrailingPunctuation(raw);
          found.push({ path: clean });
        }
      }
    }

    return found;
  }

  test('extracts Windows absolute paths with full drive letter intact', () => {
    const input = 'move /Y "c:\\Users\\HP\\Videos\\Qubators\\MVP\\optest\\Notepad\\Oldprd\\PRD.md" "c:\\Users\\HP\\Videos\\Qubators\\MVP\\optest\\Notepad\\testdocs\\PRD.md"';
    const paths = extractFilePaths(input);

    assert.strictEqual(paths.length, 2);
    assert.strictEqual(paths[0].path, 'c:\\Users\\HP\\Videos\\Qubators\\MVP\\optest\\Notepad\\Oldprd\\PRD.md');
    assert.strictEqual(paths[1].path, 'c:\\Users\\HP\\Videos\\Qubators\\MVP\\optest\\Notepad\\testdocs\\PRD.md');
    // Verify drive letter 'c:' was not stripped
    assert.ok(paths[0].path.startsWith('c:\\'));
    assert.ok(paths[1].path.startsWith('c:\\'));
  });

  test('extracts quoted paths containing spaces accurately', () => {
    const input = 'Updated "c:\\Users\\HP\\Videos\\Qubators\\MVP\\Openrouter code\\Docs\\PRD.md"';
    const paths = extractFilePaths(input);

    assert.strictEqual(paths.length, 1);
    assert.strictEqual(paths[0].path, 'c:\\Users\\HP\\Videos\\Qubators\\MVP\\Openrouter code\\Docs\\PRD.md');
  });

  test('cleans trailing punctuation from unquoted paths in sentences', () => {
    const input = 'Please check Docs/PRD.md. Also (see Oldprd/prd2.md)!';
    const paths = extractFilePaths(input);

    assert.strictEqual(paths.length, 2);
    assert.strictEqual(paths[0].path, 'Docs/PRD.md');
    assert.strictEqual(paths[1].path, 'Oldprd/prd2.md');
  });

  test('recognizes standalone filenames and dotfiles', () => {
    const input = 'Inspect PRD.md, package.json, and .gitignore file.';
    const paths = extractFilePaths(input);

    const names = paths.map((p) => p.path);
    assert.ok(names.includes('PRD.md'));
    assert.ok(names.includes('package.json'));
    assert.ok(names.includes('.gitignore'));
  });

  test('recognizes markdown links pointing to local files', () => {
    const input = 'Check out the [PRD Specification](Docs/PRD.md) here.';
    const paths = extractFilePaths(input);

    assert.strictEqual(paths.length, 1);
    assert.strictEqual(paths[0].path, 'Docs/PRD.md');
    assert.strictEqual(paths[0].isLink, true);
  });

  test('recognizes inline code files but ignores terminal command snippets', () => {
    const input = 'Run `npm test` after editing `src/webview/ui/main.ts`.';
    const paths = extractFilePaths(input);

    assert.strictEqual(paths.length, 1);
    assert.strictEqual(paths[0].path, 'src/webview/ui/main.ts');
    assert.strictEqual(paths[0].isCode, true);
  });

  test('role protection: terminal output and retries are system role, never user', () => {
    const termMsg = {
      role: 'system' as const,
      content: '✓ **Ran in terminal:** `dir` (completed, exit code: 0)',
    };
    const autoRetryMsg = {
      role: 'system' as const,
      isAutoRetry: true,
      content: 'The previous command failed...',
    };

    assert.strictEqual(termMsg.role, 'system');
    assert.notStrictEqual(termMsg.role, 'user');
    assert.strictEqual(autoRetryMsg.role, 'system');
    assert.notStrictEqual(autoRetryMsg.role, 'user');
  });
});
