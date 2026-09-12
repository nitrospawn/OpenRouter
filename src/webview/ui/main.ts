import { renderCodeBlock } from './codeBlockUI';
// Declared VS Code Webview API
declare function acquireVsCodeApi(): {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

// Persistent state for resolved file edits (applied or rejected)
const resolvedEdits: Record<string, { status: 'applied' | 'rejected'; checkpointId?: string }> = (() => {
  try {
    const saved = vscode.getState();
    return saved?.resolvedEdits || {};
  } catch {
    return {};
  }
})();

function markEditResolved(editKey: string, status: 'applied' | 'rejected', checkpointId?: string) {
  resolvedEdits[editKey] = { status, checkpointId };
  try {
    const currentState = vscode.getState() || {};
    vscode.setState({ ...currentState, resolvedEdits });
  } catch {
    // Ignore state saving errors
  }
}

// DOM References
const authSection = document.getElementById('auth-section') as HTMLDivElement;
const chatSection = document.getElementById('chat-section') as HTMLDivElement;
const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
const saveKeyBtn = document.getElementById('save-key-btn') as HTMLButtonElement;

const modelSearchInput = document.getElementById('model-search-input') as HTMLInputElement;
const modelDropdown = document.getElementById('model-dropdown') as HTMLDivElement;
const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
const sessionDropdown = document.getElementById('session-dropdown') as HTMLDivElement;
const sessionItemNew = document.getElementById('session-item-new') as HTMLDivElement;
const sessionHistoryList = document.getElementById('session-history-list') as HTMLDivElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;

const reasoningEffortContainer = document.getElementById('reasoning-effort-container') as HTMLDivElement;
const reasoningEffortSelect = document.getElementById('reasoning-effort-select') as HTMLSelectElement;

const visionBadge = document.getElementById('vision-badge') as HTMLSpanElement;
const audioBadge = document.getElementById('audio-badge') as HTMLSpanElement;
const toolsBadge = document.getElementById('tools-badge') as HTMLSpanElement;

const messagesContainer = document.getElementById('messages-container') as HTMLDivElement;
const promptInput = document.getElementById('prompt-input') as HTMLTextAreaElement;
const copyInputBtn = document.getElementById('copy-input-btn') as HTMLButtonElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const uploadImgBtn = document.getElementById('upload-img-btn') as HTMLButtonElement;
const voiceInputBtn = document.getElementById('voice-input-btn') as HTMLButtonElement;
const imageFileInput = document.getElementById('image-file-input') as HTMLInputElement;
const attachmentPreviewBar = document.getElementById('attachment-preview-bar') as HTMLDivElement;
const inputBoxWrapper = document.getElementById('input-box-wrapper') as HTMLDivElement;

let attachments: Array<{ id: string; name: string; data: string; isImage: boolean }> = [];

function addAttachment(name: string, data: string, isImage: boolean) {
  const id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
  attachments.push({ id, name, data, isImage });
  renderAttachments();
}

function removeAttachment(id: string) {
  attachments = attachments.filter(a => a.id !== id);
  renderAttachments();
}

function clearAttachments() {
  attachments = [];
  renderAttachments();
  if (imageFileInput) {
    imageFileInput.value = '';
  }
}

function renderAttachments() {
  if (!attachmentPreviewBar) return;
  attachmentPreviewBar.innerHTML = '';
  
  if (attachments.length === 0) {
    attachmentPreviewBar.classList.add('hidden');
    return;
  }
  
  attachmentPreviewBar.classList.remove('hidden');
  attachments.forEach(att => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    
    if (att.isImage) {
      const img = document.createElement('img');
      img.className = 'attachment-preview-img';
      img.src = att.data;
      img.alt = 'attachment';
      chip.appendChild(img);
    }
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'attachment-name';
    nameSpan.textContent = att.name;
    chip.appendChild(nameSpan);
    
    const btn = document.createElement('button');
    btn.className = 'chip-remove-btn';
    btn.title = 'Remove attachment';
    btn.textContent = '✕';
    btn.addEventListener('click', () => removeAttachment(att.id));
    chip.appendChild(btn);
    
    attachmentPreviewBar.appendChild(chip);
  });
}

function processImageFile(file: File) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const result = e.target?.result as string;
    if (result) {
      addAttachment(file.name || 'Pasted image', result, true);
    }
  };
  reader.readAsDataURL(file);
}

function processTextFile(file: File) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const result = e.target?.result as string;
    if (result) {
      addAttachment(file.name || 'Pasted document', result, false);
    }
  };
  reader.readAsText(file);
}

const statusText = document.getElementById('status-text') as HTMLSpanElement;
const tokenMeter = document.getElementById('token-meter') as HTMLSpanElement;

// Usage & Settings Elements
const usageBackBtn = document.getElementById('usage-back-btn') as HTMLButtonElement;
const viewChat = document.getElementById('view-chat') as HTMLDivElement;
const viewUsage = document.getElementById('view-usage') as HTMLDivElement;
const viewSettings = document.getElementById('view-settings') as HTMLDivElement;

const spendTodayEl = document.getElementById('spend-today') as HTMLDivElement;
const spendWeekEl = document.getElementById('spend-week') as HTMLDivElement;
const spendMonthEl = document.getElementById('spend-month') as HTMLDivElement;

const filterProject = document.getElementById('filter-project') as HTMLSelectElement;
const filterModel = document.getElementById('filter-model') as HTMLSelectElement;
const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
const auditTableBody = document.getElementById('audit-table-body') as HTMLTableSectionElement;

// Settings DOM Elements (Matching Mockup)
const settingsBackBtn = document.getElementById('settings-back-btn') as HTMLButtonElement;
const settingsMaskedKey = document.getElementById('settings-masked-key') as HTMLSpanElement;
const settingsUpdateKeyBtn = document.getElementById('settings-update-key-btn') as HTMLButtonElement;
const posLeftBtn = document.getElementById('pos-left-btn') as HTMLButtonElement;
const posRightBtn = document.getElementById('pos-right-btn') as HTMLButtonElement;
const settingsDefaultModel = document.getElementById('settings-default-model') as HTMLSelectElement;
const resetPermissionsBtn = document.getElementById('reset-permissions-btn') as HTMLButtonElement;
const chkAutoSummarize = document.getElementById('chk-auto-summarize') as HTMLInputElement;
const chkFullHistory = document.getElementById('chk-full-history') as HTMLInputElement;
const settingsViewUsageBtn = document.getElementById('settings-view-usage-btn') as HTMLButtonElement;
const settingsClearHistoryBtn = document.getElementById('settings-clear-history-btn') as HTMLButtonElement;
const guideTitleText = document.getElementById('guide-title-text') as HTMLSpanElement;
const guideBodyText = document.getElementById('guide-body-text') as HTMLDivElement;
const positionGuideBox = document.getElementById('position-guide-box') as HTMLDivElement;
const guideCloseBtn = document.getElementById('guide-close-btn') as HTMLButtonElement;
const capabilityNoticeBanner = document.getElementById('capability-notice-banner') as HTMLDivElement;
const capabilityNoticeText = document.getElementById('capability-notice-text') as HTMLSpanElement;
const capabilityNoticeClose = document.getElementById('capability-notice-close') as HTMLButtonElement;

// Phase 7: Context Preview & Privacy DOM References
const zdrHiddenBanner = document.getElementById('zdr-hidden-banner') as HTMLDivElement;
const zdrHiddenText = document.getElementById('zdr-hidden-text') as HTMLSpanElement;
const zdrHiddenClose = document.getElementById('zdr-hidden-close') as HTMLButtonElement;
const contextPreviewBar = document.getElementById('context-preview-bar') as HTMLDivElement;
const contextPreviewToggle = document.getElementById('context-preview-toggle') as HTMLDivElement;
const contextPreviewSummary = document.getElementById('context-preview-summary') as HTMLSpanElement;
const contextExpandArrow = document.getElementById('context-expand-arrow') as HTMLSpanElement;
const contextPreviewDetails = document.getElementById('context-preview-details') as HTMLDivElement;
const contextDetailsContent = document.getElementById('context-details-content') as HTMLDivElement;

// Phase 3 Amendment: Persistent Pending-Edits Bar DOM References
const pendingEditsBar = document.getElementById('pending-edits-bar') as HTMLDivElement;
const pendingEditsCountEl = document.getElementById('pending-edits-count') as HTMLSpanElement;
const pendingEditsBulkActions = document.getElementById('pending-edits-bulk-actions') as HTMLDivElement;
const pendingEditsList = document.getElementById('pending-edits-list') as HTMLDivElement;
const applyAllEditsBtn = document.getElementById('apply-all-edits-btn') as HTMLButtonElement;
const rejectAllEditsBtn = document.getElementById('reject-all-edits-btn') as HTMLButtonElement;

// Map of currently pending (unresolved) edit proposals
const pendingEditsMap = new Map<string, { editId: string; filePath: string; newContent: string; cardEl?: HTMLElement }>();

// Privacy Settings DOM References
const chkStrictZdr = document.getElementById('chk-strict-zdr') as HTMLInputElement;
const chkWarnTraining = document.getElementById('chk-warn-training') as HTMLInputElement;
const settingsRedactionMode = document.getElementById('settings-redaction-mode') as HTMLSelectElement;

let previousCapabilities: {
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsTools: boolean;
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: string[];
} | null = null;
let currentReasoningEffort: string | undefined = undefined;
let currentSessionTokens = 0;
let hiddenZdrModelsCount = 0;
let isZdrOnlyPolicyActive = true;
let isWarnOnDataTrainingActive = true;

interface ModelOption {
  id: string;
  name: string;
  context_length?: number;
  supports_zdr?: boolean;
}

interface ProposedEditData {
  filePath: string;
  newContent: string;
  diffExplanation?: string;
}

let loadedModels: ModelOption[] = [];
let currentModelId = '';
let activeAssistantMessageEl: HTMLDivElement | null = null;
let activeAssistantContentEl: HTMLDivElement | null = null;
let lastSentMessage: {
  content: string;
  modelId: string;
  images?: Array<{ name: string; dataUrl: string }>;
  reasoningEffort?: string;
} | null = null;

