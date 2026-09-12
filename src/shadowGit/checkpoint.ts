import { ShadowRepo } from './shadowRepo';
import { GitignoreRespect } from './gitignoreRespect';
import * as path from 'path';

export interface CheckpointInfo {
  checkpointId: string;
  timestamp: number;
  description: string;
  affectedFiles: string[];
}

export class CheckpointManager {
  constructor(private readonly shadowRepo: ShadowRepo) {}

  /**
   * Captures the state of specific affected files right before/after an edit
   * and commits into shadow git, returning the commit SHA as checkpointId.
   */
  public async createCheckpoint(
    affectedFilesRelative: string[],
    description: string
  ): Promise<string | null> {
    const initialized = await this.shadowRepo.initialize();
    if (!initialized) {
      return null;
    }

    const workTree = this.shadowRepo.getWorkTree();
    const validFiles: string[] = [];

    for (const rel of affectedFilesRelative) {
      if (!GitignoreRespect.isIgnored(workTree, rel)) {
        validFiles.push(rel);
      }
    }

    if (validFiles.length === 0) {
      return null;
    }

    try {
      // Stage only the affected files
      await this.shadowRepo.runGit(['add', '--', ...validFiles]);

      // Commit changes to create the checkpoint
      const commitMsg = `checkpoint: ${description} [${validFiles.join(', ')}]`;
      await this.shadowRepo.runGit(['commit', '-m', commitMsg, '--allow-empty']);

      // Get latest commit hash
      const { stdout } = await this.shadowRepo.runGit(['rev-parse', 'HEAD']);
      const checkpointId = stdout.trim();
      return checkpointId;
    } catch (err) {
      console.error('[CheckpointManager] Failed to create checkpoint:', err);
      return null;
    }
  }
}
