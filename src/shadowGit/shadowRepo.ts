import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

export class ShadowRepo {
  private gitDir: string;
  private workTree: string;
  private isInitialized = false;

  constructor(storageUri: vscode.Uri, workspaceFolderUri: vscode.Uri) {
    this.gitDir = path.join(storageUri.fsPath, 'shadow.git');
    this.workTree = workspaceFolderUri.fsPath;
  }

  public async initialize(): Promise<boolean> {
    if (this.isInitialized) {
      return true;
    }

    try {
      if (!fs.existsSync(this.gitDir)) {
        logger.info('SHADOW_GIT', `Initializing shadow git repository at: ${this.gitDir} (worktree: ${this.workTree})`);
        fs.mkdirSync(this.gitDir, { recursive: true });
        // Initialize an isolated git repo without modifying the workspace directory
        await execFileAsync('git', ['--git-dir', this.gitDir, '--work-tree', this.workTree, 'init']);
        
        // Configure minimal user.name and user.email for commits
        await this.runGit(['config', 'user.name', 'OpenRouter Shadow']);
        await this.runGit(['config', 'user.email', 'shadow@openrouter.internal']);
        // Avoid core.autocrlf issues across platforms
        await this.runGit(['config', 'core.autocrlf', 'false']);
        logger.info('SHADOW_GIT', 'Shadow git repository initialized successfully');
      }
      this.isInitialized = true;
      return true;
    } catch (err) {
      logger.error('SHADOW_GIT', `Failed to initialize shadow git repository: ${err}`);
      console.error('[ShadowRepo] Failed to initialize shadow repo:', err);
      return false;
    }
  }

  public async runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const fullArgs = ['--git-dir', this.gitDir, '--work-tree', this.workTree, ...args];
    return execFileAsync('git', fullArgs, { cwd: this.workTree });
  }

  public getGitDir(): string {
    return this.gitDir;
  }

  public getWorkTree(): string {
    return this.workTree;
  }

  public async clean(): Promise<void> {
    try {
      if (fs.existsSync(this.gitDir)) {
        logger.info('SHADOW_GIT', `Cleaned shadow repository: ${this.gitDir}`);
        fs.rmSync(this.gitDir, { recursive: true, force: true });
      }
      this.isInitialized = false;
    } catch (err) {
      logger.error('SHADOW_GIT', `Failed to clean shadow git: ${err}`);
      console.error('[ShadowRepo] Failed to clean shadow git:', err);
    }
  }
}
