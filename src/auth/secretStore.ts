import * as vscode from 'vscode';
import { OpenRouterClient } from '../api/openrouterClient';

const SECRET_KEY_NAME = 'openrouter.apiKey';

export class SecretStore {
  private secrets: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.secrets = context.secrets;
  }

  public async getApiKey(): Promise<string | undefined> {
    return await this.secrets.get(SECRET_KEY_NAME);
  }

  public async storeApiKey(apiKey: string): Promise<{ success: boolean; label?: string; error?: string }> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return { success: false, error: 'API key cannot be empty.' };
    }

    const validation = await OpenRouterClient.validateApiKey(trimmed);
    if (!validation.isValid) {
      return { success: false, error: validation.error || 'Invalid OpenRouter API Key.' };
    }

    await this.secrets.store(SECRET_KEY_NAME, trimmed);
    return { success: true, label: validation.label };
  }

  public async clearApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY_NAME);
  }

  public async promptForApiKey(): Promise<boolean> {
    const input = await vscode.window.showInputBox({
      title: 'OpenRouter API Key',
      prompt: 'Enter your OpenRouter API Key (get one from openrouter.ai/keys)',
      password: true,
      ignoreFocusOut: true,
    });

    if (!input) {
      return false;
    }

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Validating OpenRouter API Key...',
        cancellable: false,
      },
      async () => {
        const result = await this.storeApiKey(input);
        if (result.success) {
          vscode.window.showInformationMessage(
            `OpenRouter API key saved successfully! (${result.label || 'Active'})`
          );
        } else {
          vscode.window.showErrorMessage(`Failed to validate key: ${result.error}`);
        }
      }
    );

    return true;
  }
}
