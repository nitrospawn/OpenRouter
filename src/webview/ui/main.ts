import { renderCodeBlock } from './codeBlockUI';
import { isLongUserMessage, getUserMessagePreviewText } from './codeBlockUtils';
import { getDefaultReasoningEffort } from '../../api/modelCapabilities';
// Declared VS Code Webview API
declare function acquireVsCodeApi(): {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

// Live permission tracking for active webview session
let currentPermissions: Record<string, string> = {
  readActiveContext: 'allow',
  applyEdit: 'ask',
  runTerminalCommand: 'ask',
  readWorkspaceFiles: 'allow',
};

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
const attachFileBtn = document.getElementById('attach-file-btn') as HTMLButtonElement;
const voiceInputBtn = document.getElementById('voice-input-btn') as HTMLButtonElement;
const imageFileInput = document.getElementById('image-file-input') as HTMLInputElement;
const docFileInput = document.getElementById('doc-file-input') as HTMLInputElement;
const attachmentPreviewBar = document.getElementById('attachment-preview-bar') as HTMLDivElement;
const inputBoxWrapper = document.getElementById('input-box-wrapper') as HTMLDivElement;

export interface ChatInputAttachment {
  id: string;
  name: string;
  data: string;
  isImage: boolean;
  isArtifact?: boolean;
  artifactType?: 'plan' | 'walkthrough';
  isQuote?: boolean;
  isReviewerFeedback?: boolean;
}

export interface ChatInputController {
  getAttachments(): ChatInputAttachment[];
  clearAttachments(): void;
  addAttachment(name: string, data: string, isImage: boolean, isArtifact?: boolean, artifactType?: 'plan' | 'walkthrough', isQuote?: boolean, isReviewerFeedback?: boolean): void;
  getValue(): string;
  setValue(val: string): void;
  focus(): void;
  resetHeight(): void;
  setEnabled(enabled: boolean): void;
}

export function createChatInputController(options: {
  textarea: HTMLTextAreaElement;
  inputBoxWrapper: HTMLElement;
  attachmentBar: HTMLElement;
  dropZone?: HTMLElement;
  fileInput?: HTMLInputElement;
  uploadBtn?: HTMLButtonElement;
  docFileInput?: HTMLInputElement;
  uploadDocBtn?: HTMLButtonElement;
  onSend: () => void;
}): ChatInputController {
  const { textarea, inputBoxWrapper, attachmentBar, dropZone, fileInput, uploadBtn, docFileInput, uploadDocBtn, onSend } = options;
  let attachmentsList: ChatInputAttachment[] = [];

  function render() {
    if (!attachmentBar) return;
    attachmentBar.innerHTML = '';
    if (attachmentsList.length === 0) {
      attachmentBar.classList.add('hidden');
      return;
    }
    attachmentBar.classList.remove('hidden');
    let quoteIndex = 0;
    attachmentsList.forEach((att) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      if (att.isImage) {
        const img = document.createElement('img');
        img.className = 'attachment-preview-img';
        img.src = att.data;
        img.alt = 'attachment';
        chip.appendChild(img);
      } else if (att.isQuote) {
        quoteIndex++;
        const iconSpan = document.createElement('span');
        iconSpan.className = 'attachment-quote-icon';
        iconSpan.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
        `;
        chip.appendChild(iconSpan);
      } else if (att.isReviewerFeedback) {
        chip.classList.add('reviewer-chip');
        const iconSpan = document.createElement('span');
        iconSpan.className = 'attachment-reviewer-icon';
        iconSpan.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10 9 9 9 8 9"></polyline>
          </svg>
        `;
        chip.appendChild(iconSpan);
        chip.title = att.data.length > 300 ? `${att.data.slice(0, 300)}...` : att.data;
      }
      const nameSpan = document.createElement('span');
      nameSpan.className = 'attachment-name';
      let displayName = att.name;
      if (att.isQuote) {
        displayName = att.name.replace(/^Quote(?:\s*\d+)?:/i, `Quote ${quoteIndex}:`);
      }
      nameSpan.textContent = displayName;
      chip.appendChild(nameSpan);

      const btn = document.createElement('button');
      btn.className = 'chip-remove-btn';
      btn.title = 'Remove attachment';
      btn.textContent = '✕';
      btn.addEventListener('click', () => {
        attachmentsList = attachmentsList.filter((a) => a.id !== att.id);
        render();
      });
      chip.appendChild(btn);
      attachmentBar.appendChild(chip);
    });
  }

  function isImageFile(file: any): boolean {
    if (!file) return false;
    if (file.type && typeof file.type === 'string' && file.type.startsWith('image/')) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(file.name || '');
  }

  function handleImageFile(file: File) {
    if (!file || !isImageFile(file)) return;
    if (typeof FileReader === 'undefined') {
      const id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
      attachmentsList.push({ id, name: file.name || 'Image attachment', data: (file as any).data || '', isImage: true });
      render();
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      if (result) {
        const id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
        attachmentsList.push({ id, name: file.name || 'Image attachment', data: result, isImage: true });
        render();
      }
    };
    reader.readAsDataURL(file);
  }

  function handleTextFile(file: File) {
    if (!file) return;
    if (typeof FileReader === 'undefined') {
      const id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
      attachmentsList.push({ id, name: file.name || 'Attached document', data: (file as any).data || '', isImage: false });
      render();
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      if (result) {
        const id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
        attachmentsList.push({ id, name: file.name || 'Attached document', data: result, isImage: false });
        render();
      }
    };
    reader.readAsText(file);
  }

  // Auto-grow height
  if (textarea) {
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });

    // Paste handling scoped to this textarea
    textarea.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            if (isImageFile(file)) {
              handleImageFile(file);
            } else {
              handleTextFile(file);
            }
          }
        }
      }
    });
  }

  // File input click (image)
  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        handleImageFile(file);
        fileInput.value = '';
      }
    });
  }

  // Document/file input click (general file attach)
  if (uploadDocBtn && docFileInput) {
    uploadDocBtn.addEventListener('click', (e) => {
      e.preventDefault();
      docFileInput.click();
    });

    docFileInput.addEventListener('change', () => {
      const files = docFileInput.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (isImageFile(file)) {
            handleImageFile(file);
          } else {
            handleTextFile(file);
          }
        }
        docFileInput.value = '';
      }
    });
  }

  // Drag and Drop: apply to inputBoxWrapper and optionally an expanded dropZone
  const dropTargets = [inputBoxWrapper];
  if (dropZone && dropZone !== inputBoxWrapper) {
    dropTargets.push(dropZone);
  }

  let dragCounter = 0;

  dropTargets.forEach((target) => {
    target.addEventListener('dragenter', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      dragCounter++;
      if (dragCounter === 1) {
        inputBoxWrapper.classList.add('drag-over');
      }
    });

    target.addEventListener('dragover', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    target.addEventListener('dragleave', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        inputBoxWrapper.classList.remove('drag-over');
      }
    });

    target.addEventListener('drop', (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      inputBoxWrapper.classList.remove('drag-over');

      const fileList: File[] = [];
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const file = e.dataTransfer.files[i];
          if (file) fileList.push(file);
        }
      } else if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
          const item = e.dataTransfer.items[i];
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) fileList.push(file);
          }
        }
      }

      fileList.forEach((file) => {
        if (isImageFile(file)) {
          handleImageFile(file);
        } else {
          handleTextFile(file);
        }
      });
    });
  });

  return {
    getAttachments: () => [...attachmentsList],
    clearAttachments: () => {
      attachmentsList = [];
      render();
      if (fileInput) fileInput.value = '';
      if (docFileInput) docFileInput.value = '';
    },
    addAttachment: (name: string, data: string, isImage: boolean, isArtifact?: boolean, artifactType?: 'plan' | 'walkthrough', isQuote?: boolean, isReviewerFeedback?: boolean) => {
      if (isQuote && attachmentsList.some((a) => a.isQuote && a.data === data)) {
        return;
      }
      if (isReviewerFeedback && attachmentsList.some((a) => a.isReviewerFeedback && a.data === data)) {
        return;
      }
      const id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
      attachmentsList.push({ id, name, data, isImage, isArtifact, artifactType, isQuote, isReviewerFeedback });
      render();
    },
    getValue: () => textarea?.value || '',
    setValue: (val: string) => {
      if (textarea) {
        textarea.value = val;
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
      }
    },
    focus: () => textarea?.focus(),
    resetHeight: () => {
      if (textarea) {
        textarea.style.height = 'auto';
      }
    },
    setEnabled: (enabled: boolean) => {
      if (textarea) textarea.disabled = !enabled;
      if (uploadBtn) uploadBtn.disabled = !enabled;
      if (uploadDocBtn) uploadDocBtn.disabled = !enabled;
    },
  };
}

// Controller instances
let mainChatInputController: ChatInputController;
let reviewerChatInputController: ChatInputController;

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
const spendTotalEl = document.getElementById('spend-total') as HTMLDivElement;

const filterProject = document.getElementById('filter-project') as HTMLSelectElement;
const filterModel = document.getElementById('filter-model') as HTMLSelectElement;
const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
const auditTableBody = document.getElementById('audit-table-body') as HTMLTableSectionElement;

// Settings DOM Elements (Matching Mockup)
const settingsBackBtn = document.getElementById('settings-back-btn') as HTMLButtonElement;
const settingsMaskedKey = document.getElementById('settings-masked-key') as HTMLSpanElement;
const settingsUpdateKeyBtn = document.getElementById('settings-update-key-btn') as HTMLButtonElement;
const resetPermissionsBtn = document.getElementById('reset-permissions-btn') as HTMLButtonElement;
const chkAutoSummarize = document.getElementById('chk-auto-summarize') as HTMLInputElement;
const chkFullHistory = document.getElementById('chk-full-history') as HTMLInputElement;
const settingsViewUsageBtn = document.getElementById('settings-view-usage-btn') as HTMLButtonElement;
const settingsClearHistoryBtn = document.getElementById('settings-clear-history-btn') as HTMLButtonElement;
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