// Context Preview Toggle
if (contextPreviewToggle) {
  contextPreviewToggle.addEventListener('click', () => {
    const isHidden = contextPreviewDetails.classList.contains('hidden');
    if (isHidden) {
      contextPreviewDetails.classList.remove('hidden');
      contextExpandArrow.classList.add('expanded');
    } else {
      contextPreviewDetails.classList.add('hidden');
      contextExpandArrow.classList.remove('expanded');
    }
  });
}

if (zdrHiddenClose && zdrHiddenBanner) {
  zdrHiddenClose.addEventListener('click', () => {
    zdrHiddenBanner.classList.add('hidden');
  });
}

// Combobox Controller
function filterAndRenderModels(filter: string) {
  modelDropdown.innerHTML = '';
  const search = filter.toLowerCase().trim();

  // If ZDR-only is active, filter models to those supporting ZDR
  const filtered = loadedModels.filter((m) => {
    const matchSearch = m.name.toLowerCase().includes(search) || m.id.toLowerCase().includes(search);
    const matchZdr = isZdrOnlyPolicyActive ? (m.supports_zdr !== false) : true;
    return matchSearch && matchZdr;
  });

  if (filtered.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'combobox-item';
    emptyEl.style.cursor = 'default';
    emptyEl.textContent = 'No matching models';
    modelDropdown.appendChild(emptyEl);
    return;
  }

  filtered.slice(0, 100).forEach((model) => {
    const item = document.createElement('div');
    item.className = 'combobox-item' + (model.id === currentModelId ? ' selected' : '');

    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'space-between';

    const title = document.createElement('div');
    title.className = 'combobox-item-title';
    title.textContent = model.name || model.id;

    // Privacy badge in combobox item
    const zdrBadge = document.createElement('span');
    if (model.supports_zdr !== false) {
      zdrBadge.className = 'combobox-item-zdr ok';
      zdrBadge.textContent = '🛡️ ZDR';
      zdrBadge.title = 'Zero Data Retention / No Training';
    } else {
      zdrBadge.className = 'combobox-item-zdr warn';
      zdrBadge.textContent = '⚠️ May Train';
      zdrBadge.title = 'Provider may retain or train on data';
    }

    titleRow.appendChild(title);
    titleRow.appendChild(zdrBadge);

    const meta = document.createElement('div');
    meta.className = 'combobox-item-meta';
    meta.textContent = `${model.id} • ${model.context_length ? (model.context_length / 1000).toFixed(0) + 'k ctx' : 'standard ctx'}`;

    item.appendChild(titleRow);
    item.appendChild(meta);

    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectModel(model.id, model.name);
      closeDropdown();
    });

    modelDropdown.appendChild(item);
  });
}

function selectModel(modelId: string, modelName?: string) {
  currentModelId = modelId;
  modelSearchInput.value = modelName || modelId;
  vscode.postMessage({ type: 'SELECT_MODEL', modelId });
}

function openDropdown() {
  modelDropdown.classList.remove('hidden');
  filterAndRenderModels(modelSearchInput.value);
}

function closeDropdown() {
  modelDropdown.classList.add('hidden');
}

modelSearchInput.addEventListener('focus', openDropdown);
modelSearchInput.addEventListener('input', () => {
  openDropdown();
  filterAndRenderModels(modelSearchInput.value);
});

let currentSessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messageCount: number }> = [];
let activeSessionId = '';

function toggleSessionDropdown() {
  if (!sessionDropdown) return;
  const isHidden = sessionDropdown.classList.contains('hidden');
  if (isHidden) {
    sessionDropdown.classList.remove('hidden');
    vscode.postMessage({ type: 'GET_SESSIONS' });
  } else {
    sessionDropdown.classList.add('hidden');
  }
}

function closeSessionDropdown() {
  if (sessionDropdown) {
    sessionDropdown.classList.add('hidden');
  }
}

if (newChatBtn) {
  newChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSessionDropdown();
  });
}

if (sessionItemNew) {
  sessionItemNew.addEventListener('click', () => {
    closeSessionDropdown();
    updateTokenMeter(0);
    pendingEditsMap.clear();
    updatePendingEditsBar();
    vscode.postMessage({ type: 'NEW_SESSION' });
  });
}

document.addEventListener('click', (e) => {
  if (!modelSearchInput.contains(e.target as Node) && !modelDropdown.contains(e.target as Node)) {
    closeDropdown();
  }
  if (sessionDropdown && newChatBtn && !newChatBtn.contains(e.target as Node) && !sessionDropdown.contains(e.target as Node)) {
    closeSessionDropdown();
  }
});

function renderSessionsList(
  sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messageCount: number }>,
  currentActiveId: string
) {
  currentSessions = sessions;
  activeSessionId = currentActiveId;

  if (!sessionHistoryList) return;
  sessionHistoryList.innerHTML = '';

  if (sessions.length === 0) {
    sessionHistoryList.innerHTML = `<div style="padding: 8px 12px; font-size: 11px; opacity: 0.5;">No previous chats</div>`;
    return;
  }

  sessions.forEach((s) => {
    const item = document.createElement('div');
    item.className = `session-history-item ${s.id === currentActiveId ? 'active' : ''}`;

    const dateStr = formatRelativeTime(s.updatedAt || s.createdAt);

    const info = document.createElement('div');
    info.className = 'session-history-info';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'session-history-item-title';
    titleSpan.title = s.title;
    titleSpan.textContent = s.title;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'session-history-item-meta';
    metaSpan.textContent = `${dateStr} • ${s.messageCount} msg${s.messageCount === 1 ? '' : 's'}`;

    info.appendChild(titleSpan);
    info.appendChild(metaSpan);

    info.addEventListener('click', () => {
      closeSessionDropdown();
      if (s.id !== activeSessionId) {
        vscode.postMessage({ type: 'SWITCH_SESSION', sessionId: s.id });
      }
    });

    const actions = document.createElement('div');
    actions.className = 'session-history-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'session-history-action-btn session-history-rename-btn';
    renameBtn.title = 'Rename chat session';
    renameBtn.textContent = '✏️';

    let isEditing = false;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isEditing) return;
      isEditing = true;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'session-history-rename-input';
      input.value = s.title;

      const commitRename = () => {
        if (!isEditing) return;
        isEditing = false;
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== s.title) {
          vscode.postMessage({ type: 'RENAME_SESSION', sessionId: s.id, newTitle });
          titleSpan.textContent = newTitle;
          titleSpan.title = newTitle;
        }
        if (input.parentNode) {
          info.replaceChild(titleSpan, input);
        }
      };

      input.addEventListener('click', (ev) => ev.stopPropagation());
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commitRename();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          isEditing = false;
          if (input.parentNode) {
            info.replaceChild(titleSpan, input);
          }
        }
      });
      input.addEventListener('blur', () => {
        commitRename();
      });

      info.replaceChild(input, titleSpan);
      input.focus();
      input.select();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'session-history-action-btn session-history-delete-btn';
    delBtn.title = 'Delete chat session';
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'DELETE_SESSION', sessionId: s.id });
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    item.appendChild(info);
    item.appendChild(actions);
    sessionHistoryList.appendChild(item);
  });
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'OPEN_SETTINGS' });
  });
}

