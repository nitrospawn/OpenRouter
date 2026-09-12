import { parseCodeBlock, CODE_BLOCK_COLLAPSE_THRESHOLD } from './codeBlockUtils';

export function renderCodeBlock(
  lang: string,
  code: string,
  container: any,
  documentObj: any // Pass document for testing, or use global document in browser
) {
  const state = parseCodeBlock(lang, code);

  const wrapper = documentObj.createElement('div');
  wrapper.className = 'code-block-wrapper';

  const header = documentObj.createElement('div');
  header.className = 'code-block-header';

  const langSpan = documentObj.createElement('span');
  if (state.isLarge) {
    langSpan.textContent = `${state.displayTitle} — ${state.lineCount} lines written`;
  } else {
    langSpan.textContent = state.displayTitle;
  }

  const actionsContainer = documentObj.createElement('div');
  actionsContainer.className = 'code-block-actions';
  actionsContainer.style = actionsContainer.style || {};
  actionsContainer.style.display = 'flex';
  actionsContainer.style.gap = '8px';

  const copyBtn = documentObj.createElement('button');
  copyBtn.className = 'code-block-copy-btn';
  copyBtn.textContent = 'Copy';
  // Copy button relies on navigator.clipboard, skip testing it deeply for now.
  copyBtn.addEventListener('click', () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(state.fullCode).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 2000);
      });
    }
  });

  const pre = documentObj.createElement('pre');
  const codeEl = documentObj.createElement('code');

  if (state.isLarge) {
    const toggleBtn = documentObj.createElement('button');
    toggleBtn.className = 'code-block-copy-btn';
    toggleBtn.textContent = 'Expand';
    
    let isCollapsed = true;
    codeEl.textContent = state.lines.slice(0, 5).join('\n') + '\n...';
    
    toggleBtn.addEventListener('click', () => {
      isCollapsed = !isCollapsed;
      if (isCollapsed) {
        toggleBtn.textContent = 'Expand';
        codeEl.textContent = state.lines.slice(0, 5).join('\n') + '\n...';
      } else {
        toggleBtn.textContent = 'Collapse';
        codeEl.textContent = state.fullCode;
      }
    });
    actionsContainer.appendChild(toggleBtn);
  } else {
    codeEl.textContent = state.fullCode;
  }

  actionsContainer.appendChild(copyBtn);

  header.appendChild(langSpan);
  header.appendChild(actionsContainer);

  pre.appendChild(codeEl);

  wrapper.appendChild(header);
  wrapper.appendChild(pre);
  container.appendChild(wrapper);
  
  return { wrapper, codeEl };
}