// Reviewer Model Settings DOM References (PRD Phase 10 - Per-Workspace)
const chkReviewerEnabled = document.getElementById('chk-reviewer-enabled') as HTMLInputElement;
const reviewerConfigContainer = document.getElementById('reviewer-config-container') as HTMLDivElement;
const reviewerModelSearchInput = document.getElementById('reviewer-model-search-input') as HTMLInputElement;
const reviewerModelDropdown = document.getElementById('reviewer-model-dropdown') as HTMLDivElement;
const reviewerModelWarning = document.getElementById('reviewer-model-warning') as HTMLDivElement;
const reviewerReasoningContainer = document.getElementById('reviewer-reasoning-container') as HTMLDivElement;
const reviewerReasoningSelect = document.getElementById('reviewer-reasoning-select') as HTMLSelectElement;
const reviewerSystemPrompt = document.getElementById('reviewer-system-prompt') as HTMLTextAreaElement;
const resetReviewerPromptBtn = document.getElementById('reset-reviewer-prompt-btn') as HTMLButtonElement;

let currentReviewerModelId = '';
let currentReviewerReasoningEffort = 'medium';
let isReviewerEnabled = false;

// Direct Reviewer Toggle Button (Main Chat Header)
const reviewerToggleBtn = document.getElementById('reviewer-toggle-btn') as HTMLButtonElement;

function updateReviewerToggleBtnVisibility(enabled: boolean) {
  if (reviewerToggleBtn) {
    if (enabled) {
      if (reviewerToggleBtn.classList) {
        reviewerToggleBtn.classList.remove('hidden');
      } else {
        reviewerToggleBtn.className = (reviewerToggleBtn.className || '').replace(/\bhidden\b/g, '').trim();
      }
    } else {
      if (reviewerToggleBtn.classList) {
        reviewerToggleBtn.classList.add('hidden');
      } else if (!reviewerToggleBtn.className?.includes('hidden')) {
        reviewerToggleBtn.className = ((reviewerToggleBtn.className || '') + ' hidden').trim();
      }
    }
  }
}
updateReviewerToggleBtnVisibility(isReviewerEnabled);

// Dedicated Reviewer View DOM References (PRD Phase 11 Consolidation)
const viewReviewer = document.getElementById('view-reviewer') as HTMLDivElement;
const reviewerBackBtn = document.getElementById('reviewer-back-btn') as HTMLButtonElement;
const reviewerArtifactSection = document.getElementById('reviewer-artifact-section') as HTMLDivElement;
const reviewerArtifactLabel = document.getElementById('reviewer-artifact-label') as HTMLSpanElement;
const reviewerOpenTabBtn = document.getElementById('reviewer-open-tab-btn') as HTMLButtonElement;
const reviewerToggleArtifactBtn = document.getElementById('reviewer-toggle-artifact-btn') as HTMLButtonElement;
const reviewerArtifactPreviewBody = document.getElementById('reviewer-artifact-preview-body') as HTMLDivElement;
const reviewerMessages = document.getElementById('reviewer-messages') as HTMLDivElement;
const reviewerSelectionToolbar = document.getElementById('reviewer-selection-toolbar') as HTMLDivElement;
const reviewerSendSelectionBtn = document.getElementById('reviewer-send-selection-btn') as HTMLButtonElement;
const reviewerClarifySelectionBtn = document.getElementById('reviewer-clarify-selection-btn') as HTMLButtonElement;

// In-Panel Reviewer Model Selector & Reasoning DOM References
const reviewerPanelModelInput = document.getElementById('reviewer-panel-model-input') as HTMLInputElement;
const reviewerPanelModelDropdown = document.getElementById('reviewer-panel-model-dropdown') as HTMLDivElement;
const reviewerPanelReasoningContainer = document.getElementById('reviewer-panel-reasoning-container') as HTMLDivElement;
const reviewerPanelReasoningSelect = document.getElementById('reviewer-panel-reasoning-select') as HTMLSelectElement;
const reviewerCapabilityNoticeBanner = document.getElementById('reviewer-capability-notice-banner') as HTMLDivElement;
const reviewerCapabilityNoticeText = document.getElementById('reviewer-capability-notice-text') as HTMLSpanElement;
const reviewerCapabilityNoticeClose = document.getElementById('reviewer-capability-notice-close') as HTMLButtonElement;

// Reviewer Sessions DOM References
const reviewerNewChatBtn = document.getElementById('reviewer-new-chat-btn') as HTMLButtonElement;
const reviewerSessionDropdown = document.getElementById('reviewer-session-dropdown') as HTMLDivElement;
const reviewerSessionItemNew = document.getElementById('reviewer-session-item-new') as HTMLDivElement;
const reviewerSessionHistoryList = document.getElementById('reviewer-session-history-list') as HTMLDivElement;
const reviewerResetContextBtn = document.getElementById('reviewer-reset-context-btn') as HTMLButtonElement;

// Reviewer Shared Input Bar DOM References
const reviewerAttachmentPreviewBar = document.getElementById('reviewer-attachment-preview-bar') as HTMLDivElement;
const reviewerInputBoxWrapper = document.getElementById('reviewer-input-box-wrapper') as HTMLDivElement;
const reviewerPromptInput = document.getElementById('reviewer-prompt-input') as HTMLTextAreaElement;
const reviewerImageFileInput = document.getElementById('reviewer-image-file-input') as HTMLInputElement;
const reviewerDocFileInput = document.getElementById('reviewer-doc-file-input') as HTMLInputElement;
const reviewerUploadImgBtn = document.getElementById('reviewer-upload-img-btn') as HTMLButtonElement;
const reviewerAttachFileBtn = document.getElementById('reviewer-attach-file-btn') as HTMLButtonElement;
const reviewerSendBtn = document.getElementById('reviewer-send-btn') as HTMLButtonElement;
const reviewerStopBtn = document.getElementById('reviewer-stop-btn') as HTMLButtonElement;

// Reviewer Footer DOM References
const reviewerStatusText = document.getElementById('reviewer-status-text') as HTMLSpanElement;
const reviewerTokenMeter = document.getElementById('reviewer-token-meter') as HTMLSpanElement;

let currentReviewerArtifact: { type: 'plan' | 'walkthrough' | 'standalone'; content: string; uri?: string; messageId?: string } | null = null;
let activeReviewerAssistantEl: HTMLElement | null = null;
let activeReviewerAssistantContentEl: HTMLElement | null = null;
let currentSelectedReviewerText = '';
let activeReviewerSessionId = '';
let activeReviewerModelId = '';
let activeReviewerReasoningEffort = 'medium';

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
  supports_reasoning_effort?: boolean;
  supported_reasoning_efforts?: string[];
  supports_vision?: boolean;
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

// Reviewer Model Combobox Controller (PRD Phase 10)
function filterAndRenderReviewerModels(filter: string) {
  if (!reviewerModelDropdown) return;
  reviewerModelDropdown.innerHTML = '';
  const search = filter.toLowerCase().trim();

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
    reviewerModelDropdown.appendChild(emptyEl);
    return;
  }

  filtered.slice(0, 100).forEach((model) => {
    const item = document.createElement('div');
    item.className = 'combobox-item' + (model.id === currentReviewerModelId ? ' selected' : '');

    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'space-between';

    const title = document.createElement('div');
    title.className = 'combobox-item-title';
    title.textContent = model.name || model.id;

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
      selectReviewerModel(model.id, model.name);
      closeReviewerDropdown();
    });

    reviewerModelDropdown.appendChild(item);
  });
}

function selectReviewerModel(modelId: string, modelName?: string) {
  currentReviewerModelId = modelId;
  if (reviewerModelSearchInput) {
    reviewerModelSearchInput.value = modelName || modelId;
  }
  if (reviewerModelWarning) {
    if (modelId) {
      reviewerModelWarning.classList.add('hidden');
    } else {
      reviewerModelWarning.classList.remove('hidden');
    }
  }

  // Update Reviewer Reasoning Effort options if model supports it
  updateReviewerReasoningControl(modelId);

  vscode.postMessage({
    type: 'SET_REVIEWER_SETTING',
    key: 'model',
    value: modelId,
  });
}

function updateReviewerReasoningControl(modelId: string) {
  if (!reviewerReasoningContainer || !reviewerReasoningSelect) return;

  const model = loadedModels.find((m) => m.id === modelId);
  const idLower = (modelId || '').toLowerCase();
  const isReasoning =
    model?.supports_reasoning_effort === true ||
    idLower.includes('/o1') ||
    idLower.includes('/o3') ||
    idLower.includes('o1-') ||
    idLower.includes('o3-') ||
    idLower.includes('reasoning') ||
    idLower.includes('deepseek-r1');

  if (isReasoning) {
    reviewerReasoningContainer.classList.remove('hidden');
    const supportedLevels =
      model?.supported_reasoning_efforts && model.supported_reasoning_efforts.length > 0
        ? model.supported_reasoning_efforts
        : ['low', 'medium', 'high'];

    reviewerReasoningSelect.innerHTML = '';
    supportedLevels.forEach((level) => {
      const opt = document.createElement('option');
      opt.value = level.toLowerCase();
      opt.textContent = level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
      reviewerReasoningSelect.appendChild(opt);
    });

    const defaultChoice = supportedLevels.includes('medium')
      ? 'medium'
      : supportedLevels[Math.floor(supportedLevels.length / 2)] || supportedLevels[0];

    if (currentReviewerReasoningEffort && supportedLevels.includes(currentReviewerReasoningEffort)) {
      reviewerReasoningSelect.value = currentReviewerReasoningEffort;
    } else {
      reviewerReasoningSelect.value = defaultChoice;
      currentReviewerReasoningEffort = defaultChoice;
    }
  } else {
    reviewerReasoningContainer.classList.add('hidden');
  }
}

