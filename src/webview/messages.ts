import { ModelCapabilities } from '../api/modelCapabilities';

export interface AttachedFileRef {
  name: string;
  uri?: string;
  filePath?: string;
  artifactType?: 'plan' | 'walkthrough';
  content?: string;
  isPinned?: boolean;
}

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: Array<{ name: string; dataUrl: string }>;
  timestamp: number;
  executionDurationMs?: number;
  /** Shadow-git commit SHA created before this turn's AI actions (if any). */
  checkpointId?: string;
  /** Relative file paths touched by this turn's AI actions. */
  affectedFiles?: string[];
  /** Detailed Markdown plan document. */
  planDocument?: string;
  /** Detailed Markdown walkthrough/result document. */
  walkthroughDocument?: string;
  attachedFile?: AttachedFileRef;
  /** Indicates an automated self-healing retry/diagnostic prompt rather than a human user message. */
  isAutoRetry?: boolean;
  isAutoFollowUp?: boolean;
  isIntermediateStep?: boolean;
  userTypedText?: string;
  attachments?: any[];
  totalTokens?: number;
}

export interface ModelOptionItem {
  id: string;
  name: string;
  context_length?: number;
  provider?: string;
  supports_zdr?: boolean;
  supports_reasoning_effort?: boolean;
  supported_reasoning_efforts?: string[];
  supports_vision?: boolean;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

export interface ProposedFileEdit {
  filePath: string;
  newContent: string;
  diffExplanation?: string;
}

export interface ContextPreviewData {
  activeFile?: string;
  lineRange?: string;
  contentSnippet?: string;
  referencedFile?: {
    path: string;
    contentSnippet?: string;
  };
  terminalOutputs?: string;
  imageCount: number;
  redactedCount: number;
  hasZdrOnly: boolean;
}

// Host -> Webview messages
export type HostToWebviewMessage =
  | { type: 'AUTH_STATE'; hasKey: boolean; keyLabel?: string }
  | { type: 'MODELS_LOADED'; models: ModelOptionItem[]; hiddenZdrCount?: number }
  | { type: 'SET_SELECTED_MODEL'; modelId: string; capabilities: ModelCapabilities; supportsZdr?: boolean }
  | { type: 'CONTEXT_PREVIEW_UPDATE'; preview: ContextPreviewData }
  | { type: 'HISTORY_LOADED'; messages: ChatMessageItem[]; activeSessionId?: string; lastTotalTokens?: number }
  | {
      type: 'SESSIONS_LOADED';
      sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messageCount: number }>;
      activeSessionId?: string;
    }
  | { type: 'MESSAGE_STREAM_START'; messageId: string; model?: string }
  | { type: 'MESSAGE_STREAM_CHUNK'; messageId: string; chunk: string }
  | { type: 'MESSAGE_STREAM_DISCARD'; messageId: string }
  | {
      type: 'MESSAGE_STREAM_DONE';
      messageId: string;
      model?: string;
      planDocument?: string;
      walkthroughDocument?: string;
      chatSummary?: string;
      executionDurationMs?: number;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      isIntermediateStep?: boolean;
    }
  | { type: 'PROPOSE_EDIT'; editId: string; edit: ProposedFileEdit }
  | { type: 'EDIT_APPLIED'; editId: string; success: boolean; checkpointId?: string; filePath?: string }
  | { type: 'EDIT_REVERTED'; editId: string; filePath?: string }
  | {
      type: 'UNDO_RESULT';
      success: boolean;
      messageId?: string;
      checkpointId?: string;
      truncatedAfterId?: string;
      remainingTokens?: number;
      message?: string;
      error?: string;
    }
  | {
      type: 'USAGE_REPORT_DATA';
      summary: { today: number; thisWeek: number; thisMonth: number; total: number };
      records: any[];
      projects: string[];
      models: string[];
      currentProject?: string;
    }
  | {
      type: 'SETTINGS_DATA';
      apiKeyMasked: string;
      panelPosition: 'left' | 'right';
      defaultModel: string;
      permissions: Record<string, string>;
      autoSummarize: boolean;
      fullHistoryResend: boolean;
      workspaceMemoryInContext?: boolean;
      redactionMode: string;
      dataCollectionPolicy: string;
      warnOnDataTraining: boolean;
      models: ModelOptionItem[];
      reviewerEnabled?: boolean;
      reviewerModel?: string;
      reviewerReasoningEffort?: string;
      reviewerSystemPrompt?: string;
      reviewerPinnedContextFile?: string;
      notificationSound?: boolean;
      notificationTone?: 'bell' | 'chime' | 'pop' | 'ding';
    }
  | {
      type: 'REVIEWER_VIEW_DATA';
      artifactType: 'plan' | 'walkthrough' | 'standalone';
      artifactContent: string;
      artifactUri?: string;
      messageId?: string;
      reviewerModel: string;
      reviewerReasoningEffort: string;
      reviewerPinnedContextFile?: string;
      history: Array<{ id?: string; role: 'user' | 'assistant'; content: string; attachedFile?: AttachedFileRef; executionDurationMs?: number }>;
      activeSessionId?: string;
    }
  | {
      type: 'REVIEWER_ATTACH_ARTIFACT';
      artifactType: 'plan' | 'walkthrough';
      artifactContent: string;
      artifactName?: string;
      artifactUri?: string;
      messageId?: string;
    }
  | { type: 'REVIEWER_STREAM_START' }
  | { type: 'REVIEWER_STREAM_CHUNK'; chunk: string }
  | {
      type: 'REVIEWER_STREAM_DONE';
      executionDurationMs?: number;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    }
  | {
      type: 'REVIEWER_STREAM_ERROR';
      message: string;
      errorTitle?: string;
      partial: boolean;
      canRetry?: boolean;
    }
  | {
      type: 'REVIEWER_SESSIONS_LOADED';
      sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messageCount: number }>;
      activeSessionId?: string;
    }
  | {
      type: 'REVIEWER_CONTEXT_POPULATED';
      attachment?: {
        filePath: string;
        fileName?: string;
        content: string;
        sizeBytes: number;
      };
      contentSnippet?: {
        text: string;
        sourceLabel?: string;
      };
      promptText: string;
    }
  | { type: 'SET_REVIEWER_BUSY'; busy: boolean; statusText?: string }
  | { type: 'MESSAGE_RECEIVED'; message: ChatMessageItem }
  | { type: 'SET_BUSY'; busy: boolean; statusText?: string }
  | {
      type: 'AGENT_PROGRESS';
      phase: 'loading' | 'reading' | 'connecting' | 'thinking' | 'writing' | 'verifying';
      label: string;
      detail?: string;
    }
  | { type: 'INSERT_INPUT_TEXT'; text: string; append?: boolean }
  | { type: 'ERROR'; message: string; errorTitle?: string; canRetry?: boolean; canResume?: boolean }
  | { type: 'TERMINAL_RUNNING'; command: string }
  | {
      type: 'TERMINAL_RESULT';
      command: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      executed: boolean;
      cancelled: boolean;
      timedOut?: boolean;
      error?: string;
    }
  | { type: 'PENDING_TERMINAL_COMMAND'; command: string }
  | { type: 'PLAY_NOTIFICATION_SOUND'; tone?: 'bell' | 'chime' | 'pop' | 'ding' }
  | { type: 'SET_MESSAGE_INTERMEDIATE'; messageId: string; isIntermediate: boolean };

