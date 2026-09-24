/**
 * ChunkManager: Dynamic file batching and context-window token budgeting.
 * Eliminates arbitrary file truncation and partitions oversized files into
 * coherent batches when file sizes exceed the target model's context window.
 */

export interface FileBatch {
  batchIndex: number;
  totalBatches: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export class ChunkManager {
  private static readonly CHARS_PER_TOKEN = 3.8;
  private static readonly DEFAULT_FALLBACK_CONTEXT = 128000;
  private static readonly DEFAULT_OVERHEAD_RESERVE = 8000; // System instructions, chat history, tool/output reserve

  /**
   * Fast, conservative token estimation (~3.8 characters per token for code & markdown)
   */
  public static estimateTokens(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / this.CHARS_PER_TOKEN);
  }

  /**
   * Calculates the maximum token budget available for a file given the model's context window.
   */
  public static calculateAvailableFileTokens(
    modelContextLength?: number,
    historyTokens = 0,
    systemPromptOverhead = 4000,
    outputReserve = 4000
  ): number {
    const totalContext = modelContextLength && modelContextLength > 0
      ? modelContextLength
      : this.DEFAULT_FALLBACK_CONTEXT;

    const totalOverhead = historyTokens + systemPromptOverhead + outputReserve;
    const available = totalContext - totalOverhead;

    // Guarantee at least a minimal working window (e.g. 2,000 tokens)
    return Math.max(2000, available);
  }

  /**
   * Checks whether the file content fits completely within the available token budget.
   */
  public static fitsWithinContext(content: string, availableTokens: number): boolean {
    return this.estimateTokens(content) <= availableTokens;
  }

  /**
   * Partitions a file into overlapping batches that fit within maxBatchTokens.
   * If the file fits completely, returns a single batch containing 100% of the content.
   */
  public static createFileBatches(
    content: string,
    maxBatchTokens: number,
    overlapLines = 20
  ): FileBatch[] {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const totalLines = lines.length;

    // If it fits in one batch, return the whole file with no batching overhead
    if (this.estimateTokens(content) <= maxBatchTokens || totalLines <= 1) {
      return [
        {
          batchIndex: 1,
          totalBatches: 1,
          startLine: 1,
          endLine: totalLines,
          totalLines,
          content,
        },
      ];
    }

    const batches: Array<{ startLine: number; endLine: number; content: string }> = [];
    let currentStart = 0; // 0-indexed

    while (currentStart < totalLines) {
      let currentEnd = currentStart;
      let currentChars = 0;

      while (currentEnd < totalLines) {
        const lineLen = lines[currentEnd].length + 1; // +1 for newline
        const estimatedTokens = Math.ceil((currentChars + lineLen) / this.CHARS_PER_TOKEN);
        if (estimatedTokens > maxBatchTokens && currentEnd > currentStart) {
          break;
        }
        currentChars += lineLen;
        currentEnd++;
      }

      // Safety check to ensure progress
      if (currentEnd === currentStart) {
        currentEnd = Math.min(currentStart + 1, totalLines);
      }

      const batchContent = lines.slice(currentStart, currentEnd).join('\n');
      batches.push({
        startLine: currentStart + 1, // 1-indexed
        endLine: currentEnd,         // 1-indexed
        content: batchContent,
      });

      if (currentEnd >= totalLines) {
        break;
      }

      // Advance with overlap for context continuity
      currentStart = Math.max(currentEnd - overlapLines, currentStart + 1);
    }

    const totalBatches = batches.length;
    return batches.map((b, idx) => ({
      batchIndex: idx + 1,
      totalBatches,
      startLine: b.startLine,
      endLine: b.endLine,
      totalLines,
      content: b.content,
    }));
  }

  /**
   * Selects the most relevant batch based on user prompt intent, line mentions, or active selection.
   */
  public static selectRelevantBatch(
    batches: FileBatch[],
    userPrompt: string,
    activeSelection?: string
  ): FileBatch {
    if (batches.length === 0) {
      return {
        batchIndex: 1,
        totalBatches: 1,
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        content: '',
      };
    }
    if (batches.length === 1) {
      return batches[0];
    }

    const normalizedPrompt = userPrompt.toLowerCase();

    // 1. Intent: Appending to end of file
    const isAppendIntent = /\b(append|last line|tail)\b|\b(?:add|insert|write|put)\b[\s\S]*?\b(?:end|bottom)\b|\b(?:to|at) (?:the )?(?:end|bottom)\b/i.test(
      normalizedPrompt
    );
    if (isAppendIntent) {
      return batches[batches.length - 1];
    }

    // 2. Active selection in editor
    if (activeSelection && activeSelection.trim().length > 0) {
      const targetSnippet = activeSelection.trim().slice(0, 100);
      const match = batches.find((b) => b.content.includes(targetSnippet));
      if (match) {
        return match;
      }
    }

    // 3. Line number mention (e.g. "line 370", "lines 100-150")
    const lineMatch = normalizedPrompt.match(/\bline[s]?\s+(\d+)\b/i);
    if (lineMatch) {
      const targetLine = parseInt(lineMatch[1], 10);
      const match = batches.find(
        (b) => targetLine >= b.startLine && targetLine <= b.endLine
      );
      if (match) {
        return match;
      }
    }

    // Default to the first batch
    return batches[0];
  }
}
