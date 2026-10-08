import * as vscode from 'vscode';

export class Configuration {
  private static readonly CONFIG_SECTION = 'openrouter';

  public static getLastModel(): string {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<string>('lastModel', '');
  }

  public static async setLastModel(modelId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('lastModel', modelId, vscode.ConfigurationTarget.Workspace);
  }

  public static getPanelPosition(): 'left' | 'right' {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<'left' | 'right'>('panelPosition', 'left');
  }

  public static async setPanelPosition(position: 'left' | 'right'): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('panelPosition', position, vscode.ConfigurationTarget.Global);
  }

  public static getAutoSummarize(): boolean {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<boolean>('autoSummarize', true);
  }

  public static async setAutoSummarize(val: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('autoSummarize', val, vscode.ConfigurationTarget.Global);
  }

  public static getFullHistoryResend(): boolean {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<boolean>('fullHistoryResend', false);
  }

  public static async setFullHistoryResend(val: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('fullHistoryResend', val, vscode.ConfigurationTarget.Global);
  }

  public static getWorkspaceMemoryInContext(): boolean {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<boolean>('context.workspaceMemoryInContext', true);
  }

  public static async setWorkspaceMemoryInContext(val: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('context.workspaceMemoryInContext', val, vscode.ConfigurationTarget.Workspace);
  }

  public static getRedactionMode(): 'mask' | 'block_and_warn' {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<'mask' | 'block_and_warn'>('privacy.redactionMode', 'mask');
  }

  public static async setRedactionMode(mode: 'mask' | 'block_and_warn'): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('privacy.redactionMode', mode, vscode.ConfigurationTarget.Global);
  }

  public static getDataCollectionPolicy(): 'deny' | 'allow' {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<'deny' | 'allow'>('privacy.dataCollectionPolicy', 'deny');
  }

  public static async setDataCollectionPolicy(policy: 'deny' | 'allow'): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('privacy.dataCollectionPolicy', policy, vscode.ConfigurationTarget.Global);
  }

  public static getWarnOnDataTraining(): boolean {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<boolean>('privacy.warnOnDataTraining', true);
  }

  public static async setWarnOnDataTraining(val: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('privacy.warnOnDataTraining', val, vscode.ConfigurationTarget.Global);
  }

  public static getDiagnosticsIncludeWarnings(): boolean {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<boolean>('diagnostics.includeWarnings', false);
  }

  public static getDiagnosticsMaxTokensThreshold(): number {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<number>('diagnostics.maxTokensWarningThreshold', 12000);
  }

  // --- Reviewer Model Settings (PRD Phase 10 - Strictly Per-Workspace) ---

  public static readonly DEFAULT_REVIEWER_SYSTEM_PROMPT =
    `You are an expert, meticulous code reviewer and architectural critic.
Your objective is to thoroughly evaluate the provided implementation plan or verification/walkthrough result.

Critique Guidelines:
1. Correctness & Logic: Identify faulty assumptions, subtle logic bugs, off-by-one errors, or concurrency/race conditions.
2. Completeness & Edge Cases: Check if missing files, unhandled error paths, null/undefined states, or boundary cases were overlooked.
3. Safety & Security: Flag security vulnerabilities, unescaped inputs, unauthorized actions, destructive commands, or secret exposure.
4. Architectural Quality & Regression Risk: Ensure adherence to Clean Architecture, single responsibility, type safety, and minimal side effects on untouched files.
5. Fenced Copy-Intended Content: Always emit code snippets, diffs, config samples, or terminal commands inside dedicated fenced code blocks with language tags, separate from prose explanation.

Provide a constructive, prioritized critique with clear, actionable recommendations. Be concise, rigorous, and direct.`;

  public static getReviewerEnabled(): boolean {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<boolean>('reviewer.enabled', false);
  }

  public static async setReviewerEnabled(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('reviewer.enabled', enabled, vscode.ConfigurationTarget.Workspace);
  }

  public static getReviewerModel(): string {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<string>('reviewer.model', '');
  }

  public static async setReviewerModel(modelId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('reviewer.model', modelId, vscode.ConfigurationTarget.Workspace);
  }

  public static getReviewerReasoningEffort(): string {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<string>('reviewer.reasoningEffort', 'medium');
  }

  public static async setReviewerReasoningEffort(effort: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('reviewer.reasoningEffort', effort, vscode.ConfigurationTarget.Workspace);
  }

  public static getReviewerSystemPrompt(): string {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    const custom = config.get<string>('reviewer.systemPrompt', '');
    return custom && custom.trim().length > 0 ? custom : this.DEFAULT_REVIEWER_SYSTEM_PROMPT;
  }

  public static async setReviewerSystemPrompt(prompt: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('reviewer.systemPrompt', prompt, vscode.ConfigurationTarget.Workspace);
  }

  public static async resetReviewerSystemPrompt(): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    // Resetting to undefined removes the per-workspace override, reverting to default
    await config.update('reviewer.systemPrompt', undefined, vscode.ConfigurationTarget.Workspace);
  }

  public static getReviewerPinnedContextFile(): string {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<string>('reviewer.pinnedContextFile', '');
  }

  public static async setReviewerPinnedContextFile(filePath: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('reviewer.pinnedContextFile', filePath ? filePath.trim() : undefined, vscode.ConfigurationTarget.Workspace);
  }

  public static getNotificationSound(): boolean {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<boolean>('notificationSound', true);
  }

  public static async setNotificationSound(enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('notificationSound', enabled, vscode.ConfigurationTarget.Global);
  }

  public static getNotificationTone(): 'bell' | 'chime' | 'pop' | 'ding' {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    return config.get<'bell' | 'chime' | 'pop' | 'ding'>('notificationTone', 'bell');
  }

  public static async setNotificationTone(tone: 'bell' | 'chime' | 'pop' | 'ding'): Promise<void> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    await config.update('notificationTone', tone, vscode.ConfigurationTarget.Global);
  }

  /**
   * Returns a map of modelId → boolean for user-defined agentic overrides.
   * Example setting value: { "qwen/qwen2.5-coder-7b-instruct": true, "some/tiny-model": false }
   */
  public static getAgenticOverrides(): Record<string, boolean> {
    const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);
    const raw = config.get<Record<string, boolean>>('models.agenticOverrides', {});
    // Validate: ensure values are booleans, silently drop invalid entries
    const result: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val === 'boolean') {
        result[key] = val;
      }
    }
    return result;
  }
}