// Host Message Handling
window.addEventListener('message', (event) => {
  const msg = event.data;

  switch (msg.type) {
    case 'AUTH_STATE':
      if (msg.hasKey) {
        authSection.classList.add('hidden');
        chatSection.classList.remove('hidden');
        statusText.textContent = `Connected (${msg.keyLabel || 'Active'})`;
      } else {
        authSection.classList.remove('hidden');
        chatSection.classList.add('hidden');
        statusText.textContent = 'API key required';
      }
      break;

    case 'MODELS_LOADED':
      loadedModels = msg.models || [];
      hiddenZdrModelsCount = msg.hiddenZdrCount || 0;
      if (hiddenZdrModelsCount > 0 && isZdrOnlyPolicyActive && zdrHiddenBanner && zdrHiddenText) {
        zdrHiddenText.textContent = `🛡️ ${hiddenZdrModelsCount} models hidden — they do not support Zero Data Retention (ZDR).`;
        zdrHiddenBanner.classList.remove('hidden');
      } else if (zdrHiddenBanner) {
        zdrHiddenBanner.classList.add('hidden');
      }
      const current = loadedModels.find((m) => m.id === currentModelId);
      if (current) {
        modelSearchInput.value = current.name || current.id;
      }
      break;

    case 'SET_SELECTED_MODEL':
      currentModelId = msg.modelId;
      const found = loadedModels.find((m) => m.id === msg.modelId);
      modelSearchInput.value = found ? found.name || found.id : msg.modelId;
      updateCapabilitiesUI(msg.capabilities, found ? found.name || found.id : msg.modelId);
      updateTokenMeter(currentSessionTokens);

      // Training Warning Banner check
      if (isWarnOnDataTrainingActive && found && found.supports_zdr === false) {
        if (capabilityNoticeBanner && capabilityNoticeText) {
          capabilityNoticeText.textContent = `⚠️ Warning: ${found.name || found.id} does not guarantee Zero Data Retention and may retain or train on inputs.`;
          capabilityNoticeBanner.classList.remove('hidden');
        }
      }
      break;

    case 'CONTEXT_PREVIEW_UPDATE':
      if (contextPreviewBar && contextPreviewSummary && contextDetailsContent) {
        const p = msg.preview;
        const filePart = p.activeFile ? `${p.activeFile}${p.lineRange ? ` (${p.lineRange})` : ''}` : 'No active file';
        const imgPart = p.imageCount > 0 ? ` • ${p.imageCount} image${p.imageCount > 1 ? 's' : ''}` : '';
        const redactPart = p.redactedCount > 0 ? ` • 🛡️ ${p.redactedCount} secret${p.redactedCount > 1 ? 's' : ''} masked` : '';
        const zdrPart = p.hasZdrOnly ? ' • 🛡️ ZDR' : '';

        contextPreviewSummary.textContent = `Context: ${filePart}${imgPart}${redactPart}${zdrPart}`;

        let detailsHtml = `
          <div class="context-detail-item">
            <span>Active Editor Context</span>
            <span>${escapeHtml(filePart)}</span>
          </div>
        `;

        if (p.contentSnippet) {
          detailsHtml += `
            <div class="context-detail-item context-detail-snippet">
              <span style="display:block;margin-bottom:2px;font-size:10px;opacity:0.75;">Live Editor Buffer Preview:</span>
              <pre style="margin:0;padding:4px 6px;background:rgba(0,0,0,0.3);border-radius:4px;max-height:120px;overflow:auto;font-size:10px;font-family:monospace;white-space:pre-wrap;"><code>${escapeHtml(p.contentSnippet)}</code></pre>
            </div>
          `;
        }

        if (p.referencedFile) {
          detailsHtml += `
            <div class="context-detail-item">
              <span>Referenced File</span>
              <span>${escapeHtml(p.referencedFile.path)}</span>
            </div>
          `;
          if (p.referencedFile.contentSnippet) {
            detailsHtml += `
              <div class="context-detail-item context-detail-snippet">
                <span style="display:block;margin-bottom:2px;font-size:10px;opacity:0.75;">Referenced File Preview:</span>
                <pre style="margin:0;padding:4px 6px;background:rgba(0,0,0,0.3);border-radius:4px;max-height:100px;overflow:auto;font-size:10px;font-family:monospace;white-space:pre-wrap;"><code>${escapeHtml(p.referencedFile.contentSnippet)}</code></pre>
              </div>
            `;
          }
        }

        if (p.imageCount > 0) {
          detailsHtml += `<div class="context-detail-item"><span>Images Attached</span><span>${p.imageCount}</span></div>`;
        }

        detailsHtml += `
          <div class="context-detail-item">
            <span>Secret Redaction</span>
            <span class="${p.redactedCount > 0 ? 'context-redaction-pill' : ''}">${p.redactedCount > 0 ? `🛡️ ${p.redactedCount} detected & masked` : 'Clean (none)'}</span>
          </div>
          <div class="context-detail-item">
            <span>Provider Routing Policy</span>
            <span>${p.hasZdrOnly ? 'Strict Zero Data Retention (ZDR)' : 'Standard Routing'}</span>
          </div>
        `;

        contextDetailsContent.innerHTML = detailsHtml;
        contextPreviewBar.classList.remove('hidden');
      }
      break;

    case 'HISTORY_LOADED':
      messagesContainer.innerHTML = '';
      pendingEditsMap.clear();
      updatePendingEditsBar();
      if (msg.activeSessionId) {
        activeSessionId = msg.activeSessionId;
      }
      if (msg.messages && Array.isArray(msg.messages)) {
        msg.messages.forEach((m: { id: string; role: string; content: string; images?: Array<{ name: string; dataUrl: string }>; checkpointId?: string; affectedFiles?: string[] }) => {
          appendMessage(m.role, m.content, m.images, true, m.id, m.checkpointId, m.affectedFiles);
        });

        // Compute/reset session tokens for the loaded conversation
        if (msg.messages.length === 0) {
          updateTokenMeter(0);
        } else {
          // Rough approximation: ~4 characters per token across all messages in session
          const totalChars = msg.messages.reduce((acc: number, m: { content?: string }) => acc + (m.content?.length || 0), 0);
          updateTokenMeter(Math.round(totalChars / 4));
        }
      } else {
        updateTokenMeter(0);
      }
      break;

    case 'SESSIONS_LOADED':
      renderSessionsList(msg.sessions || [], msg.activeSessionId || '');
      break;

    case 'MESSAGE_STREAM_START':
      activeAssistantMessageEl = document.createElement('div');
      activeAssistantMessageEl.className = 'message assistant';

      const streamHeader = document.createElement('div');
      streamHeader.className = 'message-header';

      const roleTag = document.createElement('div');
      roleTag.className = 'role-tag';
      roleTag.textContent = 'OpenRouter';
      streamHeader.appendChild(roleTag);

      activeAssistantContentEl = document.createElement('div');
      activeAssistantContentEl.className = 'message-body';
      activeAssistantContentEl.textContent = '';

      activeAssistantMessageEl.appendChild(streamHeader);
      activeAssistantMessageEl.appendChild(activeAssistantContentEl);
      messagesContainer.appendChild(activeAssistantMessageEl);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      updateAllUndoButtonsAvailability();
      break;

    case 'MESSAGE_STREAM_CHUNK':
      if (activeAssistantContentEl) {
        activeAssistantContentEl.textContent += msg.chunk;
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
      break;

    case 'MESSAGE_STREAM_DONE':
      if (activeAssistantContentEl) {
        const fullText = activeAssistantContentEl.textContent || '';
        activeAssistantContentEl.textContent = '';
        renderFormattedContent(fullText, activeAssistantContentEl);
        parseAndRenderActions(fullText, activeAssistantMessageEl);

        // Add copy & clarify buttons to header now that content is complete
        if (activeAssistantMessageEl) {
          const header = activeAssistantMessageEl.querySelector('.message-header');
          if (header && !header.querySelector('.message-header-actions')) {
            const headerActions = document.createElement('div');
            headerActions.className = 'message-header-actions';

            const quoteBtn = document.createElement('button');
            quoteBtn.className = 'msg-quote-btn';
            quoteBtn.title = 'Quote / Ask for clarification';
            quoteBtn.innerHTML = `
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>Clarify</span>
            `;
            quoteBtn.addEventListener('click', () => {
              quoteAspectToInput(fullText);
            });
            headerActions.appendChild(quoteBtn);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'msg-copy-btn';
            copyBtn.title = 'Copy response';
            copyBtn.innerHTML = `
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            `;
            copyBtn.addEventListener('click', () => {
              navigator.clipboard.writeText(fullText).then(() => {
                const span = copyBtn.querySelector('span');
                if (span) span.textContent = 'Copied!';
                setTimeout(() => {
                  if (span) span.textContent = 'Copy';
                }, 1800);
              });
            });
            headerActions.appendChild(copyBtn);
            header.appendChild(headerActions);
          }
        }
      }
      activeAssistantMessageEl = null;
      activeAssistantContentEl = null;
      if (msg.usage) {
        updateTokenMeter(msg.usage.total_tokens || 0);
      }
      updateAllUndoButtonsAvailability();
      break;

    case 'PROPOSE_EDIT':
      renderEditProposal(msg.editId, msg.edit);
      break;

    case 'EDIT_APPLIED': {
      markEditResolved(msg.editId, 'applied', msg.checkpointId);
      const card = document.getElementById(`edit-card-${msg.editId}`);
      if (card) {
        // Remove active action buttons (Preview, Apply, Reject) once a choice is made
        const actionsEl = card.querySelector('.diff-actions');
        if (actionsEl) {
          actionsEl.innerHTML = '';
        }

        const badge = document.createElement('div');
        badge.id = `edit-status-${msg.editId}`;
        badge.style.color = msg.success ? '#7ee787' : '#d73a49';
        badge.style.fontSize = '11px';
        badge.style.padding = '6px 10px';
        badge.textContent = msg.success ? '✓ Applied' : '✗ Failed to apply';
        card.appendChild(badge);

        if (msg.success && msg.checkpointId) {
          // Tag the latest user message element with the checkpointId/affectedFiles
          const lastUserMsg = [...messagesContainer.querySelectorAll('.message.user')].at(-1);
          if (lastUserMsg) {
            const undoBtn = lastUserMsg.querySelector('.msg-undo-btn') as HTMLButtonElement | null;
            if (undoBtn) {
              undoBtn.dataset.checkpointId = msg.checkpointId;
              const existing: string[] = undoBtn.dataset.affectedFiles
                ? JSON.parse(undoBtn.dataset.affectedFiles)
                : [];
              const card = document.getElementById(`edit-card-${msg.editId}`);
              const filePathEl = card?.querySelector('.diff-file-path');
              if (filePathEl?.textContent) {
                existing.push(filePathEl.textContent);
              }
              undoBtn.dataset.affectedFiles = JSON.stringify(Array.from(new Set(existing)));
            }
          }
        }
      }
      break;
    }

    case 'UNDO_RESULT': {
      const undoBtnId = msg.messageId ? `msg-undo-${msg.messageId}` : `undo-btn-${msg.checkpointId}`;
      const undoBtn = document.getElementById(undoBtnId) as HTMLButtonElement | null;
      
      // Always reset the clicked button's label back to "Undo" when the result arrives, regardless of success or failure
      if (undoBtn) {
        const span = undoBtn.querySelector('span');
        if (span) span.textContent = 'Undo';
      }

      if (msg.success && msg.truncatedAfterId) {
        const targetMsg = document.getElementById(`msg-${msg.truncatedAfterId}`) || undoBtn?.closest('.message');
        if (targetMsg) {
          while (targetMsg.nextElementSibling) {
            const el = targetMsg.nextElementSibling as HTMLElement;
            
            // If the element is a diff-card, remove it from the pending edits map
            if (el.classList.contains('diff-card')) {
              const editId = el.id.replace('edit-card-', '');
              if (pendingEditsMap.has(editId)) {
                pendingEditsMap.delete(editId);
              }
            }
            
            // Kill any active transitions and hide before removing to prevent compositor ghosting bugs
            el.style.transition = 'none';
            el.style.display = 'none';
            el.remove();
          }

          // Auto-fill input box with the undone message text
          const rawText = targetMsg.dataset.rawContent;
          if (rawText) {
            promptInput.value = rawText;
            promptInput.focus();
            promptInput.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // Kill transitions and remove the target user message itself
          targetMsg.style.transition = 'none';
          targetMsg.style.display = 'none';
          targetMsg.remove();
        }
        updatePendingEditsBar();
        updateAllUndoButtonsAvailability();
      } else {        
        // Un-dim messages if undo was cancelled or failed
        const currentMsgEl = undoBtn?.closest('.message');
        if (currentMsgEl) {
          const allMessages = Array.from(messagesContainer.querySelectorAll('.message'));
          const idx = allMessages.indexOf(currentMsgEl);
          if (idx !== -1) {
            const subsequent = allMessages.slice(idx + 1);
            subsequent.forEach(m => {
              const el = m as HTMLElement;
              el.style.opacity = '';
              el.style.pointerEvents = '';
            });
          }
        }
        
        updateAllUndoButtonsAvailability();
      }
      break;
    }


    case 'USAGE_REPORT_DATA':
      renderUsageReport(msg.summary, msg.records, msg.projects, msg.models);
      break;

    case 'SETTINGS_DATA':
      renderSettings(msg);
      break;

    case 'MESSAGE_RECEIVED':
      appendMessage(msg.message.role, msg.message.content, msg.message.images);
      break;

    case 'SET_BUSY':
      if (msg.busy) {
        sendBtn.classList.add('hidden');
        if (stopBtn) stopBtn.classList.remove('hidden');
        promptInput.disabled = true;
        statusText.textContent = 'Generating...';
      } else {
        if (stopBtn) stopBtn.classList.add('hidden');
        sendBtn.classList.remove('hidden');
        sendBtn.disabled = false;
        promptInput.disabled = false;
        statusText.textContent = 'Ready';
      }
      break;

    case 'ERROR': {
      statusText.textContent = `Error: ${msg.message}`;

      // Render an in-chat error card with a retry button
      const errorCard = document.createElement('div');
      errorCard.className = 'stream-error-card';
      errorCard.innerHTML = `
        <div class="stream-error-header">
          <span>⚠️</span>
          <span>Request Issue</span>
        </div>
        <div class="stream-error-msg">${escapeHtml(msg.message)}</div>
      `;

      if (msg.canRetry && lastSentMessage) {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'stream-error-actions';

        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-retry';
        retryBtn.innerHTML = `<span>⎌</span><span>Retry Request</span>`;
        retryBtn.addEventListener('click', () => {
          if (!lastSentMessage) return;
          errorCard.remove();
          vscode.postMessage({
            type: 'SEND_MESSAGE',
            content: lastSentMessage.content,
            modelId: lastSentMessage.modelId || currentModelId,
            images: lastSentMessage.images,
            reasoningEffort: lastSentMessage.reasoningEffort,
          });
        });

        actionsDiv.appendChild(retryBtn);
        errorCard.appendChild(actionsDiv);
      }

      if (activeAssistantMessageEl) {
        activeAssistantMessageEl.appendChild(errorCard);
      } else {
        messagesContainer.appendChild(errorCard);
      }
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      activeAssistantMessageEl = null;
      activeAssistantContentEl = null;
      break;
    }

    case 'INSERT_INPUT_TEXT': {
      if (promptInput) {
        if (msg.append && promptInput.value.trim()) {
          promptInput.value = `${promptInput.value.trim()} ${msg.text}`;
        } else {
          promptInput.value = msg.text;
        }
        promptInput.style.height = 'auto';
        promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
        promptInput.focus();
        promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
      }
      break;
    }
  }
});

function parseAndRenderActions(content: string, parentEl: HTMLDivElement | null, isHistory = false) {
  if (!parentEl) return;

  // 1. Detect file creation/edit blocks: ```create_file:path/to/file or ```edit_file:path/to/file
  // Also supports optional language tag: ```create_file:path/to/file:markdown or ```file:path
  const fileActionRegex = /```(?:create_file|edit_file|file):([^\r\n]+)\r?\n([\s\S]*?)```/gi;
  let fileMatch;
  let editCount = 0;
  while ((fileMatch = fileActionRegex.exec(content)) !== null) {
    editCount++;
    let filePath = fileMatch[1].trim();
    // In case model adds a language specifier like "prd.md:markdown",
    // we only want to split if the colon is NOT part of a Windows drive letter.
    const lastColon = filePath.lastIndexOf(':');
    // If there's a colon and it's not the first character after a drive letter (e.g. C:\)
    if (lastColon > 1) {
      const afterColon = filePath.substring(lastColon + 1).trim();
      // If the part after the colon looks like a language tag (no slashes)
      if (!afterColon.includes('/') && !afterColon.includes('\\')) {
        filePath = filePath.substring(0, lastColon).trim();
      }
    }
    const newContent = fileMatch[2];
    const editId = `${Date.now()}-${editCount}`;

    renderEditProposal(
      editId,
      {
        filePath,
        newContent,
      },
      parentEl,
      isHistory
    );
  }

  // 2. Detect bash / terminal command blocks ```bash\ncommand\n```
  const bashRegex = /```(?:bash|sh|shell|cmd|powershell)\s*([\s\S]*?)```/gi;
  let match;
  while ((match = bashRegex.exec(content)) !== null) {
    const command = match[1].trim();
    if (command) {
      renderTerminalRunAction(command, parentEl);
    }
  }

  // 3. Detect Task Summary sections (e.g. "### Summary of changes", "**Task Summary:**", "### Task Summary", etc.)
  renderTaskSummaryCard(content, parentEl);
}

function renderTaskSummaryCard(content: string, parentEl: HTMLElement) {
  // Check if content contains a distinct Summary section header
  const summaryRegex = /(?:^|\n)(?:#{1,4}\s*(?:Task\s+)?Summary(?:.*?)|(?:\*{2}|_{2})(?:Task\s+)?Summary:?(?:\*{2}|_{2}))\s*\n([\s\S]+?)(?=\n#{1,4}\s|\n\*{2}[A-Z]|$)/i;
  const match = summaryRegex.exec(content);
  if (match) {
    const summaryText = match[1].trim();
    if (summaryText && summaryText.length > 10) {
      const summaryCard = document.createElement('div');
      summaryCard.className = 'task-summary-card';

      const header = document.createElement('div');
      header.className = 'task-summary-header';
      header.innerHTML = `<span>📋</span><span>Task Summary</span>`;

      const body = document.createElement('div');
      body.className = 'task-summary-body';
      renderFormattedContent(summaryText, body);

      summaryCard.appendChild(header);
      summaryCard.appendChild(body);
      parentEl.appendChild(summaryCard);
    }
  }
}

function renderTerminalRunAction(command: string, parentEl: HTMLElement) {
  const card = document.createElement('div');
  card.className = 'diff-card';

  const header = document.createElement('div');
  header.className = 'diff-header';
  header.innerHTML = `<span>Terminal Command</span><span style="font-family: monospace; opacity: 0.8;">${escapeHtml(command.slice(0, 30))}</span>`;

  const actions = document.createElement('div');
  actions.className = 'diff-actions';

  const runBtn = document.createElement('button');
  runBtn.className = 'btn';
  runBtn.textContent = '▶ Run in Terminal';
  runBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'RUN_TERMINAL', command });
  });

  actions.appendChild(runBtn);
  card.appendChild(header);
  card.appendChild(actions);
  parentEl.appendChild(card);
}

