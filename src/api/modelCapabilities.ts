import { OpenRouterModel } from './openrouterClient';

export interface ModelCapabilities {
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsTools: boolean;
  supportsReasoningEffort: boolean;
  supportedReasoningEfforts?: string[];
  inputModalities: string[];
  outputModalities: string[];
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
    };
  }

  const supportedParams = (model.supported_parameters || []).map((p) => p.toLowerCase());
  const hasReasoningParam =
    supportedParams.includes('reasoning_effort') ||
    supportedParams.includes('reasoning') ||
    supportedParams.includes('effort');

  const idLower = (model.id || '').toLowerCase();
  const descLower = (model.description || '').toLowerCase();
  const isReasoningModel =
    hasReasoningParam ||
    idLower.includes('/o1') ||
    idLower.includes('/o3') ||
    idLower.includes('o1-') ||
    idLower.includes('o3-') ||
    idLower.includes('reasoning') ||
    idLower.includes('deepseek-r1') ||
    descLower.includes('reasoning effort') ||
    descLower.includes('reasoning token');

  // Infer supported levels if model supports reasoning effort
  let supportedReasoningEfforts: string[] | undefined = undefined;
  if (isReasoningModel) {
    // Standard default levels
    supportedReasoningEfforts = ['low', 'medium', 'high'];
  }

  if (!model.architecture) {
    return {
      supportsVision: false,
      supportsAudio: false,
      supportsTools: false,
      supportsReasoningEffort: isReasoningModel,
      supportedReasoningEfforts,
      inputModalities: ['text'],
      outputModalities: ['text'],
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
    model.architecture.instruct_type !== null &&
    !model.id.includes('instruct-free') &&
    (model.description?.toLowerCase().includes('tool') ||
      model.id.includes('gpt-') ||
      model.id.includes('claude-') ||
      model.id.includes('gemini-'));

  return {
    supportsVision,
    supportsAudio,
    supportsTools,
    supportsReasoningEffort: isReasoningModel,
    supportedReasoningEfforts,
    inputModalities: inputModalities.length > 0 ? inputModalities : ['text'],
    outputModalities: outputModalities.length > 0 ? outputModalities : ['text'],
  };
}
