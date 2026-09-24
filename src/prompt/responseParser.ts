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
 * Supports arbitrary nested fences within the document (including tagged/untagged inner code
 * blocks, ascii diagrams, etc.) without early truncation.
 */
function findTopLevelFence(text: string, tag: 'plan' | 'walkthrough'): FenceInfo | undefined {
  const pattern = tag === 'plan'
    ? '(?:plan|implementation[-_]?plan|plan[-_]?document|plan[-_]?docs)'
    : '(?:walkthrough|results?|result[-_]?walkthrough|verification[-_]?walkthrough|walkthrough[-_]?document)';
  // Support 3 or more backticks (or tildes) followed by the tag
  const openRegex = new RegExp(`^(\`{3,}|~{3,})${pattern}[^\\r\\n]*$`, 'im');
  const openMatch = openRegex.exec(text);
  if (!openMatch) return undefined;

  const fenceChars = openMatch[1]; // e.g. ``` or ```` or ~~~
  const fenceCharType = fenceChars[0]; // '`' or '~'
  const fenceLen = fenceChars.length;
  const startIndex = openMatch.index;

  // Find where the line with the opening fence ends
  const firstNewline = text.indexOf('\n', startIndex);
  if (firstNewline === -1) return undefined;

  const contentStartIndex = firstNewline + 1;

  // If another top-level artifact exists (e.g. walkthrough after plan), don't cross its start
  const otherPattern = tag === 'plan'
    ? '(?:walkthrough|results?|result[-_]?walkthrough|verification[-_]?walkthrough|walkthrough[-_]?document)'
    : '(?:plan|implementation[-_]?plan|plan[-_]?document|plan[-_]?docs)';
  const otherRegex = new RegExp(`^(\`{3,}|~{3,})${otherPattern}[^\\r\\n]*$`, 'im');
  const otherMatch = otherRegex.exec(text.slice(contentStartIndex));
  const maxSearchOffset = otherMatch ? contentStartIndex + otherMatch.index : text.length;

  const searchText = text.slice(contentStartIndex, maxSearchOffset);
  const lines = searchText.split(/\r?\n/);

  // Collect all closing fence candidates (lines consisting solely of >= fenceLen of fenceCharType)
  const candidates: Array<{ offset: number; endOffset: number }> = [];
  let currentOffset = contentStartIndex;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);

    if (fenceMatch) {
      const matchChars = fenceMatch[1];
      const matchRest = fenceMatch[2].trim();

      // Only candidate for closing the top-level block if same char type, length >= fenceLen, and no rest tag
      if (matchChars[0] === fenceCharType && matchChars.length >= fenceLen && matchRest.length === 0) {
        const lineLen = text.slice(currentOffset).startsWith(line + '\r\n')
          ? line.length + 2
          : (text.slice(currentOffset).startsWith(line + '\n') ? line.length + 1 : line.length);
        candidates.push({
          offset: currentOffset,
          endOffset: currentOffset + lineLen,
        });
      }
    }
    currentOffset += line.length + (text.slice(currentOffset + line.length).startsWith('\r\n') ? 2 : 1);
  }

  if (candidates.length === 0) {
    // Unclosed, consume to maxSearchOffset (or EOF)
    return {
      tag,
      startIndex,
      contentStartIndex,
      contentEndIndex: maxSearchOffset,
      endIndex: maxSearchOffset,
    };
  }

  // Iterate backwards from the last candidate to find the true artifact boundary.
  // A candidate is the artifact closing fence if everything after it (until maxSearchOffset)
  // does not look like continuing artifact document structure (no further code blocks, no headers like ###).
  let chosenCandidate = candidates[candidates.length - 1];

  for (let c = candidates.length - 1; c >= 0; c--) {
    const candidate = candidates[c];
    const tail = text.slice(candidate.endOffset, maxSearchOffset).trim();

    // Check if tail has code blocks or markdown section headings
    const hasCodeBlocks = /(?:^|\r?\n)(?:`{3,}|~{3,})/.test(tail);
    const hasHeadings = /(?:^|\r?\n)#{1,4}\s+/.test(tail);

    if (!hasCodeBlocks && !hasHeadings) {
      // This candidate cleanly terminates the technical document (at most plain conversational text follows)
      chosenCandidate = candidate;
      break;
    }
  }

  // Format content end: strip trailing newline just before the closing fence
  let adjustedContentEnd = chosenCandidate.offset;
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
    endIndex: chosenCandidate.endOffset,
  };
}

/**
 * Detects if a text snippet is an introductory preamble / chain-of-thought intent announcement
 * before generating a plan or walkthrough document (e.g. "I'll apply all the reviewer fixes to the Phase 1 plan. Here's the fully revised plan...").
 */
function isPreambleText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const preambleRegex = /^(?:(?:Sure|Certainly|Okay|Ok|Alright|Right|Understood),?\s*)?(?:I(?:'ll|'m going to| will| have| am ready to)|Let me|Here(?:'s| is)|Below is|I am preparing|I'll prepare|I will prepare|Let's)\s+(?:apply|create|generate|prepare|update|revise|provide|write|outline|draft|review|proceed with|first|now|all\s+the|the\s+plan|the\s+revised|a\s+plan|an\s+implementation|these\s+fixes|the\s+reviewer)[\s\S]*?(?:plan|findings?|below|here|adjustments?|verification plan|checklist)?[.:]?$/i;
  return preambleRegex.test(trimmed);
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

  // 1. Strip internal model reasoning / thinking tags (<think>...</think>, <thought>...</thought>, etc.)
  let cleanedContent = rawContent
    .replace(/<(?:think|thought|thinking)>[\s\S]*?<\/(?:think|thought|thinking)>/gi, '')
    .replace(/<(?:think|thought|thinking)>[\s\S]*$/gi, '')
    .trim();

  const planFence = findTopLevelFence(cleanedContent, 'plan');
  if (planFence) {
    planDocument = cleanedContent.slice(planFence.contentStartIndex, planFence.contentEndIndex);
  }

  const walkthroughFence = findTopLevelFence(cleanedContent, 'walkthrough');
  if (walkthroughFence) {
    walkthroughDocument = cleanedContent.slice(walkthroughFence.contentStartIndex, walkthroughFence.contentEndIndex);
  }

  // Replace fences in chatSummary with concise notices and eliminate redundant preambles
  let chatSummary = cleanedContent;

  if (planFence) {
    const fullPlanBlock = cleanedContent.slice(planFence.startIndex, planFence.endIndex);
    const leadingText = cleanedContent.slice(0, planFence.startIndex).trim();
    const trailingText = cleanedContent.slice(planFence.endIndex).trim();

    const hasTrailing = trailingText.length > 0;
    const hasLeadingPreamble = leadingText.length > 0 && isPreambleText(leadingText);

    if (hasTrailing && hasLeadingPreamble) {
      // The trailing text is the actual final response and confirmation question.
      // Omit the redundant leading preamble / intent monologue so AI reasoning is not in the output block.
      chatSummary = `${trailingText}\n\n📄 Plan docs ready — [view]`;
    } else {
      const replacement = hasTrailing
        ? '📄 Plan docs ready — [view]\n\n'
        : '📄 Plan docs ready — [view]';
      chatSummary = chatSummary.replace(fullPlanBlock, replacement);
    }
  }

  if (walkthroughFence) {
    const fullWalkthroughBlock = cleanedContent.slice(walkthroughFence.startIndex, walkthroughFence.endIndex);
    const leadingText = cleanedContent.slice(0, walkthroughFence.startIndex).trim();
    const trailingText = cleanedContent.slice(walkthroughFence.endIndex).trim();

    const hasTrailing = trailingText.length > 0;
    const hasLeadingPreamble = leadingText.length > 0 && isPreambleText(leadingText);

    if (hasTrailing && hasLeadingPreamble) {
      chatSummary = `${trailingText}\n\n📄 Results docs ready — [view]`;
    } else {
      const replacement = hasTrailing
        ? '📄 Results docs ready — [view]\n\n'
        : '📄 Results docs ready — [view]';
      chatSummary = chatSummary.replace(fullWalkthroughBlock, replacement);
    }
  }

  // Resilient fallback 1: If no fenced plan was found, check if rawContent contains an unfenced Markdown Plan document
  // (e.g. model output starting with or containing '# Implementation Plan' or '# Plan' with steps/content)
  if (!planFence && !planDocument) {
    const unfencedPlanMatch = /(?:^|\n)(#{1,3}\s+(?:Implementation\s+Plan|Plan(?:\s+for|\s*:|\s+Document|\s+Overview)?\b)[\s\S]*)$/i.exec(chatSummary);
    if (unfencedPlanMatch && unfencedPlanMatch[1].trim().length > 30) {
      const candidatePlan = unfencedPlanMatch[1].trim();
      // Ensure it's not a tiny one-liner by verifying multiple lines or list/header structure
      if (candidatePlan.includes('\n') && (/^[-*\d]\.?\s+/m.test(candidatePlan) || /#{2,4}\s+/m.test(candidatePlan))) {
        planDocument = candidatePlan;
        const prefix = chatSummary.slice(0, unfencedPlanMatch.index).trim();
        if (prefix.length > 0) {
          chatSummary = `${prefix}\n\n📄 Plan docs ready — [view]`;
        } else {
          chatSummary = '📄 Plan docs ready — [view]';
        }
      }
    }
  }

  // Resilient fallback 2: If model mistakenly emitted an edit_file/SEARCH-REPLACE block targeting an implementation plan artifact
  if (!planFence && !planDocument) {
    const artifactEditRegex = /(?:```|````)(?:create_file|edit_file|file):[^\r\n]*(?:implementation_plan|artifacts[\\/]implementation_plan)[^\r\n]*\r?\n([\s\S]*?)(?:```|````)/i;
    const artifactEditMatch = artifactEditRegex.exec(rawContent);
    if (artifactEditMatch) {
      const blockContent = artifactEditMatch[1];
      let extractedText = blockContent;
      if (blockContent.includes('=======') && blockContent.includes('>>>>>>>')) {
        const replaceMatch = /=======\r?\n([\s\S]*?)>>>>>>>/.exec(blockContent);
        if (replaceMatch) extractedText = replaceMatch[1];
      } else if (blockContent.includes('<<<< SEARCH') && blockContent.includes('====')) {
        const replaceMatch = /====[^\r\n]*\r?\n([\s\S]*?)>>>>/.exec(blockContent);
        if (replaceMatch) extractedText = replaceMatch[1];
      }
      extractedText = extractedText.trim();
      if (extractedText.length > 20) {
        planDocument = extractedText;
        chatSummary = chatSummary.replace(artifactEditMatch[0], '📄 Plan docs ready — [view]');
      }
    }
  }

  // Resilient fallback: If no fenced walkthrough was found, check if rawContent contains an unfenced Walkthrough document
  if (!walkthroughFence && !walkthroughDocument) {
    const unfencedWalkthroughMatch = /(?:^|\n)(#{1,3}\s+(?:(?:Final\s+)?Walkthrough|Verification\s+(?:&|and)\s+Walkthrough|Walkthrough\s+(?:Report|Result))[\s\S]*)$/i.exec(chatSummary);
    if (unfencedWalkthroughMatch && unfencedWalkthroughMatch[1].trim().length > 30) {
      const candidateWalkthrough = unfencedWalkthroughMatch[1].trim();
      if (candidateWalkthrough.includes('\n')) {
        walkthroughDocument = candidateWalkthrough;
        const prefix = chatSummary.slice(0, unfencedWalkthroughMatch.index).trim();
        if (prefix.length > 0) {
          chatSummary = `${prefix}\n\n📄 Results docs ready — [view]`;
        } else {
          chatSummary = '📄 Results docs ready — [view]';
        }
      }
    }
  }

  chatSummary = chatSummary.trim();

  // Deduplicate any repeated plan notices in chatSummary (e.g. if the model manually emitted one and the parser also injected one)
  const planNoticeRegex = /📄\s*(?:Plan docs ready|Plan docs|Implementation plan ready|Plan ready)\s*(?:[—–-]\s*\[view\])?/gi;
  const planMatches = chatSummary.match(planNoticeRegex);
  if (planMatches && planMatches.length > 1) {
    let preservedFirst = false;
    chatSummary = chatSummary.replace(planNoticeRegex, () => {
      if (!preservedFirst) {
        preservedFirst = true;
        return '📄 Plan docs ready — [view]';
      }
      return '';
    });
    chatSummary = chatSummary.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Deduplicate any repeated walkthrough notices in chatSummary
  const walkthroughNoticeRegex = /📄\s*(?:Results docs ready|Results docs|Walkthrough result|Walkthrough ready|Result walkthrough)\s*(?:[—–-]\s*\[view\])?/gi;
  const walkthroughMatches = chatSummary.match(walkthroughNoticeRegex);
  if (walkthroughMatches && walkthroughMatches.length > 1) {
    let preservedFirst = false;
    chatSummary = chatSummary.replace(walkthroughNoticeRegex, () => {
      if (!preservedFirst) {
        preservedFirst = true;
        return '📄 Results docs ready — [view]';
      }
      return '';
    });
    chatSummary = chatSummary.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

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
