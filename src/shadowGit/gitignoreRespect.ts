import * as fs from 'fs';
import * as path from 'path';

export class GitignoreRespect {
  /**
   * Simple check if a relative file path matches standard ignore patterns or workspace .gitignore
   */
  public static isIgnored(workTree: string, relativeFilePath: string): boolean {
    const normalized = relativeFilePath.replace(/\\/g, '/');

    // Always ignore common sensitive/large patterns
    if (
      normalized.startsWith('.git/') ||
      normalized.startsWith('.openrouter/') ||
      normalized.startsWith('node_modules/') ||
      normalized.endsWith('.env') ||
      normalized.includes('/.env')
    ) {
      return true;
    }

    const gitignorePath = path.join(workTree, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

      for (const line of lines) {
        // Strip trailing slash for dir match
        const pattern = line.replace(/\/$/, '');
        if (normalized === pattern || normalized.startsWith(pattern + '/')) {
          return true;
        }
      }
    } catch {
      // Fallback if unable to read
    }

    return false;
  }
}