function openReviewerDropdown() {
  if (!reviewerModelDropdown) return;
  reviewerModelDropdown.classList.remove('hidden');
  filterAndRenderReviewerModels(reviewerModelSearchInput ? reviewerModelSearchInput.value : '');
}

function closeReviewerDropdown() {
  if (reviewerModelDropdown) {
    reviewerModelDropdown.classList.add('hidden');
  }
}

if (reviewerModelSearchInput) {
  reviewerModelSearchInput.addEventListener('focus', openReviewerDropdown);
  reviewerModelSearchInput.addEventListener('input', () => {
    openReviewerDropdown();
    filterAndRenderReviewerModels(reviewerModelSearchInput.value);
  });
}

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
  if (reviewerModelSearchInput && reviewerModelDropdown && !reviewerModelSearchInput.contains(e.target as Node) && !reviewerModelDropdown.contains(e.target as Node)) {
    closeReviewerDropdown();
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

        if (p.terminalOutputs) {
          detailsHtml += `
            <div class="context-detail-item">
              <span>Recent Terminal Outputs</span>
              <span>Captured</span>
            </div>
            <div class="context-detail-item context-detail-snippet">
              <span style="display:block;margin-bottom:2px;font-size:10px;opacity:0.75;">Output Preview:</span>
              <pre style="margin:0;padding:4px 6px;background:rgba(0,0,0,0.3);border-radius:4px;max-height:100px;overflow:auto;font-size:10px;font-family:monospace;white-space:pre-wrap;"><code>${escapeHtml(p.terminalOutputs)}</code></pre>
            </div>
          `;
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
      if (msg.messageId) {
        activeAssistantMessageEl.id = `msg-${msg.messageId}`;
      }

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
        const textToRender = msg.chatSummary || activeAssistantContentEl.textContent || '';
        activeAssistantContentEl.textContent = '';
        renderFormattedContent(textToRender, activeAssistantContentEl);
        if (activeAssistantMessageEl) {
          activeAssistantMessageEl.dataset.rawContent = textToRender;
          parseAndRenderActions(textToRender, activeAssistantMessageEl);
        }

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
              quoteAspectToInput(textToRender);
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
              navigator.clipboard.writeText(textToRender).then(() => {
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
      if (msg.success) {
        markEditResolved(msg.editId, 'applied', msg.checkpointId);
      }
      const card = document.getElementById(`edit-card-${msg.editId}`);
      if (card) {
        // Remove active action buttons (Preview, Apply, Reject) once a choice is made
        const actionsEl = card.querySelector('.diff-actions');
        if (actionsEl) {
          actionsEl.innerHTML = '';
        }

        let badge = document.getElementById(`edit-status-${msg.editId}`);
        if (!badge) {
          badge = document.createElement('div');
          badge.id = `edit-status-${msg.editId}`;
          badge.style.fontSize = '11px';
          badge.style.padding = '6px 10px';
          card.appendChild(badge);
        }
        badge.style.color = msg.success ? '#7ee787' : '#d73a49';
        badge.textContent = msg.success
          ? '✓ Applied'
          : (currentPermissions.applyEdit === 'deny'
              ? '✗ Edit blocked — Code edits permission is set to Denied'
              : '✗ Failed to apply');

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
      renderUsageReport(msg.summary, msg.records, msg.projects, msg.models, msg.currentProject);
      break;

    case 'REVIEWER_VIEW_DATA':
      openReviewerView(msg);
      break;

    case 'REVIEWER_ATTACH_ARTIFACT':
      handleReviewerAttachArtifact(msg);
      break;

    case 'REVIEWER_STREAM_START':
      handleReviewerStreamStart();
      break;

    case 'REVIEWER_STREAM_CHUNK':
      handleReviewerStreamChunk(msg.chunk);
      break;

    case 'REVIEWER_STREAM_DONE':
      handleReviewerStreamDone();
      break;

    case 'REVIEWER_STREAM_ERROR':
      handleReviewerStreamError(msg.message, msg.partial, msg.canRetry);
      break;

    case 'REVIEWER_SESSIONS_LOADED':
      renderReviewerSessionsList(msg.sessions || [], msg.activeSessionId || '');
      break;

    case 'SET_REVIEWER_BUSY':
      handleSetReviewerBusy(msg.busy);
      break;

    case 'SETTINGS_DATA':
      if (msg.permissions) {
        currentPermissions = { ...msg.permissions };
      }
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
  const editProposals: { filePath: string; newContent: string; editId: string }[] = [];
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
    editProposals.push({ filePath, newContent, editId });
  }

  if (editProposals.length > 0 && currentPermissions.applyEdit === 'deny') {
    const notice = document.createElement('div');
    notice.className = 'edit-denied-notice';
    notice.style.margin = '8px 0';
    notice.style.padding = '8px 12px';
    notice.style.background = 'rgba(215, 58, 73, 0.15)';
    notice.style.borderLeft = '3px solid #d73a49';
    notice.style.borderRadius = '4px';
    notice.style.fontSize = '12px';
    notice.style.color = '#f85149';
    notice.textContent = '⚠️ This edit was not applied — Code edits permission is currently set to Denied.';
    parentEl.appendChild(notice);
  }

  for (const item of editProposals) {
    renderEditProposal(
      item.editId,
      {
        filePath: item.filePath,
        newContent: item.newContent,
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

  if (currentPermissions.runTerminalCommand === 'allow') {
    const statusSpan = document.createElement('span');
    statusSpan.style.fontSize = '11px';
    statusSpan.style.color = '#7ee787';
    statusSpan.style.padding = '4px 8px';
    statusSpan.textContent = '▶ Executed automatically';
    actions.appendChild(statusSpan);
  } else if (currentPermissions.runTerminalCommand === 'deny') {
    const statusSpan = document.createElement('span');
    statusSpan.style.fontSize = '11px';
    statusSpan.style.color = '#d73a49';
    statusSpan.style.padding = '4px 8px';
    statusSpan.textContent = '✗ Execution disabled by permissions';
    actions.appendChild(statusSpan);
  } else {
    const runBtn = document.createElement('button');
    runBtn.className = 'btn';
    runBtn.textContent = '▶ Run in Terminal';
    runBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'RUN_TERMINAL', command });
    });
    actions.appendChild(runBtn);
  }

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
  } else if (currentPermissions.applyEdit === 'allow') {
    // Under Allow: Edit is auto-applied by host with zero manual interaction
    const badge = document.createElement('div');
    badge.id = `edit-status-${editId}`;
    badge.style.color = '#7ee787';
    badge.style.fontSize = '11px';
    badge.style.padding = '6px 10px';
    badge.textContent = '✓ Applied automatically';
    card.appendChild(badge);
  } else if (currentPermissions.applyEdit === 'deny') {
    // Under Deny: Edit is blocked by permission settings
    const badge = document.createElement('div');
    badge.id = `edit-status-${editId}`;
    badge.style.color = '#d73a49';
    badge.style.fontSize = '11px';
    badge.style.padding = '6px 10px';
    badge.textContent = '✗ Edit blocked — Code edits permission is set to Denied';
    card.appendChild(badge);
  } else {
    // Unresolved proposal (Ask mode): track in pending edits bar if active turn
    if (!isHistory) {
      pendingEditsMap.set(editId, {
        editId,
        filePath: edit.filePath,
        newContent: edit.newContent,
        cardEl: card,
      });
      updatePendingEditsBar();
    }
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

      // Default to low if supported, or medium, or first supported level
      const defaultChoice = getDefaultReasoningEffort(supportedLevels);

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
  const fenceRegex = /```([^\r\n]*)\r?\n([\s\S]*?)```/g;
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
    // Check if remaining ends with an in-progress / unterminated code fence: ```lang\n[code...]
    const openFenceMatch = remaining.match(/```([^\r\n]*)\r?\n([\s\S]*)$/);
    if (openFenceMatch && openFenceMatch.index !== undefined) {
      const preOpenFence = remaining.slice(0, openFenceMatch.index);
      if (preOpenFence) {
        renderMarkdownBlocks(preOpenFence, container);
      }
      const lang = (openFenceMatch[1] || 'text').trim();
      const code = openFenceMatch[2];
      renderCodeBlock(lang, code, container, document, { actionVerb });
    } else {
      renderMarkdownBlocks(remaining, container);
    }
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

    // Check for artifact notice line
    const planNoticeMatch = trimmed.match(/^📄\s*(?:Plan docs ready|Plan docs|Implementation plan ready|Plan ready)\s*(?:[—–-]\s*\[view\])?/i);
    const walkthroughNoticeMatch = trimmed.match(/^📄\s*(?:Results docs ready|Results docs|Walkthrough result|Walkthrough ready|Result walkthrough)\s*(?:[—–-]\s*\[view\])?/i);
    if (planNoticeMatch || walkthroughNoticeMatch) {
      flushParagraph();
      flushList();
      const isPlan = !!planNoticeMatch;
      const card = document.createElement('div');
      card.className = 'chat-artifact-card';

      const title = document.createElement('span');
      title.className = 'chat-artifact-title';
      title.innerHTML = `<span>📄</span><span>${isPlan ? 'Plan docs' : 'Results docs'}</span>`;

      const actionsWrapper = document.createElement('div');
      actionsWrapper.style.display = 'inline-flex';
      actionsWrapper.style.gap = '6px';
      actionsWrapper.style.alignItems = 'center';

      const viewBtn = document.createElement('button');
      viewBtn.className = 'chat-artifact-view-btn';
      viewBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
        <span>View</span>
      `;
      viewBtn.addEventListener('click', () => {
        const msgParent = container.closest('.message') as HTMLElement | null;
        const msgId = msgParent && msgParent.id ? msgParent.id.replace('msg-', '') : undefined;
        vscode.postMessage({
          type: 'VIEW_ARTIFACT',
          artifactType: isPlan ? 'plan' : 'walkthrough',
          messageId: msgId,
        });
      });
      actionsWrapper.appendChild(viewBtn);

      // On plans, include "Proceed" action
      if (isPlan) {
        const proceedBtn = document.createElement('button');
        proceedBtn.className = 'chat-artifact-proceed-btn';
        proceedBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Proceed</span>
        `;
        proceedBtn.addEventListener('click', () => {
          proceedBtn.disabled = true;
          if (promptInput) {
            promptInput.value = 'Proceed with the plan';
            sendMessage();
          }
        });
        actionsWrapper.appendChild(proceedBtn);
      }

      // If Reviewer Model is enabled for this workspace, add "Review" action
      if (isReviewerEnabled) {
        const reviewBtn = document.createElement('button');
        reviewBtn.className = 'chat-artifact-review-btn';
        reviewBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <span>Review</span>
        `;
        reviewBtn.addEventListener('click', () => {
          const msgParent = container.closest('.message') as HTMLElement | null;
          const msgId = msgParent && msgParent.id ? msgParent.id.replace('msg-', '') : undefined;
          vscode.postMessage({
            type: 'START_REVIEW',
            artifactType: isPlan ? 'plan' : 'walkthrough',
            messageId: msgId,
          });
        });
        actionsWrapper.appendChild(reviewBtn);
      }

      card.appendChild(title);
      card.appendChild(actionsWrapper);
      container.appendChild(card);
      continue;
    }

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

export function appendMessage(
  role: string,
  content: string,
  images?: Array<{ name: string; dataUrl: string }>,
  isHistory = false,
  messageId?: string,
  checkpointId?: string,
  affectedFiles?: string[]
) {
  let displayContent = content;
  if (role === 'user') {
    if (content.includes('<!-- reviewer-feedback:start -->')) {
      const stripped = content.replace(/<!-- reviewer-feedback:start -->[\s\S]*?<!-- reviewer-feedback:end -->\s*/g, '').trim();
      displayContent = stripped || 'Please address the attached reviewer feedback.';
    } else if (content.startsWith('[Reviewer Feedback]:')) {
      const parts = content.split('\n\n');
      displayContent = parts.slice(1).join('\n\n').trim() || 'Please address the attached reviewer feedback.';
    }
  }

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
    navigator.clipboard.writeText(displayContent).then(() => {
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

  if (role === 'user' && isLongUserMessage(displayContent)) {
    const lines = displayContent.split(/\r?\n/);
    const isReviewerFeedback = displayContent.toLowerCase().includes('reviewer');
    const label = isReviewerFeedback
      ? `Forwarded reviewer feedback — ${lines.length} lines`
      : `Long message — ${lines.length} lines pasted`;

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langSpan = document.createElement('span');
    langSpan.textContent = label;

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'code-block-actions';
    actionsContainer.style.display = 'flex';
    actionsContainer.style.gap = '8px';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'code-block-copy-btn';
    toggleBtn.textContent = 'Expand';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-block-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(displayContent).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 2000);
        });
      }
    });

    actionsContainer.appendChild(toggleBtn);
    actionsContainer.appendChild(copyBtn);

    header.appendChild(langSpan);
    header.appendChild(actionsContainer);
    wrapper.appendChild(header);

    const contentContainer = document.createElement('div');
    contentContainer.className = 'user-message-collapse-body';

    const previewText = getUserMessagePreviewText(displayContent);
    let isCollapsed = true;

    // Initially render collapsed preview
    renderFormattedContent(previewText, contentContainer, role);

    toggleBtn.addEventListener('click', () => {
      isCollapsed = !isCollapsed;
      contentContainer.innerHTML = '';
      if (isCollapsed) {
        toggleBtn.textContent = 'Expand';
        renderFormattedContent(previewText, contentContainer, role);
      } else {
        toggleBtn.textContent = 'Collapse';
        renderFormattedContent(displayContent, contentContainer, role);
      }
    });

    wrapper.appendChild(contentContainer);
    bodyEl.appendChild(wrapper);
  } else {
    renderFormattedContent(displayContent, bodyEl, role);
  }

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