function updatePendingEditsBar() {
  if (!pendingEditsBar || !pendingEditsList || !pendingEditsCountEl) return;

  const pendingList = Array.from(pendingEditsMap.values());
  const count = pendingList.length;

  if (count === 0) {
    pendingEditsBar.classList.add('hidden');
    pendingEditsList.innerHTML = '';
    return;
  }

  pendingEditsBar.classList.remove('hidden');
  pendingEditsCountEl.textContent = `Pending Edits (${count})`;

  // PRD Item 3: Show Apply All / Reject All only when there are 3 or more pending edits
  if (pendingEditsBulkActions) {
    if (count >= 3) {
      pendingEditsBulkActions.classList.remove('hidden');
    } else {
      pendingEditsBulkActions.classList.add('hidden');
    }
  }

  pendingEditsList.innerHTML = '';
  pendingList.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'pending-edit-row';
    row.id = `pending-row-${item.editId}`;

    const info = document.createElement('div');
    info.className = 'pending-edit-info';

    const fileSpan = document.createElement('span');
    fileSpan.className = 'pending-edit-file';
    fileSpan.textContent = item.filePath;
    fileSpan.title = item.filePath;
    info.appendChild(fileSpan);

    const actions = document.createElement('div');
    actions.className = 'pending-edit-actions';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn secondary btn-sm';
    prevBtn.textContent = 'Preview';
    prevBtn.title = 'Preview Diff';
    prevBtn.addEventListener('click', () => {
      vscode.postMessage({
        type: 'PREVIEW_DIFF',
        filePath: item.filePath,
        newContent: item.newContent,
      });
    });

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-sm';
    applyBtn.textContent = 'Apply';
    applyBtn.title = 'Apply this edit';
    applyBtn.addEventListener('click', () => {
      applySinglePendingEdit(item.editId);
    });

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'btn secondary btn-sm';
    rejectBtn.textContent = 'Reject';
    rejectBtn.title = 'Reject this edit';
    rejectBtn.addEventListener('click', () => {
      rejectSinglePendingEdit(item.editId);
    });

    actions.appendChild(prevBtn);
    actions.appendChild(applyBtn);
    actions.appendChild(rejectBtn);

    row.appendChild(info);
    row.appendChild(actions);
    pendingEditsList.appendChild(row);
  });
}

function applySinglePendingEdit(editId: string) {
  const item = pendingEditsMap.get(editId);
  if (!item) return;

  markEditResolved(editId, 'applied');
  pendingEditsMap.delete(editId);
  updatePendingEditsBar();

  if (item.cardEl) {
    const cardApplyBtn = item.cardEl.querySelector('.btn') as HTMLButtonElement;
    if (cardApplyBtn) cardApplyBtn.disabled = true;
  }

  vscode.postMessage({
    type: 'ACCEPT_EDIT',
    editId,
    filePath: item.filePath,
    newContent: item.newContent,
  });
}

function rejectSinglePendingEdit(editId: string) {
  const item = pendingEditsMap.get(editId);
  if (!item) return;

  markEditResolved(editId, 'rejected');
  pendingEditsMap.delete(editId);
  updatePendingEditsBar();

  if (item.cardEl) {
    item.cardEl.remove();
  }

  vscode.postMessage({ type: 'REJECT_EDIT', editId });
}

