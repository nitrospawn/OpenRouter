import { OpenRouterModel } from './openrouterClient';

export interface ModelCapabilities {
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsTools: boolean;
  supportsReasoningEffort: boolean;
  supportedReasoningEfforts?: string[];
  inputModalities: string[];
  outputModalities: string[];
  isAgentic: boolean;
  agenticSource: 'override' | 'capabilities' | 'heuristic' | 'none';
}

/**
 * Minimum context length (tokens) for a model to be considered agentic.
 * Models below this threshold cannot reliably hold system prompt + file context + history.
 */
const AGENTIC_MIN_CONTEXT = 16_000;

/**
 * Well-known model ID prefixes that are reliably agentic, kept as a fallback only
 * for models whose API metadata is consistently missing context_length or supported_parameters.
 * Real capability signals always take priority over these names.
 */
const KNOWN_AGENTIC_PREFIXES: readonly string[] = [
  'anthropic/claude',
  'openai/gpt-4',
  'openai/o1',
  'openai/o3',
  'openai/o4',
  'google/gemini-2',
  'google/gemini-1.5-pro',
  'deepseek/',
  'mistralai/mistral-large',
  'mistralai/mistral-medium',
  'qwen/qwen2.5-72b',
  'qwen/qwen2.5-coder',
  'meta-llama/llama-3.3',
  'meta-llama/llama-3.1-70b',
  'meta-llama/llama-3.1-405b',
  'x-ai/grok',
];

/**
 * Detects model capabilities using a layered priority system for isAgentic:
 *
 * Priority 1 — User override (settings): always wins, per model ID.
 * Priority 2 — API capability signals: context_length + tools/reasoning.
 * Priority 3 — Known-prefix heuristic: for models with incomplete metadata.
 * Priority 4 — Default: not agentic.
 *
 * @param model         The model object from the OpenRouter API.
 * @param agenticOverrides  Map of modelId → boolean from user settings (optional).
 */
export function detectModelCapabilities(
  model?: OpenRouterModel,
  agenticOverrides?: Record<string, boolean>
): ModelCapabilities {
  const defaultResult: ModelCapabilities = {
    supportsVision: false,
    supportsAudio: false,
    supportsTools: false,
    supportsReasoningEffort: false,
    supportedReasoningEfforts: undefined,
    inputModalities: ['text'],
    outputModalities: ['text'],
    isAgentic: false,
    agenticSource: 'none',
  };

  if (!model) {
    return defaultResult;
  }

  const idLower = (model.id || '').toLowerCase();
  const nameLower = (model.name || '').toLowerCase();
  const descLower = (model.description || '').toLowerCase();
  const supportedParams = (model.supported_parameters || []).map((p) => p.toLowerCase());
  const inputModalities = (model.architecture?.input_modalities || []).map((m) => m.toLowerCase());
  const outputModalities = (model.architecture?.output_modalities || []).map((m) => m.toLowerCase());
  const modality = (model.architecture?.modality || '').toLowerCase();

  // ── Reasoning effort detection ──────────────────────────────────────────
  const hasReasoningParam =
    supportedParams.includes('reasoning_effort') ||
    supportedParams.includes('reasoning') ||
    supportedParams.includes('effort');

  const isReasoningModel =
    hasReasoningParam ||
    idLower.includes('/o1') ||
    idLower.includes('/o3') ||
    idLower.includes('/o4') ||
    idLower.includes('o1-') ||
    idLower.includes('o3-') ||
    idLower.includes('r1') ||
    idLower.includes('reason') ||
    idLower.includes('thinking') ||
    idLower.includes('qwq') ||
    idLower.includes('glm') ||
    nameLower.includes('r1') ||
    nameLower.includes('reason') ||
    nameLower.includes('thinking') ||
    descLower.includes('reasoning') ||
    descLower.includes('thinking') ||
    descLower.includes('reasoning effort') ||
    descLower.includes('reasoning token');

  const supportedReasoningEfforts = isReasoningModel ? ['low', 'medium', 'high'] : undefined;

  // ── Vision / audio / tools ───────────────────────────────────────────────
  const supportsVision =
    inputModalities.includes('image') ||
    inputModalities.includes('multimodal') ||
    modality.includes('image') ||
    modality.includes('multimodal') ||
    idLower.includes('vision');

  const supportsAudio =
    inputModalities.includes('audio') ||
    outputModalities.includes('audio') ||
    modality.includes('audio');

  const supportsTools =
    supportedParams.includes('tools') ||
    supportedParams.includes('tool_choice') ||
    supportedParams.includes('function_calling') ||
    supportedParams.includes('functions') ||
    (model.architecture?.instruct_type !== null &&
      !idLower.includes('instruct-free') &&
      (descLower.includes('tool') ||
        idLower.includes('gpt') ||
        idLower.includes('claude') ||
        idLower.includes('gemini')));

  // ── isAgentic: layered priority ──────────────────────────────────────────

  // Priority 1: User override from settings { "model-id": true/false }
  if (agenticOverrides && Object.prototype.hasOwnProperty.call(agenticOverrides, model.id)) {
    return {
      supportsVision,
      supportsAudio,
      supportsTools,
      supportsReasoningEffort: isReasoningModel,
      supportedReasoningEfforts,
      inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
      outputModalities: outputModalities.length > 0 ? outputModalities : ['text'],
      isAgentic: Boolean(agenticOverrides[model.id]),
      agenticSource: 'override',
    };
  }

  // Priority 2: Capability-based signals — reliable, model-name-agnostic.
  // A model is agentic if it has enough context AND meaningful instruction-following ability.
  const contextLength = model.context_length ?? model.top_provider?.context_length ?? 0;
  const hasLargeContext = contextLength >= AGENTIC_MIN_CONTEXT;
  const isAgenticByCapabilities = hasLargeContext && (supportsTools || isReasoningModel || contextLength >= 32_000);

  if (isAgenticByCapabilities) {
    return {
      supportsVision,
      supportsAudio,
      supportsTools,
      supportsReasoningEffort: isReasoningModel,
      supportedReasoningEfforts,
      inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
      outputModalities: outputModalities.length > 0 ? outputModalities : ['text'],
      isAgentic: true,
      agenticSource: 'capabilities',
    };
  }

  // Priority 3: Known-prefix heuristic for models with incomplete/missing API metadata
  const isKnownAgentic = KNOWN_AGENTIC_PREFIXES.some((prefix) => idLower.startsWith(prefix));

  return {
    supportsVision,
    supportsAudio,
    supportsTools,
    supportsReasoningEffort: isReasoningModel,
    supportedReasoningEfforts,
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
    outputModalities: outputModalities.length > 0 ? outputModalities : ['text'],
    isAgentic: isKnownAgentic,
    agenticSource: isKnownAgentic ? 'heuristic' : 'none',
  };
}

export function getDefaultReasoningEffort(supportedLevels?: string[]): string {
  if (!supportedLevels || supportedLevels.length === 0) {
    return 'low';
  }
  if (supportedLevels.includes('low')) {
    return 'low';
  }
  if (supportedLevels.includes('medium')) {
    return 'medium';
  }
  return supportedLevels[0];
}