mainChatInputController = createChatInputController({
  textarea: promptInput,
  inputBoxWrapper,
  attachmentBar: attachmentPreviewBar,
  dropZone: viewChat,
  fileInput: imageFileInput,
  uploadBtn: uploadImgBtn,
  docFileInput,
  uploadDocBtn: attachFileBtn,
  onSend: sendMessage,
});

function sendMessage() {
  const userTypedText = mainChatInputController.getValue().trim();
  let promptToSend = userTypedText;
  const currentImages: Array<{ name: string; dataUrl: string }> = [];
  const quoteAttachments: string[] = [];
  const reviewerAttachments: string[] = [];

  mainChatInputController.getAttachments().forEach((att) => {
    if (att.isImage) {
      currentImages.push({ name: att.name, dataUrl: att.data });
    } else if (att.isQuote) {
      quoteAttachments.push(att.data);
    } else if (att.isReviewerFeedback) {
      reviewerAttachments.push(att.data);
    } else {
      // Append text file content to message text
      const formatted = `\n\`\`\`${att.name}\n${att.data}\n\`\`\`\n`;
      promptToSend = promptToSend ? promptToSend.trimEnd() + formatted : formatted.trimStart();
    }
  });

  if (quoteAttachments.length > 0) {
    const quotedBlocks = quoteAttachments
      .map((quote) =>
        quote
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      )
      .join('\n\n');

    if (promptToSend) {
      promptToSend = `${quotedBlocks}\n\n${promptToSend}`;
    } else {
      const fallbackQuery =
        quoteAttachments.length > 1
          ? 'Can you clarify these points?'
          : 'Can you clarify this?';
      promptToSend = `${quotedBlocks}\n\n${fallbackQuery}`;
    }
  }

  if (reviewerAttachments.length > 0) {
    const feedbackBlock = reviewerAttachments
      .map((fb) => `<!-- reviewer-feedback:start -->\n[Reviewer Feedback]:\n${fb}\n<!-- reviewer-feedback:end -->`)
      .join('\n\n');

    if (promptToSend) {
      promptToSend = `${feedbackBlock}\n\n${promptToSend}`;
    } else {
      promptToSend = `${feedbackBlock}\n\nPlease address the attached reviewer feedback.`;
    }
  }

  if ((!promptToSend && currentImages.length === 0) || sendBtn.disabled) return;

  // Generate a client-side message ID that the host will reuse when storing the message,
  // so the undo button ID written here matches the ID the host will use to tagTurnCheckpoint.
  const userMessageId = `${Date.now()}-user`;

  // Read latest selected reasoning effort directly from select element if visible
  const effortToSend =
    reasoningEffortContainer && !reasoningEffortContainer.classList.contains('hidden') && reasoningEffortSelect
      ? reasoningEffortSelect.value
      : undefined;

  lastSentMessage = {
    content: promptToSend,
    modelId: currentModelId,
    images: currentImages.length > 0 ? [...currentImages] : undefined,
    reasoningEffort: effortToSend,
  };

  // The reviewer attachment is NOT rendered in the chat message bubble
  const displayContent = userTypedText || (reviewerAttachments.length > 0 ? 'Please address the attached reviewer feedback.' : promptToSend);

  appendMessage('user', displayContent, currentImages, false, userMessageId);
  mainChatInputController.clearAttachments();
  mainChatInputController.setValue('');
  mainChatInputController.resetHeight();
  vscode.postMessage({
    type: 'SEND_MESSAGE',
    messageId: userMessageId,
    content: promptToSend,
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

  const quoteCount = mainChatInputController.getAttachments().filter((a) => a.isQuote).length;
  const singleLine = trimmed.replace(/\s+/g, ' ');
  const snippet = singleLine.length > 25 ? `${singleLine.slice(0, 25)}...` : singleLine;
  const displayName = `Quote ${quoteCount + 1}: "${snippet}"`;

  mainChatInputController.addAttachment(
    displayName,
    trimmed,
    false,
    false,
    undefined,
    true
  );

  promptInput.focus();
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
  if (viewReviewer && !viewReviewer.classList.contains('hidden')) {
    hideFloatingQuoteBtn();
    return;
  }

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

  // Ensure the selection originated inside an assistant message in main messages container
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorEl = (anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement);
  const focusEl = (focusNode instanceof HTMLElement ? focusNode : focusNode?.parentElement);

  const assistantMsg = anchorEl?.closest('.message.assistant') || focusEl?.closest('.message.assistant');
  if (!assistantMsg || !messagesContainer || !messagesContainer.contains(assistantMsg)) {
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
    const settingsBody = document.getElementById('settings-scroll-body');
    if (settingsBody) settingsBody.scrollTop = 0;
  });
}

let cachedUsageRecords: any[] = [];
let visibleTableLimit = 100;

function renderUsageReport(
  summary: { today: number; thisWeek: number; thisMonth: number; total: number },
  records: any[],
  projects: string[],
  models: string[],
  currentProject?: string
) {
  cachedUsageRecords = records || [];
  visibleTableLimit = 100;

  // 1. Populate filter dropdowns
  const previousSelectedProject = filterProject.value;
  filterProject.innerHTML = '<option value="all">All Projects</option>';

  let targetProjectToSelect = previousSelectedProject;
  if (!targetProjectToSelect || targetProjectToSelect === '' || targetProjectToSelect === 'all') {
    if (currentProject && projects.includes(currentProject)) {
      targetProjectToSelect = currentProject;
    } else {
      targetProjectToSelect = 'all';
    }
  }

  projects.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === targetProjectToSelect) opt.selected = true;
    filterProject.appendChild(opt);
  });

  if (targetProjectToSelect === 'all') {
    filterProject.value = 'all';
  } else if (projects.includes(targetProjectToSelect)) {
    filterProject.value = targetProjectToSelect;
  }

  // 2. Populate model filter dropdown based on selected project
  updateModelFilterOptions(filterProject.value);

  filterAndRenderTable();
}

