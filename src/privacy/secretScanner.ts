export interface SecretMatch {
  ruleName: string;
  matchedText: string;
  startIndex: number;
  endIndex: number;
  maskedText: string;
}

export interface RedactResult {
  sanitized: string;
  matches: SecretMatch[];
  hasSecrets: boolean;
}

/**
 * Calculates Shannon entropy for a string.
 * Used as a confidence booster alongside key-like contextual patterns.
 */
export function calculateShannonEntropy(str: string): number {
  if (!str) return 0;
  const frequencies: Record<string, number> = {};
  for (const char of str) {
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export class SecretScanner {
  // Common vendor key prefixes
  private static readonly AWS_KEY_REGEX = /\b(AKIA[0-9A-Z]{16})\b/g;
  // Broad vendor convention (OpenAI, Anthropic sk-ant-..., OpenRouter, etc.)
  private static readonly GENERAL_SK_REGEX = /\b(sk-[a-zA-Z0-9_\-]{20,})\b/g;
  private static readonly GITHUB_PAT_REGEX = /\b(ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82})\b/g;
  private static readonly GITLAB_PAT_REGEX = /\b(glpat-[a-zA-Z0-9\-]{20,})\b/g;
  private static readonly SLACK_TOKEN_REGEX = /\b(xox[baprs]-[0-9a-zA-Z]{10,48})\b/g;
  private static readonly STRIPE_KEY_REGEX = /\b((?:sk|rk)_live_[0-9a-zA-Z]{24,})\b/g;
  private static readonly PRIVATE_KEY_REGEX = /-----BEGIN ((?:RSA|EC|OPENSSH|PGP|DSA)?\s?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

  // Context-bound key/secret assignments (e.g. KEY="...", secret: '...')
  // Requires both contextual key name and entropy/length confidence to avoid false positives on simple configs
  private static readonly ASSIGNMENT_CONTEXT_REGEX =
    /(?:API_KEY|SECRET|PASSWORD|PASSWD|TOKEN|AUTH_TOKEN|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY|SECRET_KEY)\s*[:=]\s*(['"]?)([a-zA-Z0-9_\-.~+=/!@#$%^&*()]{8,})\1/gi;

  /**
   * Masks a secret string preserving non-sensitive prefixes where helpful
   */
  public static maskSecret(secret: string, ruleName: string): string {
    if (ruleName === 'Private Key') {
      return '-----BEGIN PRIVATE KEY-----\n[REDACTED_PRIVATE_KEY]\n-----END PRIVATE KEY-----';
    }

    if (secret.startsWith('sk-')) {
      const prefix = secret.slice(0, 7); // e.g. sk-proj or sk-ant
      return `${prefix}***redacted***`;
    }

    if (secret.startsWith('AKIA')) {
      return 'AKIA***redacted***';
    }

    if (secret.startsWith('ghp_') || secret.startsWith('github_pat_')) {
      return 'ghp_***redacted***';
    }

    if (secret.startsWith('xox')) {
      return 'xox-***redacted***';
    }

    return `[REDACTED:${ruleName.toUpperCase().replace(/\s+/g, '_')}]`;
  }

  /**
   * Scans text and identifies all detected secrets
   */
  public static scan(text: string): SecretMatch[] {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const matches: SecretMatch[] = [];

    const addMatches = (regex: RegExp, ruleName: string, captureGroup = 0) => {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const fullMatched = m[captureGroup] || m[0];
        const startIndex = m.index + (m[0].indexOf(fullMatched));
        const endIndex = startIndex + fullMatched.length;

        matches.push({
          ruleName,
          matchedText: fullMatched,
          startIndex,
          endIndex,
          maskedText: this.maskSecret(fullMatched, ruleName),
        });
      }
    };

    // 1. Direct Vendor Prefix Signatures
    addMatches(this.AWS_KEY_REGEX, 'AWS Access Key', 1);
    addMatches(this.GENERAL_SK_REGEX, 'API Key (sk- prefix)', 1);
    addMatches(this.GITHUB_PAT_REGEX, 'GitHub Token', 1);
    addMatches(this.GITLAB_PAT_REGEX, 'GitLab Token', 1);
    addMatches(this.SLACK_TOKEN_REGEX, 'Slack Token', 1);
    addMatches(this.STRIPE_KEY_REGEX, 'Stripe Secret Key', 1);
    addMatches(this.PRIVATE_KEY_REGEX, 'Private Key', 0);

    // 2. Context-bound key/secret assignments + Entropy Confidence Booster
    this.ASSIGNMENT_CONTEXT_REGEX.lastIndex = 0;
    let assignMatch: RegExpExecArray | null;
    while ((assignMatch = this.ASSIGNMENT_CONTEXT_REGEX.exec(text)) !== null) {
      const secretCandidate = assignMatch[2];
      if (!secretCandidate) continue;

      // Entropy confidence booster:
      // - High entropy (>= 4.5 bits/symbol) strongly signals random crypto keys / base64 tokens.
      // - Random alphanumeric tokens (entropy >= 4.0 and length >= 16) signals API keys/tokens.
      // - Hex secrets (entropy >= 3.0, length >= 16, hex-only) signals hashes and hex keys.
      // - Complex passwords (entropy >= 3.5, length >= 10, mixed character diversity).
      // - Identifiers ('production', 'administrator', 'my_custom_token') fail all of these checks.
      const entropy = calculateShannonEntropy(secretCandidate);
      const isHighEntropy = entropy >= 4.5;
      const isRandomToken = entropy >= 4.0 && secretCandidate.length >= 16;
      const isHexSecret = /^[0-9a-fA-F]{16,}$/.test(secretCandidate) && entropy >= 3.0;
      const isComplexPassword =
        secretCandidate.length >= 10 &&
        entropy >= 3.5 &&
        /[a-z]/.test(secretCandidate) &&
        /[A-Z]/.test(secretCandidate) &&
        (/[0-9]/.test(secretCandidate) || /[^a-zA-Z0-9]/.test(secretCandidate));

      const isLikelySecret = isHighEntropy || isRandomToken || isHexSecret || isComplexPassword;

      // Ignore dummy/placeholder templates like "your_api_key_here", "password", "none", "dummy"
      const lower = secretCandidate.toLowerCase();
      const isPlaceholder =
        lower.includes('placeholder') ||
        lower.includes('example') ||
        lower.includes('your_') ||
        lower === 'password' ||
        lower === 'secret' ||
        lower === 'changeme';

      if (isLikelySecret && !isPlaceholder) {
        const startIndex = assignMatch.index + assignMatch[0].lastIndexOf(secretCandidate);
        const endIndex = startIndex + secretCandidate.length;

        // Check if already captured by prefix regex
        const overlap = matches.some(
          (m) => (startIndex >= m.startIndex && startIndex < m.endIndex) || (endIndex > m.startIndex && endIndex <= m.endIndex)
        );

        if (!overlap) {
          matches.push({
            ruleName: 'Credential Assignment',
            matchedText: secretCandidate,
            startIndex,
            endIndex,
            maskedText: '[REDACTED:CREDENTIAL]',
          });
        }
      }
    }

    // Sort by startIndex ascending
    return matches.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * Scans and replaces all detected secrets with masked placeholders
   */
  public static redact(text: string): RedactResult {
    if (!text || typeof text !== 'string') {
      return { sanitized: text, matches: [], hasSecrets: false };
    }

    const matches = this.scan(text);
    if (matches.length === 0) {
      return { sanitized: text, matches: [], hasSecrets: false };
    }

    // Reconstruct string by replacing matches from end to start to preserve indices
    let sanitized = text;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      sanitized =
        sanitized.slice(0, match.startIndex) +
        match.maskedText +
        sanitized.slice(match.endIndex);
    }

    return {
      sanitized,
      matches,
      hasSecrets: true,
    };
  }
}
