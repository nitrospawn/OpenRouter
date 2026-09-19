export interface ExtractedArtifacts {
  /** The full, byte-for-byte faithful markdown plan content produced inside ```plan. */
  planDocument?: string;
  /** The full, byte-for-byte faithful markdown walkthrough content produced inside ```walkthrough. */
  walkthroughDocument?: string;
  /** The content to be rendered in the chat bubble (with fenced plan/walkthrough replaced by concise notices). */
  chatSummary: string;
}

interface FenceInfo {
  tag: string;
  startIndex: number;
  contentStartIndex: number;
  contentEndIndex: number;
  endIndex: number;
}

/**
 * Finds top-level code fence blocks for specific tag names ('plan' or 'walkthrough').
 * Supports arbitrary nested fences within the document without early truncation.
 */
function findTopLevelFence(text: string, tag: 'plan' | 'walkthrough'): FenceInfo | undefined {
  const openRegex = new RegExp(`^(\`\`\`|~~~)${tag}[^\\r\\n]*$`, 'im');
  const openMatch = openRegex.exec(text);
  if (!openMatch) return undefined;

  const fenceChars = openMatch[1]; // ``` or ~~~
  const fenceLen = fenceChars.length;
  const startIndex = openMatch.index;

  // Find where the line with the opening fence ends
  const firstNewline = text.indexOf('\n', startIndex);
  if (firstNewline === -1) return undefined;

  const contentStartIndex = firstNewline + 1;

  // Search line-by-line after contentStartIndex for the matching closing fence.
  // Track nested code fence depth so inner code fences (e.g. ```typescript, ```bash, etc.)
  // do not prematurely close the top-level artifact block.
  const lines = text.slice(contentStartIndex).split(/\r?\n/);
  let currentOffset = contentStartIndex;
  let nestedFenceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if line opens an inner code fence (starts with ``` or ~~~ followed by language/non-whitespace or empty if opening)
    // In markdown, code fences start with 3 or more ` or ~.
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);

    if (fenceMatch) {
      const matchFenceChars = fenceMatch[1];
      const matchRest = fenceMatch[2].trim();

      // If it has rest text (like "typescript" or "bash" or "json"), it is definitely an opening inner fence
      if (matchRest.length > 0) {
        nestedFenceDepth++;
      } else {
        // Line has only fence characters
        if (nestedFenceDepth > 0) {
          // It closes an inner code fence
          nestedFenceDepth--;
        } else {
          // nestedFenceDepth === 0: This is the closing fence for our top-level block!
          const contentEndIndex = currentOffset;
          const lineLen = text.slice(currentOffset).startsWith(line + '\r\n')
            ? line.length + 2
            : (text.slice(currentOffset).startsWith(line + '\n') ? line.length + 1 : line.length);
          const endIndex = currentOffset + lineLen;

          // Ensure we strip the trailing newline just before the closing fence
          let adjustedContentEnd = contentEndIndex;
          if (text.slice(0, adjustedContentEnd).endsWith('\r\n')) {
            adjustedContentEnd -= 2;
          } else if (text.slice(0, adjustedContentEnd).endsWith('\n')) {
            adjustedContentEnd -= 1;
          }

          return {
            tag,
            startIndex,
            contentStartIndex,
            contentEndIndex: adjustedContentEnd,
            endIndex,
          };
        }
      }
    }
    currentOffset += line.length + (text.slice(currentOffset + line.length).startsWith('\r\n') ? 2 : 1);
  }

  // If unclosed, consume until EOF
  return {
    tag,
    startIndex,
    contentStartIndex,
    contentEndIndex: text.length,
    endIndex: text.length,
  };
}

/**
 * Extracts ```plan and ```walkthrough code blocks from model response content.
 * 
 * Guarantees byte-for-byte lossless extraction of the inner document text
 * (matching whatever line endings/whitespace the model emitted).
 */
export function extractArtifacts(rawContent: string): ExtractedArtifacts {
  let planDocument: string | undefined;
  let walkthroughDocument: string | undefined;

  const planFence = findTopLevelFence(rawContent, 'plan');
  if (planFence) {
    planDocument = rawContent.slice(planFence.contentStartIndex, planFence.contentEndIndex);
  }

  const walkthroughFence = findTopLevelFence(rawContent, 'walkthrough');
  if (walkthroughFence) {
    walkthroughDocument = rawContent.slice(walkthroughFence.contentStartIndex, walkthroughFence.contentEndIndex);
  }

  // Replace fences in chatSummary with concise notices
  let chatSummary = rawContent;

  // We replace whichever fence appears later first to keep indices intact if calculating offsets,
  // or simple replacement:
  if (planFence) {
    const fullPlanBlock = rawContent.slice(planFence.startIndex, planFence.endIndex);
    chatSummary = chatSummary.replace(fullPlanBlock, '📄 Plan docs ready — [view]');
  }

  if (walkthroughFence) {
    const fullWalkthroughBlock = rawContent.slice(walkthroughFence.startIndex, walkthroughFence.endIndex);
    chatSummary = chatSummary.replace(fullWalkthroughBlock, '📄 Results docs ready — [view]');
  }

  chatSummary = chatSummary.trim();

  // Check whether the remaining chat summary contains conversational text beyond the artifact notice tokens
  const strippedOfNotices = chatSummary
    .replace(/📄 (?:Plan docs ready|Implementation plan ready) — \[view\]/g, '')
    .replace(/📄 (?:Results docs ready|Walkthrough result) — \[view\]/g, '')
    .trim();

  // If the model produced only a ```plan``` or ```walkthrough``` block and no outer conversational text,
  // ensure chatSummary has both a friendly conversational summary sentence and the notice card
  if (!strippedOfNotices) {
    const parts: string[] = [];
    if (planDocument !== undefined) {
      parts.push('I have prepared plan docs for your review.\n\n📄 Plan docs ready — [view]');
    }
    if (walkthroughDocument !== undefined) {
      parts.push('Here are the completed results docs and verification result.\n\n📄 Results docs ready — [view]');
    }
    chatSummary = parts.join('\n\n');
  }

  return {
    planDocument,
    walkthroughDocument,
    chatSummary,
  };
}
