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
}