// Bulk Actions: Apply All and Reject All (PRD Item 3 & Item 5)
if (applyAllEditsBtn) {
  applyAllEditsBtn.addEventListener('click', () => {
    const pendingList = Array.from(pendingEditsMap.values());
    if (pendingList.length === 0) return;

    // Mark all as applied locally and remove from pending map
    pendingList.forEach((item) => {
      markEditResolved(item.editId, 'applied');
      if (item.cardEl) {
        const cardApplyBtn = item.cardEl.querySelector('.btn') as HTMLButtonElement;
        if (cardApplyBtn) cardApplyBtn.disabled = true;
      }
    });

    pendingEditsMap.clear();
    updatePendingEditsBar();

    // Send unified ACCEPT_ALL_EDITS message so shadow-git creates ONE checkpoint for all affected files
    vscode.postMessage({
      type: 'ACCEPT_ALL_EDITS',
      edits: pendingList.map((item) => ({
        editId: item.editId,
        filePath: item.filePath,
        newContent: item.newContent,
      })),
    });
  });
}

if (rejectAllEditsBtn) {
  rejectAllEditsBtn.addEventListener('click', () => {
    const pendingList = Array.from(pendingEditsMap.values());
    if (pendingList.length === 0) return;

    pendingList.forEach((item) => {
      markEditResolved(item.editId, 'rejected');
      if (item.cardEl) {
        item.cardEl.remove();
      }
      vscode.postMessage({ type: 'REJECT_EDIT', editId: item.editId });
    });

    pendingEditsMap.clear();
    updatePendingEditsBar();
  });
}

function renderEditProposal(editId: string, edit: ProposedEditData, parentEl?: HTMLElement, isHistory = false) {
  // Resolve per proposal instance (editId) so a file previously applied or edited can be edited again
  const previousResolution = resolvedEdits[editId];

  // If user previously rejected this edit proposal, do not show approval card
  if (previousResolution?.status === 'rejected') {
    return;
  }

  const card = document.createElement('div');
  card.className = 'diff-card';
  card.id = `edit-card-${editId}`;

  const header = document.createElement('div');
  header.className = 'diff-header';
  header.innerHTML = `<span>Proposed File</span><span class="diff-file-path">${escapeHtml(edit.filePath)}</span>`;
  card.appendChild(header);

  // Fail-safe render of the code block body
  try {
    const body = document.createElement('div');
    body.className = 'diff-body';
    body.style.marginTop = '8px'; // Add some spacing between header and code
    renderCodeBlock(edit.filePath, edit.newContent, body, document);
    card.appendChild(body);
  } catch (e) {
    // Ultimate fallback if UI code block fails
    const fallbackBody = document.createElement('pre');
    fallbackBody.textContent = edit.newContent;
    card.appendChild(fallbackBody);
  }

  if (previousResolution?.status === 'applied') {
    // Already applied in this conversation: show clean status badge
    const badge = document.createElement('div');
    badge.id = `edit-status-${editId}`;
    badge.style.color = '#7ee787';
    badge.style.fontSize = '11px';
    badge.style.padding = '6px 10px';
    badge.textContent = '✓ Applied';
    card.appendChild(badge);
  } else {
    // Unresolved proposal: track in pending edits bar if active turn
    if (!isHistory) {
      pendingEditsMap.set(editId, {
        editId,
        filePath: edit.filePath,
        newContent: edit.newContent,
        cardEl: card,
      });
      updatePendingEditsBar();
    }

    // Consolidated: Actions (Preview Diff, Apply, Reject) are now handled exclusively
    // in the Persistent Pending-Edits bar sitting above the input bar.
  }

  if (parentEl) {
    parentEl.appendChild(card);
  } else {
    messagesContainer.appendChild(card);
  }
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateCapabilitiesUI(
  caps: {
    supportsVision: boolean;
    supportsAudio: boolean;
    supportsTools: boolean;
    supportsReasoningEffort?: boolean;
    supportedReasoningEfforts?: string[];
  },
  modelName?: string
) {
  if (!caps) return;

  // Drop-with-notice: Check if the previously selected model had capabilities that this model lacks
  if (previousCapabilities) {
    const lost: string[] = [];
    if (previousCapabilities.supportsVision && !caps.supportsVision) lost.push('Vision');
    if (previousCapabilities.supportsAudio && !caps.supportsAudio) lost.push('Audio input');
    if (previousCapabilities.supportsTools && !caps.supportsTools) lost.push('Tool calling');

    if (lost.length > 0 && capabilityNoticeBanner && capabilityNoticeText) {
      const targetName = modelName || 'this model';
      capabilityNoticeText.textContent = `Note: ${lost.join(' & ')} not supported by ${targetName}.`;
      capabilityNoticeBanner.classList.remove('hidden');
    } else if (capabilityNoticeBanner) {
      capabilityNoticeBanner.classList.add('hidden');
    }
  }
  previousCapabilities = caps;

  // Reasoning Effort dropdown visibility and options
  if (reasoningEffortContainer && reasoningEffortSelect) {
    if (caps.supportsReasoningEffort) {
      reasoningEffortContainer.classList.remove('hidden');
      const supportedLevels =
        caps.supportedReasoningEfforts && caps.supportedReasoningEfforts.length > 0
          ? caps.supportedReasoningEfforts
          : ['low', 'medium', 'high'];

      // Re-populate options to only show supported levels
      reasoningEffortSelect.innerHTML = '';
      supportedLevels.forEach((level) => {
        const opt = document.createElement('option');
        opt.value = level.toLowerCase();
        opt.textContent = level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
        reasoningEffortSelect.appendChild(opt);
      });

      // Default to medium if supported, or the middle option, or first
      const defaultChoice = supportedLevels.includes('medium')
        ? 'medium'
        : supportedLevels[Math.floor(supportedLevels.length / 2)] || supportedLevels[0];

      // Keep previously selected effort if still valid for this model; otherwise apply defaultChoice
      if (currentReasoningEffort && supportedLevels.includes(currentReasoningEffort)) {
        reasoningEffortSelect.value = currentReasoningEffort;
      } else {
        reasoningEffortSelect.value = defaultChoice;
        currentReasoningEffort = defaultChoice;
      }
    } else {
      // Model does NOT support reasoning effort: hide dropdown and clear stale effort selection
      reasoningEffortContainer.classList.add('hidden');
      currentReasoningEffort = undefined;
    }
  }

  if (caps.supportsVision) {
    visionBadge.classList.add('active');
    visionBadge.title = 'Vision / Multimodal supported';
    uploadImgBtn.classList.remove('hidden');
  } else {
    visionBadge.classList.remove('active');
    visionBadge.title = 'No vision support';
    uploadImgBtn.classList.add('hidden');
  }

  if (caps.supportsAudio) {
    audioBadge.classList.add('active');
    audioBadge.title = 'Audio input supported';
    voiceInputBtn.classList.remove('hidden');
  } else {
    audioBadge.classList.remove('active');
    audioBadge.title = 'No audio input';
    voiceInputBtn.classList.add('hidden');
  }

  if (caps.supportsTools) {
    toolsBadge.classList.add('active');
    toolsBadge.title = 'Tool calling supported';
  } else {
    toolsBadge.classList.remove('active');
    toolsBadge.title = 'No tool calling';
  }
}

if (reasoningEffortSelect) {
  reasoningEffortSelect.addEventListener('change', () => {
    currentReasoningEffort = reasoningEffortSelect.value;
  });
}

if (capabilityNoticeClose && capabilityNoticeBanner) {
  capabilityNoticeClose.addEventListener('click', () => {
    capabilityNoticeBanner.classList.add('hidden');
  });
}

function updateTokenMeter(tokens: number) {
  if (!tokenMeter) return;
  currentSessionTokens = tokens;
  const currentModel = loadedModels.find((m) => m.id === currentModelId);
  const maxContext = currentModel?.context_length;

  if (maxContext && maxContext > 0) {
    const pct = ((tokens / maxContext) * 100).toFixed(1);
    const maxFormatted =
      maxContext >= 1_000_000
        ? `${(maxContext / 1_000_000).toFixed(1)}M`
        : maxContext >= 1_000
        ? `${Math.round(maxContext / 1_000)}k`
        : `${maxContext}`;

    tokenMeter.textContent = `${tokens.toLocaleString()} / ${maxFormatted} (${pct}%)`;

    const ratio = tokens / maxContext;
    if (ratio > 0.9) {
      tokenMeter.style.color = '#f85149'; // red
      tokenMeter.title = 'Context limit almost reached (>90%)';
    } else if (ratio > 0.75) {
      tokenMeter.style.color = '#d29922'; // orange
      tokenMeter.title = 'Approaching context limit (>75%)';
    } else {
      tokenMeter.style.color = '';
      tokenMeter.title = 'Active conversation tokens / model max context';
    }
  } else {
    tokenMeter.textContent = `${tokens.toLocaleString()} tokens`;
    tokenMeter.style.color = '';
  }
}

function renderInlineMarkdown(text: string, container: HTMLElement) {
  // Regex pattern matching:
  // 1. Inline code: `code`
  // 2. Bold/Italic: ***text***
  // 3. Bold: **text** or __text__
  // 4. Italic: *text* or _text_
  // 5. Clickable file links / standalone filenames: e.g. foo.ts, path/to/file.py
  const inlineRegex = /(`([^`]+)`)|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|__([^_]+)__|(?:\*([^*]+)\*)|(?:_([^_]+)_)|(?:\b)([a-zA-Z0-9_\-./\\]+\.(?:py|js|ts|jsx|tsx|md|json|html|css|yaml|yml|rs|go|c|cpp|h|java|sql|sh|txt))\b/g;

  let lastIndex = 0;
  let match;

  while ((match = inlineRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = inlineRegex.lastIndex;

    // Append preceding plain text
    if (matchStart > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, matchStart)));
    }

    if (match[1]) {
      // Inline code
      const codeContent = match[2];
      // If code block happens to be a recognized workspace file, make it a file link
      if (/\.([a-zA-Z0-9]+)$/.test(codeContent.trim())) {
        const fileLink = document.createElement('span');
        fileLink.className = 'clickable-file-link';
        fileLink.title = `Click to open ${codeContent.trim()}`;
        fileLink.innerHTML = `<span style="font-size: 10px; opacity: 0.7;">📄</span> ${escapeHtml(codeContent.trim())}`;
        fileLink.addEventListener('click', () => {
          vscode.postMessage({ type: 'OPEN_FILE', filePath: codeContent.trim() });
        });
        container.appendChild(fileLink);
      } else {
        const codeEl = document.createElement('code');
        codeEl.className = 'inline-code';
        codeEl.textContent = codeContent;
        container.appendChild(codeEl);
      }
    } else if (match[3]) {
      // Bold + Italic
      const strong = document.createElement('strong');
      const em = document.createElement('em');
      em.textContent = match[3];
      strong.appendChild(em);
      container.appendChild(strong);
    } else if (match[4] || match[5]) {
      // Bold
      const strong = document.createElement('strong');
      strong.textContent = match[4] || match[5];
      container.appendChild(strong);
    } else if (match[6] || match[7]) {
      // Italic
      const em = document.createElement('em');
      em.textContent = match[6] || match[7];
      container.appendChild(em);
    } else if (match[8]) {
      // Standalone filename
      const matchedFile = match[8];
      const fileLink = document.createElement('span');
      fileLink.className = 'clickable-file-link';
      fileLink.title = `Click to open ${matchedFile}`;
      fileLink.innerHTML = `<span style="font-size: 10px; opacity: 0.7;">📄</span> ${escapeHtml(matchedFile)}`;
      fileLink.addEventListener('click', () => {
        vscode.postMessage({ type: 'OPEN_FILE', filePath: matchedFile });
      });
      container.appendChild(fileLink);
    }

    lastIndex = matchEnd;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderFormattedContent(rawText: string, container: HTMLElement, role?: string) {
  // Strip out custom action blocks (create_file, edit_file, etc.) from displayed text 
  // because they will be rendered as interactive action cards below the message
  const cleanedText = rawText.replace(/```(?:create_file|edit_file|file):([^\r\n]+)\r?\n([\s\S]*?)```/gi, '').trim();

  // Determine appropriate action verb for code block labels
  const actionVerb = role === 'user' ? 'pasted' : 'written';

  // Split content by fenced code blocks: ```lang\ncode\n```
  const fenceRegex = /```([a-zA-Z0-9_\-+#]*)\r?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(cleanedText)) !== null) {
    const preText = cleanedText.slice(lastIndex, match.index);
    if (preText) {
      renderMarkdownBlocks(preText, container);
    }

    const lang = (match[1] || 'text').trim();
    const code = match[2];
    
    renderCodeBlock(lang, code, container, document, { actionVerb });

    lastIndex = fenceRegex.lastIndex;
  }

  const remaining = cleanedText.slice(lastIndex);
  if (remaining) {
    renderMarkdownBlocks(remaining, container);
  }
}

function renderMarkdownBlocks(text: string, container: HTMLElement) {
  const lines = text.split(/\r?\n/);
  let currentList: HTMLUListElement | HTMLOListElement | null = null;
  let listType: 'ul' | 'ol' | null = null;
  let currentParagraphLines: string[] = [];

  const flushParagraph = () => {
    if (currentParagraphLines.length > 0) {
      const p = document.createElement('p');
      currentParagraphLines.forEach((line, idx) => {
        if (idx > 0) p.appendChild(document.createElement('br'));
        renderInlineMarkdown(line, p);
      });
      container.appendChild(p);
      currentParagraphLines = [];
    }
  };

  const flushList = () => {
    if (currentList) {
      container.appendChild(currentList);
      currentList = null;
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Blank line
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    // 2. Horizontal Rule (---, ***, ___)
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      flushList();
      container.appendChild(document.createElement('hr'));
      continue;
    }

    // 3. Headings (# H1, ## H2, etc.)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(headingMatch[1].length, 4);
      const heading = document.createElement(`h${level}`);
      renderInlineMarkdown(headingMatch[2], heading);
      container.appendChild(heading);
      continue;
    }

    // 4. Blockquote (> quote)
    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      const bq = document.createElement('blockquote');
      renderInlineMarkdown(quoteMatch[1], bq);
      container.appendChild(bq);
      continue;
    }

    // 5. Unordered list (- item, * item)
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (!currentList || listType !== 'ul') {
        flushList();
        currentList = document.createElement('ul');
        listType = 'ul';
      }
      const li = document.createElement('li');
      renderInlineMarkdown(ulMatch[2], li);
      currentList.appendChild(li);
      continue;
    }

    // 6. Ordered list (1. item, 2. item)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (!currentList || listType !== 'ol') {
        flushList();
        currentList = document.createElement('ol');
        listType = 'ol';
      }
      const li = document.createElement('li');
      renderInlineMarkdown(olMatch[2], li);
      currentList.appendChild(li);
      continue;
    }

    // Regular line in paragraph
    flushList();
    currentParagraphLines.push(line);
  }

  flushParagraph();
  flushList();
}

