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
}

export function detectModelCapabilities(model?: OpenRouterModel): ModelCapabilities {
  if (!model) {
    return {
      supportsVision: false,
      supportsAudio: false,
      supportsTools: false,
      supportsReasoningEffort: false,
      supportedReasoningEfforts: undefined,
      inputModalities: ['text'],
      outputModalities: ['text'],
      isAgentic: false,
    };
  }

  const supportedParams = (model.supported_parameters || []).map((p) => p.toLowerCase());
  const hasReasoningParam =
    supportedParams.includes('reasoning_effort') ||
    supportedParams.includes('reasoning') ||
    supportedParams.includes('effort');

  const idLower = (model.id || '').toLowerCase();
  const descLower = (model.description || '').toLowerCase();
  const nameLower = (model.name || '').toLowerCase();
  const isReasoningModel =
    hasReasoningParam ||
    idLower.includes('/o1') ||
    idLower.includes('/o3') ||
    idLower.includes('o1-') ||
    idLower.includes('o3-') ||
    idLower.includes('o1') ||
    idLower.includes('o3') ||
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

  // Infer supported levels if model supports reasoning effort
  let supportedReasoningEfforts: string[] | undefined = undefined;
  if (isReasoningModel) {
    // Standard default levels
    supportedReasoningEfforts = ['low', 'medium', 'high'];
  }

  if (!model.architecture) {
    const isAgentic =
      idLower.includes('opus') ||
      nameLower.includes('opus') ||
      idLower.includes('sonnet') ||
      nameLower.includes('sonnet') ||
      idLower.includes('claude-3') ||
      idLower.includes('claude-4') ||
      idLower.includes('claude-5') ||
      (idLower.includes('claude') && !idLower.includes('haiku')) ||
      (nameLower.includes('claude') && !nameLower.includes('haiku')) ||
      idLower.includes('gpt-4') ||
      idLower.includes('gpt-5') ||
      idLower.includes('o1') ||
      idLower.includes('o3') ||
      idLower.includes('deepseek') ||
      idLower.includes('gemini-2') ||
      idLower.includes('coder');

    return {
      supportsVision: false,
      supportsAudio: false,
      supportsTools: false,
      supportsReasoningEffort: isReasoningModel,
      supportedReasoningEfforts,
      inputModalities: ['text'],
      outputModalities: ['text'],
      isAgentic,
    };
  }

  const inputModalities = (model.architecture.input_modalities || []).map((m) => m.toLowerCase());
  const outputModalities = (model.architecture.output_modalities || []).map((m) => m.toLowerCase());
  const modality = (model.architecture.modality || '').toLowerCase();

  const supportsVision =
    inputModalities.includes('image') ||
    inputModalities.includes('multimodal') ||
    modality.includes('image') ||
    modality.includes('multimodal') ||
    model.id.includes('vision');

  const supportsAudio =
    inputModalities.includes('audio') ||
    outputModalities.includes('audio') ||
    modality.includes('audio');

  const supportsTools =
    supportedParams.includes('tools') ||
    supportedParams.includes('tool_choice') ||
    supportedParams.includes('function_calling') ||
    supportedParams.includes('functions') ||
    (model.architecture.instruct_type !== null &&
      !model.id.includes('instruct-free') &&
      (model.description?.toLowerCase().includes('tool') ||
        idLower.includes('gpt') ||
        idLower.includes('claude') ||
        nameLower.includes('claude') ||
        idLower.includes('gemini') ||
        nameLower.includes('gemini')));

  const isAgentic =
    idLower.includes('opus') ||
    nameLower.includes('opus') ||
    idLower.includes('sonnet') ||
    nameLower.includes('sonnet') ||
    idLower.includes('claude-3') ||
    idLower.includes('claude-4') ||
    idLower.includes('claude-5') ||
    (idLower.includes('claude') && !idLower.includes('haiku')) ||
    (nameLower.includes('claude') && !nameLower.includes('haiku')) ||
    idLower.includes('gpt-4') ||
    idLower.includes('gpt-5') ||
    idLower.includes('/o1') ||
    idLower.includes('/o3') ||
    idLower.includes('o1-') ||
    idLower.includes('o3-') ||
    idLower.includes('gemini-2') ||
    idLower.includes('gemini-1.5-pro') ||
    idLower.includes('deepseek') ||
    (idLower.includes('qwen') && (idLower.includes('coder') || idLower.includes('code'))) ||
    idLower.includes('coder') ||
    nameLower.includes('coder') ||
    isReasoningModel ||
    Boolean(supportsTools && (model.context_length ?? 0) >= 32000);

  return {
    supportsVision,
    supportsAudio,
    supportsTools,
    supportsReasoningEffort: isReasoningModel,
    supportedReasoningEfforts,
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
    outputModalities: outputModalities.length > 0 ? outputModalities : ['text'],
    isAgentic,
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
