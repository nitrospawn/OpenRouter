export const CODE_BLOCK_COLLAPSE_THRESHOLD = 15;

export interface CodeBlockRenderState {
  isLarge: boolean;
  displayTitle: string;
  lineCount: number;
  lines: string[];
  fullCode: string;
  lang: string;
}

export function parseCodeBlock(lang: string, code: string): CodeBlockRenderState {
  try {
    const safeCode = typeof code === 'string' ? code : '';
    const safeLang = typeof lang === 'string' ? lang : '';
    
    const lines = safeCode.split(/\r?\n/);
    const lineCount = lines.length;
    const isLarge = lineCount > CODE_BLOCK_COLLAPSE_THRESHOLD;

    let displayTitle = safeLang || 'code';
    
    // If it contains a colon, we need to carefully split it, 
    // unless it's just a Windows drive letter colon.
    const firstColon = displayTitle.indexOf(':');
    if (firstColon !== -1) {
      // If the colon is at index 1, and the previous char is a letter, and the next char is \ or /
      // it's likely a Windows drive letter (e.g. C:\)
      const isDriveLetter = firstColon === 1 && 
                            /^[a-zA-Z]$/.test(displayTitle.charAt(0)) &&
                            (displayTitle.charAt(2) === '\\' || displayTitle.charAt(2) === '/');
      
      // If it's not a drive letter, or there are multiple colons, we should split and take the last part
      if (!isDriveLetter || displayTitle.lastIndexOf(':') > firstColon) {
        displayTitle = displayTitle.split(':').pop()?.trim() || displayTitle;
      }
    }

    return {
      isLarge,
      displayTitle,
      lineCount,
      lines,
      fullCode: safeCode,
      lang: safeLang
    };
  } catch (err) {
    // Fail safe: uncollapsed full text
    return {
      isLarge: false,
      displayTitle: lang || 'code',
      lineCount: 1,
      lines: [code || ''],
      fullCode: code || '',
      lang: lang || 'code'
    };
  }
}
