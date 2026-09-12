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
        return { isValid: false, error: errMessage };
      }

      const data = (await res.json()) as OpenRouterAuthResponse;
      return { isValid: true, label: data.data?.label || 'Active Key' };
    } catch (err: unknown) {
      return { isValid: false, error: err instanceof Error ? err.message : 'Network error' };
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
        return json.data || [];
      } catch (err: unknown) {
        if (attempt < maxRetries) {
          attempt++;
          await new Promise((r) => setTimeout(r, attempt * 800));
          continue;
        }
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

    const json = (await res.json()) as ChatCompletionResponse;
    if (!res.ok) {
      throw new Error(json.error?.message || `Request failed with HTTP ${res.status}`);
    }

    return json;
  }

  /**
   * Server-Sent Events (SSE) streaming chat completion
   */
  public static async sendChatCompletionStream(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    onChunk: (content: string) => void,
    onDone: (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void,
    onError: (err: Error) => void,
    providerOptions?: ProviderRoutingOptions,
    abortSignal?: AbortSignal,
    reasoningEffort?: string,
    onReasoningFallback?: () => void
  ): Promise<void> {
    const maxRetries = 2;
    let attempt = 0;
    let hasEmittedChunks = false;
    let currentReasoningEffort = reasoningEffort;
    let hasFallbackRetried = false;

    while (attempt <= maxRetries) {
      let latestUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

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

        const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/openrouter',
            'X-Title': 'OpenRouter VSCode Extension',
          },
          body: JSON.stringify(payload),
          signal: abortSignal,
        });

        if (!res.ok) {
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
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }

          throw new Error(errMessage);
        }

        if (!res.body) {
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
              onDone(latestUsage);
              return;
            }

            try {
              const parsed = JSON.parse(dataStr) as StreamChunkResponse;
              if (parsed.usage) {
                latestUsage = parsed.usage;
              }
              const deltaContent = parsed.choices?.[0]?.delta?.content;
              if (deltaContent) {
                hasEmittedChunks = true;
                onChunk(deltaContent);
              }
            } catch {
              // ignore non-json ping/keepalive chunks
            }
          }
        }

        onDone(latestUsage);
        return;
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted') || abortSignal?.aborted)) {
          // User voluntarily stopped generation; clean termination
          onDone(latestUsage);
          return;
        }

        // If no chunks were emitted yet and attempts remain, auto-retry on network failure (fetch failed, ECONNRESET, etc.)
        if (!hasEmittedChunks && attempt < maxRetries && !abortSignal?.aborted) {
          attempt++;
          const backoffMs = attempt * 800;
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        // All retries exhausted or failure occurred midway during stream
        onError(err instanceof Error ? err : new Error('Stream failed'));
        return;
      }
    }
  }
}