function updateAllUndoButtonsAvailability() {
  const allMessages = Array.from(messagesContainer.querySelectorAll('.message'));
  allMessages.forEach((msgEl, idx) => {
    if (msgEl.classList.contains('user')) {
      const undoBtn = msgEl.querySelector('.msg-undo-btn') as HTMLButtonElement | null;
      if (undoBtn) {
        const subsequent = allMessages.slice(idx + 1);
        if (subsequent.length > 0) {
          undoBtn.disabled = false;
          undoBtn.title = 'Undo this turn\'s AI changes and rewind conversation';
        } else {
          undoBtn.disabled = true;
          undoBtn.title = 'No subsequent messages or AI response to undo';
        }
      }
    }
  });
}

function appendMessage(
  role: string,
  content: string,
  images?: Array<{ name: string; dataUrl: string }>,
  isHistory = false,
  messageId?: string,
  checkpointId?: string,
  affectedFiles?: string[]
) {
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;
  msgEl.dataset.rawContent = content;
  if (messageId) {
    msgEl.id = `msg-${messageId}`;
  }

  const headerEl = document.createElement('div');
  headerEl.className = 'message-header';

  const roleTag = document.createElement('div');
  roleTag.className = 'role-tag';
  roleTag.textContent = role === 'user' ? 'You' : 'OpenRouter';
  headerEl.appendChild(roleTag);

  const headerActions = document.createElement('div');
  headerActions.className = 'message-header-actions';

  // Add "Clarify" quote button for assistant messages
  if (role === 'assistant') {
    const quoteBtn = document.createElement('button');
    quoteBtn.className = 'msg-quote-btn';
    quoteBtn.title = 'Quote / Ask for clarification';
    quoteBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <span>Clarify</span>
    `;
    quoteBtn.addEventListener('click', () => {
      quoteAspectToInput(content);
    });
    headerActions.appendChild(quoteBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-copy-btn';
  copyBtn.title = 'Copy message';
  copyBtn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span>Copy</span>
  `;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(content).then(() => {
      const span = copyBtn.querySelector('span');
      if (span) span.textContent = 'Copied!';
      setTimeout(() => {
        if (span) span.textContent = 'Copy';
      }, 1800);
    });
  });
  headerActions.appendChild(copyBtn);

  // Always-visible Undo safety net on every user message.
  // Becomes active once that user message has received an AI response (something to undo).
  if (role === 'user') {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'msg-undo-btn';
    if (messageId) {
      undoBtn.id = `msg-undo-${messageId}`;
    }
    // Store checkpoint metadata in dataset so the click handler can read it
    if (checkpointId) {
      undoBtn.dataset.checkpointId = checkpointId;
      undoBtn.dataset.affectedFiles = JSON.stringify(affectedFiles ?? []);
    }
    undoBtn.disabled = true;
    undoBtn.title = 'No subsequent messages or AI response to undo';
    undoBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 14 4 9 9 4"></polyline>
        <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
      </svg>
      <span>Undo</span>
    `;
    undoBtn.addEventListener('click', () => {
      console.log('[undo] button clicked', { messageId, btnId: undoBtn.id, disabled: undoBtn.disabled });
      const currentMsgEl = undoBtn.closest('.message');
      console.log('[undo] currentMsgEl:', currentMsgEl);
      if (!currentMsgEl) return;
      const allMessages = Array.from(messagesContainer.querySelectorAll('.message'));
      const idx = allMessages.indexOf(currentMsgEl);
      console.log('[undo] allMessages count:', allMessages.length, 'idx:', idx);
      if (idx === -1) return;
      const subsequent = allMessages.slice(idx + 1);
      console.log('[undo] subsequent count:', subsequent.length);
      if (subsequent.length === 0) {
        console.log('[undo] subsequent is 0, safe no-op');
        return;
      }

      const files: string[] = undoBtn.dataset.affectedFiles
        ? JSON.parse(undoBtn.dataset.affectedFiles)
        : [];
      const cpId = undoBtn.dataset.checkpointId || '';
      const msgId = undoBtn.id.replace('msg-undo-', '') || '';

      undoBtn.disabled = true;
      const span = undoBtn.querySelector('span');
      if (span) span.textContent = 'Undoing...';

      console.log('[undo] posting UNDO_TURN to host:', { messageId: msgId, checkpointId: cpId, affectedFiles: files });
      vscode.postMessage({
        type: 'UNDO_TURN',
        messageId: msgId,
        checkpointId: cpId,
        affectedFiles: files,
      });
    });
    headerActions.appendChild(undoBtn);
  }

  headerEl.appendChild(headerActions);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'message-body';

  if (images && images.length > 0) {
    images.forEach((img) => {
      const imgEl = document.createElement('img');
      imgEl.className = 'message-attachment-thumb';
      imgEl.src = img.dataUrl;
      imgEl.alt = img.name || 'Attachment';
      bodyEl.appendChild(imgEl);
    });
  }

  renderFormattedContent(content, bodyEl, role);

  msgEl.appendChild(headerEl);
  msgEl.appendChild(bodyEl);
  messagesContainer.appendChild(msgEl);

  if (role === 'assistant') {
    parseAndRenderActions(content, msgEl, isHistory);
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  updateAllUndoButtonsAvailability();
}

saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    saveKeyBtn.disabled = true;
    saveKeyBtn.textContent = 'Validating...';
    vscode.postMessage({ type: 'SUBMIT_API_KEY', apiKey: key });
  }
});

function sendMessage() {
  let text = promptInput.value.trim();
  const currentImages: Array<{ name: string; dataUrl: string }> = [];

  attachments.forEach(att => {
    if (att.isImage) {
      currentImages.push({ name: att.name, dataUrl: att.data });
    } else {
      // Append text file content to message text
      const formatted = `\n\`\`\`${att.name}\n${att.data}\n\`\`\`\n`;
      text = text ? text.trimEnd() + formatted : formatted.trimStart();
    }
  });

  if ((!text && currentImages.length === 0) || sendBtn.disabled) return;

  // Generate a client-side message ID that the host will reuse when storing the message,
  // so the undo button ID written here matches the ID the host will use to tagTurnCheckpoint.
  const userMessageId = `${Date.now()}-user`;

  // Read latest selected reasoning effort directly from select element if visible
  const effortToSend =
    reasoningEffortContainer && !reasoningEffortContainer.classList.contains('hidden') && reasoningEffortSelect
      ? reasoningEffortSelect.value
      : undefined;

  lastSentMessage = {
    content: text,
    modelId: currentModelId,
    images: currentImages.length > 0 ? [...currentImages] : undefined,
    reasoningEffort: effortToSend,
  };

  appendMessage('user', text, currentImages, false, userMessageId);
  clearAttachments();
  promptInput.value = '';
  promptInput.style.height = '24px';
  vscode.postMessage({
    type: 'SEND_MESSAGE',
    messageId: userMessageId,
    content: text,
    modelId: currentModelId,
    images: currentImages,
    reasoningEffort: effortToSend,
  });
}