function updateModelFilterOptions(selectedProject: string) {
  const currentSelectedModel = filterModel.value;

  // Filter records by selected project to discover which models were used
  const relevantRecords = selectedProject === 'all'
    ? cachedUsageRecords
    : cachedUsageRecords.filter((r) => r.project === selectedProject);

  const modelSet = new Set<string>();
  for (const r of relevantRecords) {
    if (r.model) {
      modelSet.add(r.model);
    }
  }
  const distinctModels = Array.from(modelSet).sort();

  filterModel.innerHTML = '<option value="all">All Models</option>';
  distinctModels.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    filterModel.appendChild(opt);
  });

  // Preserve previous selection if it is available for this project, otherwise reset to 'all'
  if (currentSelectedModel && currentSelectedModel !== 'all' && distinctModels.includes(currentSelectedModel)) {
    filterModel.value = currentSelectedModel;
  } else {
    filterModel.value = 'all';
  }
}

function filterAndRenderTable() {
  const selectedProj = filterProject.value;
  const selectedMod = filterModel.value;

  const filtered = cachedUsageRecords.filter((r) => {
    const matchProj = selectedProj === 'all' || r.project === selectedProj;
    const matchMod = selectedMod === 'all' || r.model === selectedMod;
    return matchProj && matchMod;
  });

  // Dynamically calculate spend totals for the filtered selection
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = now.getDay();
  const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), diffToMonday).getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let todayCost = 0;
  let weekCost = 0;
  let monthCost = 0;
  let totalCost = 0;

  for (const r of filtered) {
    const cost = r.cost || 0;
    totalCost += cost;
    if (r.timestamp >= startOfToday) {
      todayCost += cost;
    }
    if (r.timestamp >= startOfWeek) {
      weekCost += cost;
    }
    if (r.timestamp >= startOfMonth) {
      monthCost += cost;
    }
  }

  if (spendTodayEl) spendTodayEl.textContent = formatCurrency(todayCost);
  if (spendWeekEl) spendWeekEl.textContent = formatCurrency(weekCost);
  if (spendMonthEl) spendMonthEl.textContent = formatCurrency(monthCost);
  if (spendTotalEl) spendTotalEl.textContent = formatCurrency(totalCost);

  auditTableBody.innerHTML = '';

  if (filtered.length === 0) {
    auditTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; opacity:0.6; padding:16px;">No records match filters</td></tr>`;
    exportCsvBtn.textContent = '📥 Export CSV (0)';
    exportCsvBtn.disabled = true;
    return;
  }

  exportCsvBtn.textContent = `📥 Export CSV (${filtered.length})`;
  exportCsvBtn.disabled = false;

  const recordsToRender = filtered.slice(0, visibleTableLimit);

  recordsToRender.forEach((r) => {
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
      inputTokens = '0';
      outputTokens = '0';
      cost = '$0.00';
    } else if (r.type === 'reviewer') {
      typePill = '<span class="type-pill reviewer">🔍 Reviewer</span>';
      target = escapeHtml(r.model || 'unknown');
      inputTokens = `${(r.promptTokens || 0).toLocaleString()}`;
      outputTokens = `${(r.completionTokens || 0).toLocaleString()}`;
      cost = formatCurrency(r.cost || 0);
    } else if (r.type === 'summarization') {
      typePill = '<span class="type-pill chat">📝 Summary</span>';
      target = escapeHtml(r.model || 'unknown');
      inputTokens = `${(r.promptTokens || 0).toLocaleString()}`;
      outputTokens = `${(r.completionTokens || 0).toLocaleString()}`;
      cost = formatCurrency(r.cost || 0);
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

  if (filtered.length > visibleTableLimit) {
    const moreTr = document.createElement('tr');
    const remaining = filtered.length - visibleTableLimit;
    moreTr.innerHTML = `
      <td colspan="6" style="text-align:center; padding:10px;">
        <button id="load-more-records-btn" class="btn secondary" style="font-size:11px; padding:3px 10px;">
          Show more (${remaining} remaining)
        </button>
      </td>
    `;
    auditTableBody.appendChild(moreTr);

    const loadMoreBtn = document.getElementById('load-more-records-btn');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        visibleTableLimit += 100;
        filterAndRenderTable();
      });
    }
  }
}

filterProject.addEventListener('change', () => {
  visibleTableLimit = 100;
  updateModelFilterOptions(filterProject.value);
  filterAndRenderTable();
});

filterModel.addEventListener('change', () => {
  visibleTableLimit = 100;
  filterAndRenderTable();
});

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
  const settingsBody = document.getElementById('settings-scroll-body');
  if (settingsBody) settingsBody.scrollTop = 0;
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
    const usageBody = document.getElementById('usage-scroll-body');
    if (usageBody) usageBody.scrollTop = 0;
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

  // Phase 10: Reviewer Model Settings (Per-Workspace)
  isReviewerEnabled = !!data.reviewerEnabled;
  updateReviewerToggleBtnVisibility(isReviewerEnabled);
  if (chkReviewerEnabled) {
    chkReviewerEnabled.checked = isReviewerEnabled;
  }

  if (reviewerConfigContainer) {
    if (data.reviewerEnabled) {
      reviewerConfigContainer.classList.remove('hidden');
    } else {
      reviewerConfigContainer.classList.add('hidden');
    }
  }

  currentReviewerModelId = data.reviewerModel || '';
  if (reviewerModelSearchInput) {
    const foundModel = loadedModels.find((m) => m.id === currentReviewerModelId);
    reviewerModelSearchInput.value = foundModel ? (foundModel.name || foundModel.id) : currentReviewerModelId;
  }

  if (reviewerModelWarning) {
    if (data.reviewerEnabled && !currentReviewerModelId) {
      reviewerModelWarning.classList.remove('hidden');
    } else {
      reviewerModelWarning.classList.add('hidden');
    }
  }

  currentReviewerReasoningEffort = data.reviewerReasoningEffort || 'medium';
  updateReviewerReasoningControl(currentReviewerModelId);

  if (reviewerSystemPrompt) {
    reviewerSystemPrompt.value = data.reviewerSystemPrompt || '';
  }
}

// Phase 10: Reviewer Settings Event Listeners
if (chkReviewerEnabled) {
  chkReviewerEnabled.addEventListener('change', () => {
    const enabled = chkReviewerEnabled.checked;
    isReviewerEnabled = enabled;
    updateReviewerToggleBtnVisibility(enabled);
    if (reviewerConfigContainer) {
      if (enabled) {
        reviewerConfigContainer.classList.remove('hidden');
      } else {
        reviewerConfigContainer.classList.add('hidden');
      }
    }
    if (enabled && !currentReviewerModelId && reviewerModelWarning) {
      reviewerModelWarning.classList.remove('hidden');
    } else if (reviewerModelWarning) {
      reviewerModelWarning.classList.add('hidden');
    }

    vscode.postMessage({
      type: 'SET_REVIEWER_SETTING',
      key: 'enabled',
      value: enabled,
    });
  });
}

if (reviewerReasoningSelect) {
  reviewerReasoningSelect.addEventListener('change', () => {
    currentReviewerReasoningEffort = reviewerReasoningSelect.value;
    vscode.postMessage({
      type: 'SET_REVIEWER_SETTING',
      key: 'reasoningEffort',
      value: reviewerReasoningSelect.value,
    });
  });
}

if (reviewerSystemPrompt) {
  reviewerSystemPrompt.addEventListener('input', () => {
    vscode.postMessage({
      type: 'SET_REVIEWER_SETTING',
      key: 'systemPrompt',
      value: reviewerSystemPrompt.value,
    });
  });
}

if (resetReviewerPromptBtn) {
  resetReviewerPromptBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'RESET_REVIEWER_PROMPT' });
  });
}

// Dedicated Reviewer View Logic (PRD Phase 11)
function openReviewerView(data: {
  artifactType: 'plan' | 'walkthrough' | 'standalone';
  artifactContent: string;
  artifactUri?: string;
  messageId?: string;
  reviewerModel: string;
  reviewerReasoningEffort: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  activeSessionId?: string;
}) {
  currentReviewerArtifact = {
    type: data.artifactType,
    content: data.artifactContent,
    uri: data.artifactUri,
    messageId: data.messageId,
  };

  // View navigation: switch to dedicated reviewer view
  viewChat.classList.add('hidden');
  viewSettings.classList.add('hidden');
  viewUsage.classList.add('hidden');
  viewReviewer.classList.remove('hidden');

  activeReviewerSessionId = data.activeSessionId || '';
  activeReviewerModelId = data.reviewerModel || currentReviewerModelId || '';
  activeReviewerReasoningEffort = data.reviewerReasoningEffort || currentReviewerReasoningEffort || 'medium';

  // In-panel model combobox display
  if (reviewerPanelModelInput) {
    const foundModel = loadedModels.find((m) => m.id === activeReviewerModelId);
    reviewerPanelModelInput.value = foundModel ? (foundModel.name || foundModel.id) : activeReviewerModelId;
  }
  updateReviewerPanelReasoningControl(activeReviewerModelId);

  // Setup Artifact preview or hide if standalone
  if (data.artifactType === 'standalone' || !data.artifactContent) {
    if (reviewerArtifactSection) reviewerArtifactSection.classList.add('hidden');
  } else {
    if (reviewerArtifactSection) reviewerArtifactSection.classList.remove('hidden');
    const isPlan = data.artifactType === 'plan';
    if (reviewerArtifactLabel) {
      reviewerArtifactLabel.textContent = isPlan ? 'Plan docs' : 'Results docs';
    }
    if (reviewerArtifactPreviewBody) {
      reviewerArtifactPreviewBody.textContent = data.artifactContent;
    }
  }

  // Render messages
  reviewerMessages.innerHTML = '';
  reviewerChatInputController.clearAttachments();
  reviewerChatInputController.setValue('');
  data.history.forEach((m) => {
    appendReviewerMessage(m.role as 'user' | 'assistant', m.content);
  });

  updateReviewerTokenMeter();
}