// Webview -> Host messages
export type WebviewToHostMessage =
  | { type: 'READY' }
  | { type: 'SUBMIT_API_KEY'; apiKey: string }
  | { type: 'SELECT_MODEL'; modelId: string }
  | { type: 'REFRESH_MODELS' }
  | { type: 'SEND_MESSAGE'; content: string; modelId: string; images?: Array<{ name: string; dataUrl: string }>; messageId?: string; reasoningEffort?: string; isRetry?: boolean; isResume?: boolean; userTypedText?: string; attachments?: any[] }
  | { type: 'STOP_STREAM' }
  | { type: 'PREVIEW_DIFF'; filePath: string; newContent: string }
  | { type: 'ACCEPT_EDIT'; editId: string; filePath: string; newContent: string }
  | { type: 'ACCEPT_ALL_EDITS'; edits: Array<{ editId: string; filePath: string; newContent: string }> }
  | { type: 'REJECT_EDIT'; editId: string; filePath?: string }
  | { type: 'UNDO_TURN'; messageId: string; checkpointId: string; affectedFiles: string[] }
  | { type: 'OPEN_FILE'; filePath: string }
  | { type: 'RUN_TERMINAL'; command: string; interactive?: boolean }
  | { type: 'DENY_TERMINAL'; command: string }
  | { type: 'GET_USAGE_REPORT' }
  | { type: 'VIEW_LOGS' }
  | { type: 'EXPORT_USAGE_CSV'; records: any[] }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_PANEL_POSITION'; position: 'left' | 'right' }
  | { type: 'SET_DEFAULT_MODEL'; modelId: string }
  | { type: 'TOGGLE_PERMISSION'; category: string }
  | { type: 'RESET_PERMISSIONS' }
  | { type: 'SET_CONTEXT_SETTING'; key: 'autoSummarize' | 'fullHistoryResend' | 'workspaceMemoryInContext'; value: boolean }
  | { type: 'SET_PRIVACY_SETTING'; key: 'redactionMode' | 'dataCollectionPolicy' | 'warnOnDataTraining'; value: any }
  | { type: 'SET_REVIEWER_SETTING'; key: 'enabled' | 'model' | 'reasoningEffort' | 'systemPrompt' | 'pinnedContextFile'; value: any }
  | { type: 'SET_NOTIFICATION_SOUND'; enabled: boolean }
  | { type: 'SET_NOTIFICATION_TONE'; tone: 'bell' | 'chime' | 'pop' | 'ding' }
  | { type: 'BROWSE_PINNED_CONTEXT_FILE' }
  | { type: 'RESET_REVIEWER_PROMPT' }
  | { type: 'PROMPT_UPDATE_KEY' }
  | { type: 'TRIGGER_CLEAR_HISTORY' }
  | { type: 'OPEN_SETTINGS' }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'CLEAR_API_KEY' }
  | { type: 'GET_SESSIONS' }
  | { type: 'NEW_SESSION' }
  | { type: 'SWITCH_SESSION'; sessionId: string }
  | { type: 'RENAME_SESSION'; sessionId: string; newTitle: string }
  | { type: 'DELETE_SESSION'; sessionId: string }
  | { type: 'VIEW_ARTIFACT'; artifactType: 'plan' | 'walkthrough'; messageId?: string; content?: string }
  | { type: 'START_REVIEW'; artifactType: 'plan' | 'walkthrough'; messageId?: string; content?: string }
  | { type: 'OPEN_DIRECT_REVIEWER' }
  | {
      type: 'SEND_REVIEWER_MESSAGE';
      content: string;
      modelId?: string;
      reasoningEffort?: string;
      artifactContent?: string;
      artifactType?: 'plan' | 'walkthrough';
      attachedFile?: {
        name: string;
        content?: string;
        uri?: string;
        filePath?: string;
        artifactType?: 'plan' | 'walkthrough';
      };
    }
  | { type: 'RETRY_REVIEWER_MESSAGE'; messageId?: string }
  | { type: 'EDIT_REVIEWER_MESSAGE'; messageId: string; newContent: string }
  | { type: 'STOP_REVIEWER_STREAM' }
  | { type: 'GET_REVIEWER_SESSIONS' }
  | { type: 'NEW_REVIEWER_SESSION' }
  | { type: 'SWITCH_REVIEWER_SESSION'; sessionId: string }
  | { type: 'RENAME_REVIEWER_SESSION'; sessionId: string; newTitle: string }
  | { type: 'DELETE_REVIEWER_SESSION'; sessionId: string }
  | { type: 'RESET_REVIEWER_CONTEXT' }
  | {
      type: 'SEND_FILE_TO_REVIEWER';
      filePath: string;
      customPrompt?: string;
    }
  | {
      type: 'SEND_CONTENT_TO_REVIEWER';
      content: string;
      sourceLabel?: string;
    };