sendBtn.addEventListener('click', sendMessage);
if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'STOP_STREAM' });
  });
}

// Attachment events: File Picker
if (uploadImgBtn && imageFileInput) {
  uploadImgBtn.addEventListener('click', (e) => {
    e.preventDefault();
    imageFileInput.click();
  });

  imageFileInput.addEventListener('change', () => {
    const file = imageFileInput.files?.[0];
    if (file) {
      processImageFile(file);
    }
  });
}

// Attachment events: Clipboard Paste
window.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        if (item.type.startsWith('image/')) {
          processImageFile(file);
        } else {
          processTextFile(file);
        }
      }
    }
  }
});

// Attachment events: Drag and Drop
['dragenter', 'dragover'].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    const e = event as DragEvent;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    if (inputBoxWrapper) {
      inputBoxWrapper.classList.add('drag-over');
    }
  }, true);
});

['dragleave', 'dragend'].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    const e = event as DragEvent;
    e.preventDefault();
    e.stopPropagation();
    // Remove styling if leaving the document area
    if (!e.relatedTarget || e.relatedTarget === document.documentElement || e.relatedTarget === document.body) {
      if (inputBoxWrapper) {
        inputBoxWrapper.classList.remove('drag-over');
      }
    }
  }, true);
});

window.addEventListener('drop', (e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  if (inputBoxWrapper) {
    inputBoxWrapper.classList.remove('drag-over');
  }

  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        processImageFile(file);
      } else {
        processTextFile(file);
      }
    }
  }
}, true);

promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

const contextHistoryBtn = document.getElementById('context-history-btn') as HTMLButtonElement;
if (contextHistoryBtn) {
  contextHistoryBtn.addEventListener('click', () => {
    promptInput.value += (promptInput.value ? ' ' : '') + '@';
    promptInput.focus();
  });
}

if (copyInputBtn) {
  copyInputBtn.addEventListener('click', () => {
    const val = promptInput.value;
    if (!val) return;
    navigator.clipboard.writeText(val).then(() => {
      const origTitle = copyInputBtn.title;
      copyInputBtn.title = 'Copied!';
      copyInputBtn.style.color = '#7ee787';
      setTimeout(() => {
        copyInputBtn.title = origTitle;
        copyInputBtn.style.color = '';
      }, 1800);
    });
  });
}

function quoteAspectToInput(aspectText: string) {
  const trimmed = aspectText.trim();
  if (!trimmed) return;

  // Format as blockquote with markdown syntax
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  const placeholderPrompt = 'Can you clarify: ';
  const currentVal = promptInput.value.trim();

  promptInput.value = currentVal
    ? `${currentVal}\n\n${quoted}\n\n${placeholderPrompt}`
    : `${quoted}\n\n${placeholderPrompt}`;

  // Automatically adjust input height and focus
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
  promptInput.focus();

  // Position cursor at the very end
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
}

// Floating Selection Toolbar for Assistant Output
const floatingQuoteBtn = document.createElement('button');
floatingQuoteBtn.className = 'floating-quote-btn hidden';
floatingQuoteBtn.innerHTML = `
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
  </svg>
  <span>Clarify Selection</span>
`;
document.body.appendChild(floatingQuoteBtn);

let selectedAssistantSnippet = '';

function hideFloatingQuoteBtn() {
  floatingQuoteBtn.classList.add('hidden');
  selectedAssistantSnippet = '';
}

floatingQuoteBtn.addEventListener('mousedown', (e) => {
  e.preventDefault(); // Prevent clearing selection before click
});

floatingQuoteBtn.addEventListener('click', () => {
  if (selectedAssistantSnippet) {
    quoteAspectToInput(selectedAssistantSnippet);
    hideFloatingQuoteBtn();
    window.getSelection()?.removeAllRanges();
  }
});

document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    hideFloatingQuoteBtn();
    return;
  }

  const selectedStr = selection.toString().trim();
  if (!selectedStr || selectedStr.length < 2) {
    hideFloatingQuoteBtn();
    return;
  }

  // Ensure the selection originated inside an assistant message
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorEl = (anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement);
  const focusEl = (focusNode instanceof HTMLElement ? focusNode : focusNode?.parentElement);

  const assistantMsg = anchorEl?.closest('.message.assistant') || focusEl?.closest('.message.assistant');
  if (!assistantMsg) {
    hideFloatingQuoteBtn();
    return;
  }

  selectedAssistantSnippet = selectedStr;

  // Calculate coordinates to float button above the selection
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (rect && rect.width > 0 && rect.height > 0) {
    floatingQuoteBtn.classList.remove('hidden');
    const top = Math.max(10, rect.top - 36);
    const left = Math.max(10, Math.min(window.innerWidth - 140, rect.left + (rect.width / 2) - 55));
    floatingQuoteBtn.style.top = `${top}px`;
    floatingQuoteBtn.style.left = `${left}px`;
  }
});

document.addEventListener('mousedown', (e) => {
  if (e.target !== floatingQuoteBtn && !floatingQuoteBtn.contains(e.target as Node)) {
    hideFloatingQuoteBtn();
  }
});

// Audio / Voice Input handling (Speech-to-Text via Web Speech API)
let recognition: any = null;
let isRecording = false;

const SpeechRecognitionAPI =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

if (voiceInputBtn) {
  if (SpeechRecognitionAPI) {
    recognition = new SpeechRecognitionAPI();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onstart = () => {
      isRecording = true;
      voiceInputBtn.classList.add('recording');
      voiceInputBtn.title = 'Listening... Click to stop';
      statusText.textContent = 'Listening to voice input...';
    };

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      if (transcript) {
        promptInput.value = promptInput.value
          ? promptInput.value.trimEnd() + ' ' + transcript
          : transcript;
        promptInput.style.height = 'auto';
        promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
      }
    };

    recognition.onerror = (event: any) => {
      console.warn('Speech recognition error:', event.error);
      isRecording = false;
      voiceInputBtn.classList.remove('recording');
      voiceInputBtn.title = 'Voice input';
      statusText.textContent = event.error === 'not-allowed' ? 'Microphone access denied' : 'Voice input error';
    };

    recognition.onend = () => {
      isRecording = false;
      voiceInputBtn.classList.remove('recording');
      voiceInputBtn.title = 'Voice input';
      statusText.textContent = 'Ready';
    };

    voiceInputBtn.addEventListener('click', () => {
      if (!isRecording) {
        try {
          recognition.start();
        } catch (e) {
          console.error(e);
        }
      } else {
        recognition.stop();
      }
    });
  } else {
    // Fallback: Web Speech API unavailable in this webview environment
    voiceInputBtn.addEventListener('click', () => {
      statusText.textContent = 'Speech recognition is not supported in this environment.';
      setTimeout(() => {
        statusText.textContent = 'Ready';
      }, 3000);
    });
  }
}

if (usageBackBtn) {
  usageBackBtn.addEventListener('click', () => {
    viewUsage.classList.add('hidden');
    viewSettings.classList.remove('hidden');
  });
}

let cachedUsageRecords: any[] = [];

function renderUsageReport(
  summary: { today: number; thisWeek: number; thisMonth: number; total: number },
  records: any[],
  projects: string[],
  models: string[]
) {
  cachedUsageRecords = records || [];

  // 1. Update spend summary cards
  spendTodayEl.textContent = formatCurrency(summary.today);
  spendWeekEl.textContent = formatCurrency(summary.thisWeek);
  spendMonthEl.textContent = formatCurrency(summary.thisMonth);

  // 2. Populate filter dropdowns
  const currentProject = filterProject.value;
  filterProject.innerHTML = '<option value="all">All Projects</option>';
  projects.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === currentProject) opt.selected = true;
    filterProject.appendChild(opt);
  });

  const currentModel = filterModel.value;
  filterModel.innerHTML = '<option value="all">All Models</option>';
  models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === currentModel) opt.selected = true;
    filterModel.appendChild(opt);
  });

  filterAndRenderTable();
}