function handleReviewerAttachArtifact(data: {
  artifactType: 'plan' | 'walkthrough';
  artifactContent: string;
  artifactName?: string;
  artifactUri?: string;
  messageId?: string;
}) {
  // Ensure reviewer view is open
  viewChat.classList.add('hidden');
  viewSettings.classList.add('hidden');
  viewUsage.classList.add('hidden');
  viewReviewer.classList.remove('hidden');

  currentReviewerArtifact = {
    type: data.artifactType,
    content: data.artifactContent,
    uri: data.artifactUri,
    messageId: data.messageId,
  };

  if (reviewerArtifactSection) reviewerArtifactSection.classList.remove('hidden');
  const isPlan = data.artifactType === 'plan';
  if (reviewerArtifactLabel) {
    reviewerArtifactLabel.textContent = isPlan ? 'Plan docs' : 'Results docs';
  }
  if (reviewerArtifactPreviewBody) {
    reviewerArtifactPreviewBody.textContent = data.artifactContent;
  }

  const chipName = data.artifactName || (isPlan ? 'Plan docs' : 'Results docs');
  if (reviewerChatInputController) {
    // If an artifact attachment is already present, clear previous artifact chip to prevent duplicate artifact context
    const currentAtts = reviewerChatInputController.getAttachments();
    if (currentAtts.some((a) => a.isArtifact)) {
      reviewerChatInputController.clearAttachments();
      currentAtts.filter((a) => !a.isArtifact).forEach((a) => {
        reviewerChatInputController.addAttachment(a.name, a.data, a.isImage);
      });
    }
    reviewerChatInputController.addAttachment(chipName, data.artifactContent, false, true, data.artifactType);
  }

  if (reviewerPromptInput) {
    reviewerPromptInput.focus();
  }
}

function updateReviewerTokenMeter() {
  if (!reviewerTokenMeter) return;
  const currentModel = loadedModels.find((m) => m.id === activeReviewerModelId);
  const maxContext = currentModel?.context_length;

  const totalChars = (reviewerMessages.textContent || '').length;
  const tokens = Math.round(totalChars / 4);

  if (maxContext && maxContext > 0) {
    const pct = ((tokens / maxContext) * 100).toFixed(1);
    const maxFormatted =
      maxContext >= 1_000_000
        ? `${(maxContext / 1_000_000).toFixed(1)}M`
        : maxContext >= 1_000
        ? `${Math.round(maxContext / 1_000)}k`
        : `${maxContext}`;

    reviewerTokenMeter.textContent = `${tokens.toLocaleString()} / ${maxFormatted} (${pct}%)`;
    const ratio = tokens / maxContext;
    if (ratio > 0.9) {
      reviewerTokenMeter.style.color = '#f85149';
      reviewerTokenMeter.title = 'Reviewer context limit almost reached (>90%)';
    } else if (ratio > 0.75) {
      reviewerTokenMeter.style.color = '#d29922';
      reviewerTokenMeter.title = 'Approaching reviewer context limit (>75%)';
    } else {
      reviewerTokenMeter.style.color = '';
      reviewerTokenMeter.title = 'Reviewer conversation tokens / model max context';
    }
  } else {
    reviewerTokenMeter.textContent = `${tokens.toLocaleString()} tokens`;
    reviewerTokenMeter.style.color = '';
  }
}

let reviewerRenderRafId: number | null = null;
let reviewerRenderTimeoutId: any = null;
let reviewerLastRenderTime = 0;
const REVIEWER_RENDER_THROTTLE_MS = 60;

function flushReviewerStreamRender() {
  if (reviewerRenderRafId !== null) {
    cancelAnimationFrame(reviewerRenderRafId);
    reviewerRenderRafId = null;
  }
  if (reviewerRenderTimeoutId !== null) {
    clearTimeout(reviewerRenderTimeoutId);
    reviewerRenderTimeoutId = null;
  }
  if (activeReviewerAssistantContentEl) {
    activeReviewerAssistantContentEl.innerHTML = '';
    renderFormattedContent(accumulatedReviewerStream, activeReviewerAssistantContentEl, 'assistant');
    reviewerMessages.scrollTop = reviewerMessages.scrollHeight;
    reviewerLastRenderTime = Date.now();
  }
}

function scheduleReviewerStreamRender() {
  const now = Date.now();
  const elapsed = now - reviewerLastRenderTime;

  if (elapsed >= REVIEWER_RENDER_THROTTLE_MS) {
    if (reviewerRenderRafId !== null) {
      cancelAnimationFrame(reviewerRenderRafId);
    }
    reviewerRenderRafId = requestAnimationFrame(() => {
      reviewerRenderRafId = null;
      if (activeReviewerAssistantContentEl) {
        activeReviewerAssistantContentEl.innerHTML = '';
        renderFormattedContent(accumulatedReviewerStream, activeReviewerAssistantContentEl, 'assistant');
        reviewerMessages.scrollTop = reviewerMessages.scrollHeight;
        reviewerLastRenderTime = Date.now();
      }
    });
  } else {
    if (reviewerRenderTimeoutId === null) {
      reviewerRenderTimeoutId = setTimeout(() => {
        reviewerRenderTimeoutId = null;
        scheduleReviewerStreamRender();
      }, REVIEWER_RENDER_THROTTLE_MS - elapsed);
    }
  }
}

function quoteAspectToReviewerInput(aspectText: string) {
  const trimmed = aspectText.trim();
  if (!trimmed) return;

  const quoteCount = reviewerChatInputController.getAttachments().filter((a) => a.isQuote).length;
  const singleLine = trimmed.replace(/\s+/g, ' ');
  const snippet = singleLine.length > 25 ? `${singleLine.slice(0, 25)}...` : singleLine;
  const displayName = `Quote ${quoteCount + 1}: "${snippet}"`;

  reviewerChatInputController.addAttachment(
    displayName,
    trimmed,
    false,
    false,
    undefined,
    true
  );

  reviewerPromptInput.focus();
}

function appendReviewerMessage(role: 'user' | 'assistant', content: string, isIncomplete = false): HTMLElement {
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;
  msgEl.dataset.rawContent = content;

  const headerEl = document.createElement('div');
  headerEl.className = 'message-header';

  const roleTag = document.createElement('div');
  roleTag.className = 'role-tag';
  roleTag.textContent = role === 'user' ? 'You' : 'Reviewer';
  headerEl.appendChild(roleTag);

  const headerActions = document.createElement('div');
  headerActions.className = 'message-header-actions';

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
      const parentMsg = quoteBtn.closest('.message') as HTMLElement | null;
      const textToQuote = parentMsg?.dataset.rawContent ?? content;
      quoteAspectToReviewerInput(textToQuote);
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
    const parentMsg = copyBtn.closest('.message') as HTMLElement | null;
    const textToCopy = parentMsg?.dataset.rawContent ?? content;
    navigator.clipboard.writeText(textToCopy).then(() => {
      const span = copyBtn.querySelector('span');
      if (span) span.textContent = 'Copied!';
      setTimeout(() => {
        if (span) span.textContent = 'Copy';
      }, 1800);
    });
  });
  headerActions.appendChild(copyBtn);
  headerEl.appendChild(headerActions);
  msgEl.appendChild(headerEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'message-body';
  renderFormattedContent(content, bodyEl, role);
  msgEl.appendChild(bodyEl);

  // If assistant message, provide message-level "Send to Main Model" action
  if (role === 'assistant') {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'reviewer-msg-actions';

    const sendToMainBtn = document.createElement('button');
    sendToMainBtn.className = 'btn-send-to-main';
    sendToMainBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 10 4 15 9 20"></polyline>
        <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
      </svg>
      <span>Send to Main Model</span>
    `;

    if (isIncomplete) {
      sendToMainBtn.title = 'Send partial response to main chat (will flag that response was interrupted)';
      sendToMainBtn.addEventListener('click', () => {
        sendFeedbackToMainChat(`[Note: Reviewer response was interrupted/incomplete]\n\n${content}`);
      });
    } else {
      sendToMainBtn.title = 'Send this entire reviewer message to the main chat input';
      sendToMainBtn.addEventListener('click', () => {
        sendFeedbackToMainChat(content);
      });
    }

    actionsRow.appendChild(sendToMainBtn);
    msgEl.appendChild(actionsRow);
  }

  reviewerMessages.appendChild(msgEl);
  reviewerMessages.scrollTop = reviewerMessages.scrollHeight;
  updateReviewerTokenMeter();
  return msgEl;
}

function handleReviewerStreamStart() {
  accumulatedReviewerStream = '';
  // Defer creating activeReviewerAssistantEl until first chunk arrives (to avoid blank shell on immediate failure)
  activeReviewerAssistantEl = null;
  activeReviewerAssistantContentEl = null;
  if (reviewerStatusText) reviewerStatusText.textContent = 'Reviewer thinking...';
}

let accumulatedReviewerStream = '';
function handleReviewerStreamChunk(chunk: string) {
  if (!activeReviewerAssistantEl) {
    // First chunk arrived: create the assistant bubble
    activeReviewerAssistantEl = document.createElement('div');
    activeReviewerAssistantEl.className = 'message assistant';
    activeReviewerAssistantEl.dataset.rawContent = accumulatedReviewerStream;

    const headerEl = document.createElement('div');
    headerEl.className = 'message-header';

    const roleTag = document.createElement('div');
    roleTag.className = 'role-tag';
    roleTag.textContent = 'Reviewer';
    headerEl.appendChild(roleTag);

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
      const parentMsg = quoteBtn.closest('.message') as HTMLElement | null;
      const textToQuote = parentMsg?.dataset.rawContent ?? accumulatedReviewerStream;
      quoteAspectToReviewerInput(textToQuote);
    });
    headerActions.appendChild(quoteBtn);

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
      const parentMsg = copyBtn.closest('.message') as HTMLElement | null;
      const textToCopy = parentMsg?.dataset.rawContent ?? accumulatedReviewerStream;
      navigator.clipboard.writeText(textToCopy).then(() => {
        const span = copyBtn.querySelector('span');
        if (span) span.textContent = 'Copied!';
        setTimeout(() => {
          if (span) span.textContent = 'Copy';
        }, 1800);
      });
    });
    headerActions.appendChild(copyBtn);
    headerEl.appendChild(headerActions);
    activeReviewerAssistantEl.appendChild(headerEl);

    activeReviewerAssistantContentEl = document.createElement('div');
    activeReviewerAssistantContentEl.className = 'message-body';
    activeReviewerAssistantEl.appendChild(activeReviewerAssistantContentEl);

    reviewerMessages.appendChild(activeReviewerAssistantEl);
  }

  accumulatedReviewerStream += chunk;
  if (activeReviewerAssistantEl) {
    activeReviewerAssistantEl.dataset.rawContent = accumulatedReviewerStream;
  }
  scheduleReviewerStreamRender();
  updateReviewerTokenMeter();
}

// Case 2: Full Stream Completed Successfully
function handleReviewerStreamDone() {
  flushReviewerStreamRender();

  const finalContent = accumulatedReviewerStream;
  if (activeReviewerAssistantEl) {
    activeReviewerAssistantEl.dataset.rawContent = finalContent;
  }

  if (activeReviewerAssistantEl && finalContent.trim().length > 0) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'reviewer-msg-actions';

    const sendToMainBtn = document.createElement('button');
    sendToMainBtn.className = 'btn-send-to-main';
    sendToMainBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 10 4 15 9 20"></polyline>
        <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
      </svg>
      <span>Send to Main Model</span>
    `;
    sendToMainBtn.addEventListener('click', () => {
      sendFeedbackToMainChat(finalContent);
    });

    actionsRow.appendChild(sendToMainBtn);
    activeReviewerAssistantEl.appendChild(actionsRow);
  }

  accumulatedReviewerStream = '';
  activeReviewerAssistantEl = null;
  activeReviewerAssistantContentEl = null;
  if (reviewerStatusText) reviewerStatusText.textContent = 'Ready';
  updateReviewerTokenMeter();
}

