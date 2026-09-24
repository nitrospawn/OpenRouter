/**
 * Command Classifier
 *
 * Distinguishes Tier 1 (Read-Only / Inspection) terminal commands from
 * Tier 2 (Side-Effecting / Mutating) commands.
 *
 * This module is intentionally pure with ZERO external or Node.js dependencies
 * so that it can be safely imported by both the VS Code extension backend
 * and the browser-bundled Webview UI (esbuild).
 */

export const READ_ONLY_COMMAND_PATTERNS: RegExp[] = [
  /^(?:Get-Content|gc|type)\s/i,
  /^(?:Get-ChildItem|gci|dir|ls)(\s|$)/i,
  /^cat\s/i,
  /^grep\s/i,
  /^findstr\s/i,
  /^find\s/i,
  /^Select-String\s/i,
  /^pwd$/i,
  /^echo\s/i,
  /^head\s/i,
  /^tail\s/i,
  /^wc\s/i,
  /^which\s/i,
  /^where(\.exe)?\s/i,
  /^git\s+status(\s|$)/i,
  /^git\s+diff(\s|$)/i,
  /^git\s+log(\s|$)/i,
  /^git\s+branch(\s|$)/i,
];

// Patterns that indicate side effects or file writing, even if prepended by read-only keywords
const MUTATING_PATTERNS: RegExp[] = [
  />/g, // file redirection: > or >>
  /\bOut-File\b/i,
  /\bSet-Content\b/i,
  /\bAdd-Content\b/i,
  /\b(rm|del|erase|rmdir|mkdir|touch)\b/i,
  /\b(npm|yarn|pnpm|pip|cargo)\s+(install|add|remove|uninstall|update)\b/i,
  /\bgit\s+(add|commit|push|checkout|merge|rebase|reset|pull)\b/i,
];

/**
 * Checks if an individual command segment is read-only.
 */
function isSingleCommandReadOnly(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) {
    return true;
  }

  // Any mutating keyword or redirection disqualifies it immediately
  for (const pattern of MUTATING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return false;
    }
  }

  return READ_ONLY_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Returns true if the command is purely read-only / inspection.
 * Compound/chained commands (&&, ||, ;, |) are split and each segment is checked:
 * if any segment is side-effecting, the whole command is deemed side-effecting.
 */
export function isReadOnly(command: string): boolean {
  if (!command || !command.trim()) {
    return false;
  }

  const trimmed = command.trim();

  // If the command contains file redirection (> or >>), it modifies files
  if (/>/g.test(trimmed)) {
    return false;
  }

  // Check for piping or chaining
  const chainDelimiters = /(&&|\|\||;|\|)/;
  if (chainDelimiters.test(trimmed)) {
    const parts = trimmed.split(chainDelimiters);
    // Even indices are commands, odd indices are delimiters
    for (let i = 0; i < parts.length; i += 2) {
      const part = parts[i].trim();
      if (part && !isSingleCommandReadOnly(part)) {
        return false;
      }
    }
    return true;
  }

  return isSingleCommandReadOnly(trimmed);
}

/**
 * Provides a user-friendly status message for live UI feedback
 * (e.g. "Reading file: src/index.ts", "Inspecting directory")
 */
export function getInspectionDescription(command: string): string {
  const trimmed = command.trim();

  const fileMatch = trimmed.match(/^(?:type|cat|Get-Content|gc)\s+(.+)$/i);
  if (fileMatch) {
    let filePath = fileMatch[1].trim();
    // remove quotes if any
    filePath = filePath.replace(/^['"]|['"]$/g, '');
    const baseName = filePath.split(/[/\\]/).pop() || filePath;
    return `Reading file: ${baseName}`;
  }

  if (/^(?:dir|ls|Get-ChildItem|gci)(\s|$)/i.test(trimmed)) {
    return 'Inspecting directory';
  }

  if (/^(?:grep|findstr|find|Select-String)\s/i.test(trimmed)) {
    return 'Searching workspace';
  }

  if (/^git\s+/i.test(trimmed)) {
    return 'Inspecting git status';
  }

  return `Inspecting: ${trimmed.length > 30 ? trimmed.slice(0, 27) + '...' : trimmed}`;
}