function filterAndRenderTable() {
  const selectedProj = filterProject.value;
  const selectedMod = filterModel.value;

  const filtered = cachedUsageRecords.filter((r) => {
    const matchProj = selectedProj === 'all' || r.project === selectedProj;
    const matchMod = selectedMod === 'all' || r.model === selectedMod;
    return matchProj && matchMod;
  });

  auditTableBody.innerHTML = '';

  if (filtered.length === 0) {
    auditTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; opacity:0.6; padding:16px;">No records match filters</td></tr>`;
    exportCsvBtn.textContent = '📥 Export CSV (0)';
    exportCsvBtn.disabled = true;
    return;
  }

  exportCsvBtn.textContent = `📥 Export CSV (${filtered.length})`;
  exportCsvBtn.disabled = false;

  filtered.forEach((r) => {
    const tr = document.createElement('tr');
    const timeStr = new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let typePill = '';
    let target = '';
    let inputTokens = '-';
    let outputTokens = '-';
    let cost = '-';

    if (r.type === 'terminal_command') {
      typePill = '<span class="type-pill terminal">💻 Terminal</span>';
      target = escapeHtml(r.command || '');
    } else {
      typePill = '<span class="type-pill chat">💬 Chat</span>';
      target = escapeHtml(r.model || 'unknown');
      inputTokens = `${(r.promptTokens || 0).toLocaleString()}`;
      outputTokens = `${(r.completionTokens || 0).toLocaleString()}`;
      cost = formatCurrency(r.cost || 0);
    }

    tr.innerHTML = `
      <td style="opacity:0.8;">${timeStr}</td>
      <td>${typePill}</td>
      <td style="font-family:monospace; max-width:140px; overflow:hidden; text-overflow:ellipsis;" title="${target}">${target}</td>
      <td style="font-family:monospace; opacity:0.85;" title="${inputTokens} prompt tokens">${inputTokens}</td>
      <td style="font-family:monospace; opacity:0.85;" title="${outputTokens} completion tokens">${outputTokens}</td>
      <td style="color:#7ee787; font-family:monospace;">${cost}</td>
    `;
    auditTableBody.appendChild(tr);
  });
}

filterProject.addEventListener('change', filterAndRenderTable);
filterModel.addEventListener('change', filterAndRenderTable);

exportCsvBtn.addEventListener('click', () => {
  const selectedProj = filterProject.value;
  const selectedMod = filterModel.value;
  const filtered = cachedUsageRecords.filter((r) => {
    const matchProj = selectedProj === 'all' || r.project === selectedProj;
    const matchMod = selectedMod === 'all' || r.model === selectedMod;
    return matchProj && matchMod;
  });

  vscode.postMessage({
    type: 'EXPORT_USAGE_CSV',
    records: filtered,
  });
});

function formatCurrency(val: number): string {
  if (!val || val <= 0) return '$0.00';
  if (val < 0.01) return `$${val.toFixed(4)}`;
  return `$${val.toFixed(2)}`;
}

// Settings View Controller (Phase 5 - Matching User Mockup)
function openSettingsView() {
  viewChat.classList.add('hidden');
  viewUsage.classList.add('hidden');
  viewSettings.classList.remove('hidden');
  vscode.postMessage({ type: 'GET_SETTINGS' });
}

function closeSettingsView() {
  viewSettings.classList.add('hidden');
  viewChat.classList.remove('hidden');
}

if (settingsBtn) {
  settingsBtn.addEventListener('click', openSettingsView);
}

if (settingsBackBtn) {
  settingsBackBtn.addEventListener('click', closeSettingsView);
}

if (settingsViewUsageBtn) {
  settingsViewUsageBtn.addEventListener('click', () => {
    viewSettings.classList.add('hidden');
    viewChat.classList.add('hidden');
    viewUsage.classList.remove('hidden');
    vscode.postMessage({ type: 'GET_USAGE_REPORT' });
  });
}

if (settingsUpdateKeyBtn) {
  settingsUpdateKeyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'PROMPT_UPDATE_KEY' });
  });
}

if (settingsClearHistoryBtn) {
  settingsClearHistoryBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'TRIGGER_CLEAR_HISTORY' });
  });
}

function updatePositionGuide(pos: 'left' | 'right') {
  if (!guideTitleText || !guideBodyText) return;
  if (pos === 'right') {
    guideTitleText.textContent = '👉 How to move Chat to the Right:';
    guideBodyText.innerHTML = `
      <div>1. Right-click the <strong>OpenRouter (✨)</strong> icon or "Chat" header.</div>
      <div>2. Click <strong>"Move to Secondary Side Bar"</strong>.</div>
      <div style="margin-top: 4px; opacity: 0.8;">(Or simply drag &amp; drop the ✨ icon to the right side bar).</div>
    `;
  } else {
    guideTitleText.textContent = '👈 How to move Chat to the Left:';
    guideBodyText.innerHTML = `
      <div>1. Right-click the <strong>OpenRouter (✨)</strong> icon in the right side bar.</div>
      <div>2. Click <strong>"Reset Location"</strong>.</div>
      <div style="margin-top: 4px; opacity: 0.8;">(Or drag &amp; drop the ✨ icon back to the left Activity Bar).</div>
    `;
  }
  if (positionGuideBox) {
    positionGuideBox.classList.remove('hidden');
  }
}

if (guideCloseBtn && positionGuideBox) {
  guideCloseBtn.addEventListener('click', () => {
    positionGuideBox.classList.add('hidden');
  });
}

if (posLeftBtn && posRightBtn) {
  posLeftBtn.addEventListener('click', () => {
    updatePositionGuide('left');
    vscode.postMessage({ type: 'SET_PANEL_POSITION', position: 'left' });
  });
  posRightBtn.addEventListener('click', () => {
    updatePositionGuide('right');
    vscode.postMessage({ type: 'SET_PANEL_POSITION', position: 'right' });
  });
}

if (settingsDefaultModel) {
  settingsDefaultModel.addEventListener('change', () => {
    vscode.postMessage({ type: 'SET_DEFAULT_MODEL', modelId: settingsDefaultModel.value });
  });
}

if (resetPermissionsBtn) {
  resetPermissionsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'RESET_PERMISSIONS' });
  });
}

if (chkAutoSummarize) {
  chkAutoSummarize.addEventListener('change', () => {
    vscode.postMessage({
      type: 'SET_CONTEXT_SETTING',
      key: 'autoSummarize',
      value: chkAutoSummarize.checked,
    });
  });
}

if (chkFullHistory) {
  chkFullHistory.addEventListener('change', () => {
    vscode.postMessage({
      type: 'SET_CONTEXT_SETTING',
      key: 'fullHistoryResend',
      value: chkFullHistory.checked,
    });
  });
}

// Phase 7: Privacy settings listeners
if (chkStrictZdr) {
  chkStrictZdr.addEventListener('change', () => {
    const policy = chkStrictZdr.checked ? 'deny' : 'allow';
    isZdrOnlyPolicyActive = chkStrictZdr.checked;
    vscode.postMessage({
      type: 'SET_PRIVACY_SETTING',
      key: 'dataCollectionPolicy',
      value: policy,
    });
  });
}

if (chkWarnTraining) {
  chkWarnTraining.addEventListener('change', () => {
    isWarnOnDataTrainingActive = chkWarnTraining.checked;
    vscode.postMessage({
      type: 'SET_PRIVACY_SETTING',
      key: 'warnOnDataTraining',
      value: chkWarnTraining.checked,
    });
  });
}

if (settingsRedactionMode) {
  settingsRedactionMode.addEventListener('change', () => {
    vscode.postMessage({
      type: 'SET_PRIVACY_SETTING',
      key: 'redactionMode',
      value: settingsRedactionMode.value,
    });
  });
}

// Bind click events on permission rows to cycle permission states
document.querySelectorAll('.permission-row').forEach((row) => {
  const cat = row.getAttribute('data-cat');
  const btn = row.querySelector('.perm-pill') as HTMLButtonElement;
  if (btn && cat) {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'TOGGLE_PERMISSION', category: cat });
    });
  }
});

function renderSettings(data: any) {
  if (settingsMaskedKey) {
    settingsMaskedKey.textContent = data.apiKeyMasked || 'Not set';
  }

  // Panel position toggle
  if (posLeftBtn && posRightBtn) {
    const pos = data.panelPosition === 'right' ? 'right' : 'left';
    if (pos === 'right') {
      posRightBtn.classList.add('active');
      posLeftBtn.classList.remove('active');
    } else {
      posLeftBtn.classList.add('active');
      posRightBtn.classList.remove('active');
    }
    // Keep instructions box hidden by default on render; only show when user clicks a button
  }

  // Default model options
  if (settingsDefaultModel && data.models) {
    settingsDefaultModel.innerHTML = '';
    data.models.forEach((m: any) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      if (m.id === data.defaultModel) {
        opt.selected = true;
      }
      settingsDefaultModel.appendChild(opt);
    });
  }

  // Update permission pills
  if (data.permissions) {
    document.querySelectorAll('.permission-row').forEach((row) => {
      const cat = row.getAttribute('data-cat');
      const btn = row.querySelector('.perm-pill') as HTMLButtonElement;
      if (btn && cat && data.permissions[cat]) {
        const state = data.permissions[cat];
        btn.className = `perm-pill ${state}`;
        btn.textContent = state === 'allow' ? 'Allowed' : state === 'deny' ? 'Denied' : 'Ask each time';
      }
    });
  }

  // Checkboxes
  if (chkAutoSummarize) {
    chkAutoSummarize.checked = !!data.autoSummarize;
  }
  if (chkFullHistory) {
    chkFullHistory.checked = !!data.fullHistoryResend;
  }

  // Phase 7: Privacy checkboxes and selection
  if (chkStrictZdr) {
    chkStrictZdr.checked = data.dataCollectionPolicy !== 'allow';
    isZdrOnlyPolicyActive = chkStrictZdr.checked;
  }
  if (chkWarnTraining) {
    chkWarnTraining.checked = data.warnOnDataTraining !== false;
    isWarnOnDataTrainingActive = chkWarnTraining.checked;
  }
  if (settingsRedactionMode && data.redactionMode) {
    settingsRedactionMode.value = data.redactionMode;
  }
}

vscode.postMessage({ type: 'READY' });
