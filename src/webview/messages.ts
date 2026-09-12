import { ModelCapabilities } from '../api/modelCapabilities';

export interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: Array<{ name: string; dataUrl: string }>;
  timestamp: number;
  /** Shadow-git commit SHA created before this turn's AI actions (if any). */
  checkpointId?: string;
  /** Relative file paths touched by this turn's AI actions. */
  affectedFiles?: string[];
}

export interface ModelOptionItem {
  id: string;
  name: string;
  context_length?: number;
  provider?: string;
  supports_zdr?: boolean;
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
  | { type: 'HISTORY_LOADED'; messages: ChatMessageItem[]; activeSessionId?: string }
  | {
      type: 'SESSIONS_LOADED';
      sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messageCount: number }>;
      activeSessionId: string;
    }
  | { type: 'MESSAGE_STREAM_START'; messageId: string }
  | { type: 'MESSAGE_STREAM_CHUNK'; messageId: string; chunk: string }
  | { type: 'MESSAGE_STREAM_DONE'; messageId: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
  | { type: 'PROPOSE_EDIT'; editId: string; edit: ProposedFileEdit }
  | { type: 'EDIT_APPLIED'; editId: string; success: boolean; checkpointId?: string }
  | { type: 'UNDO_RESULT'; checkpointId: string; success: boolean; message?: string; messageId?: string; truncatedAfterId?: string }
  | {
      type: 'USAGE_REPORT_DATA';
      summary: { today: number; thisWeek: number; thisMonth: number; total: number };
      records: Array<{
        id: string;
        timestamp: number;
        type: string;
        project: string;
        model?: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        cost?: number;
        command?: string;
        cwd?: string;
      }>;
      projects: string[];
      models: string[];
    }
  | {
      type: 'SETTINGS_DATA';
      apiKeyMasked: string;
      panelPosition: 'left' | 'right';
      defaultModel: string;
      permissions: Record<string, string>;
      autoSummarize: boolean;
      fullHistoryResend: boolean;
      redactionMode: 'mask' | 'block_and_warn';
      dataCollectionPolicy: 'deny' | 'allow';
      warnOnDataTraining: boolean;
      models: ModelOptionItem[];
    }
  | { type: 'MESSAGE_RECEIVED'; message: ChatMessageItem }
  | { type: 'SET_BUSY'; busy: boolean }
  | { type: 'INSERT_INPUT_TEXT'; text: string; append?: boolean }
  | { type: 'ERROR'; message: string; canRetry?: boolean };

// Webview -> Host messages
export type WebviewToHostMessage =
  | { type: 'READY' }
  | { type: 'SUBMIT_API_KEY'; apiKey: string }
  | { type: 'SELECT_MODEL'; modelId: string }
  | { type: 'REFRESH_MODELS' }
  | { type: 'SEND_MESSAGE'; content: string; modelId: string; images?: Array<{ name: string; dataUrl: string }>; messageId?: string; reasoningEffort?: string }
  | { type: 'STOP_STREAM' }
  | { type: 'PREVIEW_DIFF'; filePath: string; newContent: string }
  | { type: 'ACCEPT_EDIT'; editId: string; filePath: string; newContent: string }
  | { type: 'ACCEPT_ALL_EDITS'; edits: Array<{ editId: string; filePath: string; newContent: string }> }
  | { type: 'REJECT_EDIT'; editId: string }
  | { type: 'UNDO_TURN'; messageId: string; checkpointId: string; affectedFiles: string[] }
  | { type: 'OPEN_FILE'; filePath: string }
  | { type: 'RUN_TERMINAL'; command: string }
  | { type: 'GET_USAGE_REPORT' }
  | { type: 'EXPORT_USAGE_CSV'; records: any[] }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_PANEL_POSITION'; position: 'left' | 'right' }
  | { type: 'SET_DEFAULT_MODEL'; modelId: string }
  | { type: 'TOGGLE_PERMISSION'; category: string }
  | { type: 'RESET_PERMISSIONS' }
  | { type: 'SET_CONTEXT_SETTING'; key: 'autoSummarize' | 'fullHistoryResend'; value: boolean }
  | { type: 'SET_PRIVACY_SETTING'; key: 'redactionMode' | 'dataCollectionPolicy' | 'warnOnDataTraining'; value: any }
  | { type: 'PROMPT_UPDATE_KEY' }
  | { type: 'TRIGGER_CLEAR_HISTORY' }
  | { type: 'OPEN_SETTINGS' }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'CLEAR_API_KEY' }
  | { type: 'GET_SESSIONS' }
  | { type: 'NEW_SESSION' }
  | { type: 'SWITCH_SESSION'; sessionId: string }
  | { type: 'RENAME_SESSION'; sessionId: string; newTitle: string }
  | { type: 'DELETE_SESSION'; sessionId: string };
