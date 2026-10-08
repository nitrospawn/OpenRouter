import { logger } from '../logger';

export interface OpenRouterAuthResponse {
  data?: {
    label?: string;
    usage?: number;
    limit?: number | null;
    is_free_tier?: boolean;
    rate_limit?: {
      requests?: number;
      interval?: string;
    };
  };
  error?: {
    code?: number;
    message?: string;
  };
}

export interface OpenRouterModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
}

export interface OpenRouterModelArchitecture {
  modality?: string;
  tokenizer?: string;
  instruct_type?: string | null;
  input_modalities?: string[];
  output_modalities?: string[];
}

export interface ProviderRoutingOptions {
  data_collection?: 'allow' | 'deny';
  zdr?: boolean;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  created?: number;
  description?: string;
  pricing?: OpenRouterModelPricing;
  context_length?: number;
  architecture?: OpenRouterModelArchitecture;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
    allow_data_collection?: boolean;
  };
  supported_parameters?: string[];
  supports_zdr?: boolean;
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContentPart[];
}

export interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role: string;
      content: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

export interface StreamChunkChoice {
  delta?: {
    role?: string;
    content?: string;
    reasoning?: string;
    thought?: string;
  };
  finish_reason?: string | null;
}

export interface StreamChunkResponse {
  id?: string;
  model?: string;
  choices?: StreamChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterClient {
  public static async validateApiKey(apiKey: string): Promise<{ isValid: boolean; label?: string; error?: string }> {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/auth/key`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
        },
      });

      if (!res.ok) {
        let errMessage = `HTTP error ${res.status}`;
        try {
          const errJson = (await res.json()) as OpenRouterAuthResponse;
          if (errJson?.error?.message) {
            errMessage = errJson.error.message;
          }
        } catch {
          // ignore
        }
        logger.warn('AUTH', `API key validation failed — HTTP ${res.status}: ${errMessage}`);
        return { isValid: false, error: errMessage };
      }

      const data = (await res.json()) as OpenRouterAuthResponse;
      logger.info('AUTH', `API key validated ✓ — label: ${data.data?.label || 'Active Key'}`);
      return { isValid: true, label: data.data?.label || 'Active Key' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network error';
      logger.error('AUTH', `API key validation error: ${msg}`);
      return { isValid: false, error: msg };
    }
  }

  public static async fetchModels(apiKey?: string): Promise<OpenRouterModel[]> {
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const maxRetries = 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        const res = await fetch(`${OPENROUTER_BASE_URL}/models`, {
          method: 'GET',
          headers,
        });

        if (!res.ok) {
          if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
            attempt++;
            await new Promise((r) => setTimeout(r, attempt * 800));
            continue;
          }
          throw new Error(`Failed to fetch models: HTTP ${res.status}`);
        }

        const json = (await res.json()) as OpenRouterModelsResponse;
        const models = json.data || [];
        logger.info('MODELS', `Fetched ${models.length} models from OpenRouter`);
        return models;
      } catch (err: unknown) {
        if (attempt < maxRetries) {
          attempt++;
          logger.warn('MODELS', `Model fetch failed (attempt ${attempt}/${maxRetries}) — retrying...`);
          await new Promise((r) => setTimeout(r, attempt * 800));
          continue;
        }
        const errMsg = err instanceof Error ? err.message : 'Failed to fetch models';
        logger.error('MODELS', `Model fetch failed: ${errMsg}`);
        throw err instanceof Error ? err : new Error('Failed to fetch models');
      }
    }

    return [];
  }

  public static async sendChatCompletion(
    apiKey: string,
    model: string,
    messages: ChatMessage[]
  ): Promise<ChatCompletionResponse> {
    const maxRetries = 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/openrouter',
          'X-Title': 'OpenRouter VSCode Extension',
        },
        body: JSON.stringify({
          model,
          messages,
        }),
      });

      if (!res.ok) {
        if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
          attempt++;
          logger.warn('API', `sendChatCompletion HTTP ${res.status} — retry ${attempt}/${maxRetries} in ${attempt * 800}ms`);
          await new Promise((r) => setTimeout(r, attempt * 800));
          continue;
        }
        let errMsg = `Request failed with HTTP ${res.status}`;
        try {
          const errJson = (await res.json()) as ChatCompletionResponse;
          if (errJson?.error?.message) { errMsg = errJson.error.message; }
        } catch { /* ignore */ }
        throw new Error(errMsg);
      }

      return (await res.json()) as ChatCompletionResponse;
    }

    throw new Error('sendChatCompletion: max retries exceeded');
  }

  /**
   * Server-Sent Events (SSE) streaming chat completion
   */
  public static async sendChatCompletionStream(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    onChunk: (content: string) => void,
    onDone: (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }, finishReason?: string) => void,
    onError: (err: Error) => void,
    providerOptions?: ProviderRoutingOptions,
    abortSignal?: AbortSignal,
    reasoningEffort?: string,
    onReasoningFallback?: () => void,
    onReasoningChunk?: (chunk: string) => void,
    onStatusUpdate?: (status: string) => void
  ): Promise<void> {
    const maxRetries = 2;
    let attempt = 0;
    let hasEmittedChunks = false;
    let currentReasoningEffort = reasoningEffort;
    let hasFallbackRetried = false;

    while (attempt <= maxRetries) {
      let latestUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      let latestFinishReason: string | undefined;
      const internalController = new AbortController();
      let timedOutReason: string | null = null;
      let timeoutTimer: any = null;

      const armTimeout = (ms: number, reason: string) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(() => {
          timedOutReason = reason;
          internalController.abort();
        }, ms);
      };

      const clearTimer = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
      };

      const forwardAbort = () => {
        clearTimer();
        internalController.abort();
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onDone(undefined);
          return;
        }
        abortSignal.addEventListener('abort', forwardAbort, { once: true });
      }

      try {
        const payload: Record<string, any> = {
          model,
          messages,
          stream: true,
        };

        if (currentReasoningEffort) {
          payload.reasoning_effort = currentReasoningEffort;
        }

        if (providerOptions && (providerOptions.data_collection || providerOptions.zdr !== undefined)) {
          payload.provider = {};
          if (providerOptions.data_collection) {
            payload.provider.data_collection = providerOptions.data_collection;
          }
          if (providerOptions.zdr !== undefined) {
            payload.provider.zdr = providerOptions.zdr;
          }
        }

        if (onStatusUpdate) {
          onStatusUpdate(`Connecting to ${model}...`);
        }
        logger.info('API', `Stream request → ${model} (attempt ${attempt + 1}/${maxRetries + 1})`);

        // Arm 75-second timeout for initial connection and response headers
        armTimeout(
          75000,
          `The request to ${model} timed out after 75 seconds. Upstream provider or model queue may be unresponsive.`
        );

        const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/openrouter',
            'X-Title': 'OpenRouter VSCode Extension',
          },
          body: JSON.stringify(payload),
          signal: internalController.signal,
        });

        if (!res.ok) {
          clearTimer();
          let errMessage = `HTTP error ${res.status}`;
          try {
            const errJson = (await res.json()) as ChatCompletionResponse;
            if (errJson?.error?.message) {
              errMessage = errJson.error.message;
            }
          } catch {
            // ignore
          }

          // Fallback check: If provider rejected because of reasoning_effort parameter (400 or parameter error)
          const errLower = errMessage.toLowerCase();
          const isReasoningRejection =
            res.status === 400 &&
            currentReasoningEffort &&
            (errLower.includes('reasoning') ||
              errLower.includes('effort') ||
              errLower.includes('parameter') ||
              errLower.includes('unsupported') ||
              errLower.includes('extra') ||
              errLower.includes('unexpected') ||
              errLower.includes('unknown') ||
              errLower.includes('not support'));

          if (isReasoningRejection && !hasFallbackRetried) {
            hasFallbackRetried = true;
            currentReasoningEffort = undefined;
            logger.warn('API', `Reasoning effort rejected by ${model} — retrying without reasoning_effort`);
            if (onReasoningFallback) {
              onReasoningFallback();
            }
            // Retry immediately without reasoning_effort
            continue;
          }

          // Retry on transient 5xx server errors or rate limit blips if attempts remain
          if ((res.status >= 500 || res.status === 429) && attempt < maxRetries && !abortSignal?.aborted) {
            attempt++;
            const backoffMs = attempt * 1000;
            logger.warn('API', `HTTP ${res.status} from ${model} — retry ${attempt}/${maxRetries} in ${backoffMs}ms`);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }

          logger.error('API', `Stream request failed — HTTP ${res.status}: ${errMessage}`);
          throw new Error(errMessage);
        }

        if (!res.body) {
          clearTimer();
          throw new Error('Response body is null');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) {
              continue;
            }

            const dataStr = trimmed.replace(/^data:\s*/, '');
            if (dataStr === '[DONE]') {
              clearTimer();
              if (abortSignal) abortSignal.removeEventListener('abort', forwardAbort);
              if (latestUsage) {
                logger.info('API', `Stream complete ✓ — INPUT  tokens: ${latestUsage.prompt_tokens ?? '?'}`);
                logger.info('API', `Stream complete ✓ — OUTPUT tokens: ${latestUsage.completion_tokens ?? '?'} (total: ${latestUsage.total_tokens ?? '?'})`);
              } else {
                logger.info('API', `Stream complete ✓ — no usage data returned by ${model} (common for free models)`);
              }
              // Log why the model stopped — critical for diagnosing mid-execution stops
              const fr = latestFinishReason || 'unknown';
              if (fr === 'stop') {
                logger.info('API', `Stop reason: "stop" — model finished normally ✓`);
              } else if (fr === 'length') {
                logger.warn('API', `Stop reason: "length" — model hit its max_tokens limit and was CUT OFF mid-response!`);
              } else if (fr === 'content_filter') {
                logger.warn('API', `Stop reason: "content_filter" — response was blocked by the provider content policy`);
              } else if (fr === 'tool_calls') {
                logger.info('API', `Stop reason: "tool_calls" — model requested tool/function calls`);
              } else if (fr === 'unknown') {
                logger.warn('API', `Stop reason: unknown — finish_reason was not included in stream (free model or provider limitation)`);
              } else {
                logger.warn('API', `Stop reason: "${fr}" — unexpected finish reason, may indicate provider-side issue`);
              }
              onDone(latestUsage, latestFinishReason);
              return;
            }

            try {
              const parsed = JSON.parse(dataStr) as StreamChunkResponse;
              if (parsed.usage) {
                latestUsage = parsed.usage;
              }
              // Capture finish_reason — tells us why the model stopped
              const fr = parsed.choices?.[0]?.finish_reason;
              if (fr) {
                latestFinishReason = fr;
              }

              const deltaReasoning = parsed.choices?.[0]?.delta?.reasoning || parsed.choices?.[0]?.delta?.thought;
              if (deltaReasoning) {
                hasEmittedChunks = true;
                armTimeout(45000, `Stream from ${model} stalled (no response data received for 45 seconds).`);
                if (onReasoningChunk) {
                  onReasoningChunk(deltaReasoning);
                }
              }

              const deltaContent = parsed.choices?.[0]?.delta?.content;
              if (deltaContent) {
                hasEmittedChunks = true;
                armTimeout(45000, `Stream from ${model} stalled (no response data received for 45 seconds).`);
                onChunk(deltaContent);
              }
            } catch {
              // ignore non-json ping/keepalive chunks
            }
          }
        }

        clearTimer();
        if (abortSignal) { abortSignal.removeEventListener('abort', forwardAbort); }
        if (latestUsage) {
          logger.info('API', `Stream complete — in:${latestUsage.prompt_tokens ?? '?'} out:${latestUsage.completion_tokens ?? '?'} total:${latestUsage.total_tokens ?? '?'} tokens`);
        } else {
          logger.info('API', 'Stream complete (no usage data)');
        }
        onDone(latestUsage);
        return;
      } catch (err: unknown) {
        clearTimer();
        if (abortSignal) abortSignal.removeEventListener('abort', forwardAbort);

        if (abortSignal?.aborted || (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted')) && !timedOutReason)) {
          // User voluntarily stopped generation; clean termination
          logger.info('API', `Stream stopped by user — model: ${model}`);
          onDone(latestUsage, 'user_cancelled');
          return;
        }

        if (timedOutReason) {
          logger.error('API', `Stream timed out — ${timedOutReason}`);
          onError(new Error(timedOutReason));
          return;
        }

        // If no chunks were emitted yet and attempts remain, auto-retry on network failure
        if (!hasEmittedChunks && attempt < maxRetries && !abortSignal?.aborted) {
          attempt++;
          const backoffMs = attempt * 800;
          logger.warn('API', `Network failure (no chunks received) — retry ${attempt}/${maxRetries} in ${backoffMs}ms`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        // All retries exhausted or failure occurred midway during stream
        const errMsg = err instanceof Error ? err.message : 'Stream failed';
        logger.error('API', `Stream failed: ${errMsg}`);
        onError(err instanceof Error ? err : new Error('Stream failed'));
        return;
      }
    }
  }
}