// Case 1 & Case 3: Reviewer Stream Error Handling
function handleReviewerStreamError(errMsg: string, isPartial: boolean, canRetry = true) {
  if (reviewerStatusText) reviewerStatusText.textContent = `Reviewer Error: ${errMsg}`;

  if (isPartial && activeReviewerAssistantEl) {
    // Case 3: Partial stream received, then interrupted
    flushReviewerStreamRender();
    const partialAssistantEl = activeReviewerAssistantEl;
    const partialText = accumulatedReviewerStream;
    partialAssistantEl.dataset.rawContent = partialText;

    const interruptedBadge = document.createElement('div');
    interruptedBadge.className = 'stream-error-card';
    interruptedBadge.style.marginTop = '8px';
    interruptedBadge.innerHTML = `
      <div class="stream-error-header" style="color:#e3b341;">
        <span>⚠️</span>
        <span>Response interrupted — incomplete</span>
      </div>
      <div class="stream-error-msg">${escapeHtml(errMsg)}</div>
    `;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'stream-error-actions';
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '8px';
    actionsDiv.style.marginTop = '6px';

    if (canRetry) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-retry';
      retryBtn.textContent = '↻ Retry';
      retryBtn.addEventListener('click', () => {
        // Cleanly replace partial message on retry
        if (partialAssistantEl.parentNode) {
          partialAssistantEl.remove();
        }
        vscode.postMessage({ type: 'RETRY_REVIEWER_MESSAGE' });
      });
      actionsDiv.appendChild(retryBtn);
    }

    const sendPartialBtn = document.createElement('button');
    sendPartialBtn.className = 'btn-send-to-main';
    sendPartialBtn.textContent = 'Send Partial to Main Model';
    sendPartialBtn.addEventListener('click', () => {
      sendFeedbackToMainChat(`[Note: Reviewer response was interrupted/incomplete]\n\n${partialAssistantEl.dataset.rawContent || partialText}`);
    });
    actionsDiv.appendChild(sendPartialBtn);

    interruptedBadge.appendChild(actionsDiv);
    partialAssistantEl.appendChild(interruptedBadge);
  } else {
    // Case 1: Zero chunks received, clean error card with retry
    if (activeReviewerAssistantEl?.parentNode) {
      activeReviewerAssistantEl.remove();
    }
    activeReviewerAssistantEl = null;

    const errorCard = document.createElement('div');
    errorCard.className = 'stream-error-card';
    errorCard.innerHTML = `
      <div class="stream-error-header">
        <span>⚠️</span>
        <span>Reviewer Request Issue</span>
      </div>
      <div class="stream-error-msg">${escapeHtml(errMsg)}</div>
    `;

    if (canRetry) {
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'stream-error-actions';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-retry';
      retryBtn.textContent = '↻ Retry';
      retryBtn.addEventListener('click', () => {
        errorCard.remove();
        vscode.postMessage({ type: 'RETRY_REVIEWER_MESSAGE' });
      });
      actionsDiv.appendChild(retryBtn);
      errorCard.appendChild(actionsDiv);
    }

    reviewerMessages.appendChild(errorCard);
  }

  reviewerMessages.scrollTop = reviewerMessages.scrollHeight;
  accumulatedReviewerStream = '';
  activeReviewerAssistantEl = null;
  activeReviewerAssistantContentEl = null;
}

function handleSetReviewerBusy(busy: boolean) {
  if (busy) {
    reviewerSendBtn.classList.add('hidden');
    reviewerStopBtn.classList.remove('hidden');
    reviewerChatInputController.setEnabled(false);
  } else {
    reviewerStopBtn.classList.add('hidden');
    reviewerSendBtn.classList.remove('hidden');
    reviewerChatInputController.setEnabled(true);
  }
}

function sendFeedbackToMainChat(text: string) {
  // Return to main chat view
  viewReviewer.classList.add('hidden');
  viewChat.classList.remove('hidden');

  const cleanText = text.trim();
  if (!cleanText) return;

  // Check if this reviewer feedback is already attached to main chat input
  const currentAtts = mainChatInputController.getAttachments();
  const alreadyAttached = currentAtts.some((a) => a.isReviewerFeedback && a.data === cleanText);

  if (!alreadyAttached) {
    const singleLine = cleanText.replace(/\s+/g, ' ');
    const snippet = singleLine.length > 28 ? `${singleLine.slice(0, 28)}...` : singleLine;
    const chipName = `Reviewer Feedback: "${snippet}"`;

    mainChatInputController.addAttachment(
      chipName,
      cleanText,
      false, // isImage
      false, // isArtifact
      undefined, // artifactType
      false, // isQuote
      true // isReviewerFeedback
    );
  }

  // Focus prompt input for typing without overwriting the body
  if (promptInput) {
    mainChatInputController.focus();
  }
}

// Direct Reviewer Toggle Button
if (reviewerToggleBtn) {
  reviewerToggleBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'OPEN_DIRECT_REVIEWER' });
  });
}

// Back navigation from Reviewer View to Main Chat
if (reviewerBackBtn) {
  reviewerBackBtn.addEventListener('click', () => {
    viewReviewer.classList.add('hidden');
    viewChat.classList.remove('hidden');
  });
}

// Open artifact in VS Code editor tab for line-specific commenting (Native Comments API)
if (reviewerOpenTabBtn) {
  reviewerOpenTabBtn.addEventListener('click', () => {
    if (currentReviewerArtifact) {
      vscode.postMessage({
        type: 'VIEW_ARTIFACT',
        artifactType: currentReviewerArtifact.type,
        messageId: currentReviewerArtifact.messageId,
        content: currentReviewerArtifact.content,
      });
    }
  });
}

// Toggle collapse/expand on artifact preview body
if (reviewerToggleArtifactBtn) {
  reviewerToggleArtifactBtn.addEventListener('click', () => {
    if (reviewerArtifactPreviewBody.classList.contains('hidden')) {
      reviewerArtifactPreviewBody.classList.remove('hidden');
      reviewerToggleArtifactBtn.textContent = 'Collapse';
    } else {
      reviewerArtifactPreviewBody.classList.add('hidden');
      reviewerToggleArtifactBtn.textContent = 'Expand';
    }
  });
}

// Reviewer Input Controller Instance
reviewerChatInputController = createChatInputController({
  textarea: reviewerPromptInput,
  inputBoxWrapper: reviewerInputBoxWrapper,
  attachmentBar: reviewerAttachmentPreviewBar,
  dropZone: viewReviewer,
  fileInput: reviewerImageFileInput,
  uploadBtn: reviewerUploadImgBtn,
  docFileInput: reviewerDocFileInput,
  uploadDocBtn: reviewerAttachFileBtn,
  onSend: sendReviewerMessage,
});

// Send message to reviewer
function sendReviewerMessage() {
  let text = reviewerChatInputController.getValue().trim();
  const currentImages: Array<{ name: string; dataUrl: string }> = [];
  let attachedArtifact: { content: string; type: 'plan' | 'walkthrough' } | undefined;
  const quoteAttachments: string[] = [];

  reviewerChatInputController.getAttachments().forEach((att) => {
    if (att.isImage) {
      currentImages.push({ name: att.name, dataUrl: att.data });
    } else if (att.isArtifact) {
      attachedArtifact = { content: att.data, type: att.artifactType || 'plan' };
    } else if (att.isQuote) {
      quoteAttachments.push(att.data);
    } else {
      const formatted = `\n\`\`\`${att.name}\n${att.data}\n\`\`\`\n`;
      text = text ? text.trimEnd() + formatted : formatted.trimStart();
    }
  });

  if (quoteAttachments.length > 0) {
    const quotedBlocks = quoteAttachments
      .map((quote) =>
        quote
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
      )
      .join('\n\n');

    if (text) {
      text = `${quotedBlocks}\n\n${text}`;
    } else {
      const fallbackQuery =
        quoteAttachments.length > 1
          ? 'Can you clarify these points?'
          : 'Can you clarify this?';
      text = `${quotedBlocks}\n\n${fallbackQuery}`;
    }
  }

  if ((!text && currentImages.length === 0 && !attachedArtifact) || reviewerSendBtn.disabled) return;

  const defaultPrompt = attachedArtifact
    ? (attachedArtifact.type === 'walkthrough' ? 'Please review these Results docs.' : 'Please review these Plan docs.')
    : '';
  const userVisibleText = text || defaultPrompt || 'Please review';

  appendReviewerMessage('user', userVisibleText);
  reviewerChatInputController.clearAttachments();
  reviewerChatInputController.setValue('');
  reviewerChatInputController.resetHeight();

  const effortToSend =
    reviewerPanelReasoningContainer && !reviewerPanelReasoningContainer.classList.contains('hidden') && reviewerPanelReasoningSelect
      ? reviewerPanelReasoningSelect.value
      : undefined;

  vscode.postMessage({
    type: 'SEND_REVIEWER_MESSAGE',
    content: userVisibleText,
    modelId: activeReviewerModelId,
    reasoningEffort: effortToSend,
    artifactContent: attachedArtifact?.content,
    artifactType: attachedArtifact?.type,
  });
}

