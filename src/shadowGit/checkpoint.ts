import { ShadowRepo } from './shadowRepo';
import { GitignoreRespect } from './gitignoreRespect';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../logger';

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

    for (const raw of affectedFilesRelative) {
      let rel = raw.replace(/\\/g, '/');
      if (path.isAbsolute(raw)) {
        rel = path.relative(workTree, raw).replace(/\\/g, '/');
      }
      rel = rel.replace(/^\/+/, '');
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }
      if (rel.length > 0 && !GitignoreRespect.isIgnored(workTree, rel)) {
        validFiles.push(rel);
      }
    }

    if (validFiles.length === 0) {
      return null;
    }

    try {
      logger.info('SHADOW_GIT', `Creating checkpoint for ${validFiles.length} file(s): [${validFiles.join(', ')}] — "${description}"`);

      // Stage the affected files.
      // If batch add fails (e.g. one or more files in validFiles are new files being created that
      // do not exist on disk yet), stage existing files individually so new files don't abort checkpointing.
      try {
        await this.shadowRepo.runGit(['add', '--', ...validFiles]);
      } catch {
        for (const rel of validFiles) {
          try {
            await this.shadowRepo.runGit(['add', '--', rel]);
          } catch {
            // Non-existent file on disk (brand new file to be created) — safe to skip pre-staging
          }
        }
      }

      // Commit changes to create the checkpoint
      const commitMsg = `checkpoint: ${description} [${validFiles.join(', ')}]`;
      await this.shadowRepo.runGit(['commit', '-m', commitMsg, '--allow-empty']);

      // Get latest commit hash
      const { stdout } = await this.shadowRepo.runGit(['rev-parse', 'HEAD']);
      const checkpointId = stdout.trim();
      logger.info('SHADOW_GIT', `Checkpoint created: ${checkpointId.substring(0, 7)} — "${description}"`);
      return checkpointId;
    } catch (err) {
      logger.error('SHADOW_GIT', `Failed to create checkpoint for "${description}": ${err}`);
      console.error('[CheckpointManager] Failed to create checkpoint:', err);
      return null;
    }
  }
}