if (reviewerSendBtn) {
  reviewerSendBtn.addEventListener('click', sendReviewerMessage);
}

if (reviewerStopBtn) {
  reviewerStopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'STOP_REVIEWER_STREAM' });
  });
}

// In-Panel Reviewer Model Selector Dropdown logic
function updateReviewerPanelReasoningControl(modelId: string) {
  if (!reviewerPanelReasoningContainer || !reviewerPanelReasoningSelect) return;
  const model = loadedModels.find((m) => m.id === modelId);
  const idLower = (modelId || '').toLowerCase();
  const isReasoning =
    model?.supports_reasoning_effort === true ||
    idLower.includes('/o1') ||
    idLower.includes('/o3') ||
    idLower.includes('o1-') ||
    idLower.includes('o3-') ||
    idLower.includes('reasoning') ||
    idLower.includes('deepseek-r1');

  if (isReasoning) {
    reviewerPanelReasoningContainer.classList.remove('hidden');
    const supportedLevels =
      model?.supported_reasoning_efforts && model.supported_reasoning_efforts.length > 0
        ? model.supported_reasoning_efforts
        : ['low', 'medium', 'high'];

    reviewerPanelReasoningSelect.innerHTML = '';
    supportedLevels.forEach((level) => {
      const opt = document.createElement('option');
      opt.value = level.toLowerCase();
      opt.textContent = level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
      reviewerPanelReasoningSelect.appendChild(opt);
    });

    const defaultChoice = supportedLevels.includes('medium')
      ? 'medium'
      : supportedLevels[0];
    reviewerPanelReasoningSelect.value = activeReviewerReasoningEffort || defaultChoice;
  } else {
    reviewerPanelReasoningContainer.classList.add('hidden');
  }
}

function filterAndRenderReviewerPanelModels(query: string) {
  if (!reviewerPanelModelDropdown) return;
  reviewerPanelModelDropdown.innerHTML = '';

  const q = query.toLowerCase().trim();
  const filtered = loadedModels.filter((m) => {
    const matchName = m.name?.toLowerCase().includes(q);
    const matchId = m.id.toLowerCase().includes(q);
    return matchName || matchId;
  });

  if (filtered.length === 0) {
    const item = document.createElement('div');
    item.className = 'combobox-item';
    item.textContent = 'No models found';
    reviewerPanelModelDropdown.appendChild(item);
    return;
  }

  filtered.slice(0, 40).forEach((m) => {
    const item = document.createElement('div');
    item.className = `combobox-item ${m.id === activeReviewerModelId ? 'selected' : ''}`;
    item.textContent = m.name || m.id;
    item.addEventListener('click', () => {
      activeReviewerModelId = m.id;
      if (reviewerPanelModelInput) reviewerPanelModelInput.value = m.name || m.id;
      reviewerPanelModelDropdown.classList.add('hidden');
      updateReviewerPanelReasoningControl(m.id);
      updateReviewerTokenMeter();

      // Drop-with-notice for reviewer model switch
      if (reviewerCapabilityNoticeBanner && reviewerCapabilityNoticeText) {
        if (!m.supports_vision) {
          reviewerCapabilityNoticeText.textContent = `Note: Vision not supported by ${m.name || m.id}.`;
          reviewerCapabilityNoticeBanner.classList.remove('hidden');
        } else {
          reviewerCapabilityNoticeBanner.classList.add('hidden');
        }
      }
    });
    reviewerPanelModelDropdown.appendChild(item);
  });
}

if (reviewerPanelModelInput) {
  reviewerPanelModelInput.addEventListener('focus', () => {
    reviewerPanelModelDropdown.classList.remove('hidden');
    filterAndRenderReviewerPanelModels(reviewerPanelModelInput.value);
  });
  reviewerPanelModelInput.addEventListener('input', () => {
    reviewerPanelModelDropdown.classList.remove('hidden');
    filterAndRenderReviewerPanelModels(reviewerPanelModelInput.value);
  });
}

if (reviewerCapabilityNoticeClose && reviewerCapabilityNoticeBanner) {
  reviewerCapabilityNoticeClose.addEventListener('click', () => {
    reviewerCapabilityNoticeBanner.classList.add('hidden');
  });
}

// Reviewer Sessions Management UI
if (reviewerNewChatBtn && reviewerSessionDropdown) {
  reviewerNewChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    reviewerSessionDropdown.classList.toggle('hidden');
    if (!reviewerSessionDropdown.classList.contains('hidden')) {
      vscode.postMessage({ type: 'GET_REVIEWER_SESSIONS' });
    }
  });
}

if (reviewerSessionItemNew) {
  reviewerSessionItemNew.addEventListener('click', () => {
    reviewerSessionDropdown.classList.add('hidden');
    reviewerChatInputController.clearAttachments();
    reviewerChatInputController.setValue('');
    vscode.postMessage({ type: 'NEW_REVIEWER_SESSION' });
  });
}

if (reviewerResetContextBtn) {
  reviewerResetContextBtn.addEventListener('click', () => {
    reviewerChatInputController.clearAttachments();
    reviewerChatInputController.setValue('');
    vscode.postMessage({ type: 'RESET_REVIEWER_CONTEXT' });
  });
}

function renderReviewerSessionsList(
  sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messageCount: number }>,
  currentActiveId: string
) {
  if (!reviewerSessionHistoryList) return;
  reviewerSessionHistoryList.innerHTML = '';

  if (sessions.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'session-history-empty';
    emptyEl.textContent = 'No previous review sessions';
    reviewerSessionHistoryList.appendChild(emptyEl);
    return;
  }

  sessions.forEach((s) => {
    const item = document.createElement('div');
    item.className = `session-history-item ${s.id === currentActiveId ? 'active' : ''}`;

    const info = document.createElement('div');
    info.className = 'session-history-info';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'session-history-title-text';
    titleSpan.textContent = s.title;
    titleSpan.title = s.title;
    info.appendChild(titleSpan);

    item.addEventListener('click', () => {
      reviewerSessionDropdown.classList.add('hidden');
      if (s.id !== currentActiveId) {
        vscode.postMessage({ type: 'SWITCH_REVIEWER_SESSION', sessionId: s.id });
      }
    });

    const actions = document.createElement('div');
    actions.className = 'session-history-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'session-history-action-btn session-history-rename-btn';
    renameBtn.title = 'Rename review session';
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
          vscode.postMessage({ type: 'RENAME_REVIEWER_SESSION', sessionId: s.id, newTitle });
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
    delBtn.title = 'Delete review session';
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'DELETE_REVIEWER_SESSION', sessionId: s.id });
    });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    item.appendChild(info);
    item.appendChild(actions);
    reviewerSessionHistoryList.appendChild(item);
  });
}

// Text selection handling in reviewer conversation for selective feedback return or clarification
document.addEventListener('selectionchange', () => {
  if (viewReviewer.classList.contains('hidden')) {
    reviewerSelectionToolbar.classList.add('hidden');
    return;
  }

  const selection = window.getSelection();
  const selectedText = selection?.toString().trim();

  if (!selectedText || !selection?.anchorNode) {
    reviewerSelectionToolbar.classList.add('hidden');
    return;
  }

  // Ensure selection originated inside an assistant message in reviewerMessages
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorEl = (anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement);
  const focusEl = (focusNode instanceof HTMLElement ? focusNode : focusNode?.parentElement);

  const assistantMsg = anchorEl?.closest('.message.assistant') || focusEl?.closest('.message.assistant');

  if (assistantMsg && reviewerMessages.contains(assistantMsg)) {
    currentSelectedReviewerText = selectedText;
    reviewerSelectionToolbar.classList.remove('hidden');
  } else {
    reviewerSelectionToolbar.classList.add('hidden');
  }
});

if (reviewerClarifySelectionBtn) {
  reviewerClarifySelectionBtn.addEventListener('click', () => {
    if (currentSelectedReviewerText) {
      quoteAspectToReviewerInput(currentSelectedReviewerText);
      reviewerSelectionToolbar.classList.add('hidden');
      window.getSelection()?.removeAllRanges();
    }
  });
}

if (reviewerSendSelectionBtn) {
  reviewerSendSelectionBtn.addEventListener('click', () => {
    if (currentSelectedReviewerText) {
      sendFeedbackToMainChat(currentSelectedReviewerText);
      reviewerSelectionToolbar.classList.add('hidden');
      window.getSelection()?.removeAllRanges();
    }
  });
}

// Close comboboxes when clicking outside
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (reviewerPanelModelDropdown && !target.closest('.combobox-container')) {
    reviewerPanelModelDropdown.classList.add('hidden');
  }
  if (reviewerSessionDropdown && !target.closest('.session-dropdown-container')) {
    reviewerSessionDropdown.classList.add('hidden');
  }
});

// Prevent default dragover and drop at window level so Electron webview doesn't reject drops or navigate
if (typeof window !== 'undefined') {
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
  });
}

vscode.postMessage({ type: 'READY' });

