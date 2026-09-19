import { ShadowRepo } from './shadowRepo';
import { DriftDetection } from './driftDetection';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class ScopedRestore {
  private driftDetector: DriftDetection;

  constructor(private readonly shadowRepo: ShadowRepo) {
    this.driftDetector = new DriftDetection(shadowRepo);
  }

  /**
   * Restores ONLY the specified files from the given checkpoint commit.
   * Hard requirement: Never touches files outside affectedFiles.
   */
  public async restore(
    checkpointId: string,
    affectedFiles: string[],
    force: boolean = false
  ): Promise<{ success: boolean; drifted?: boolean }> {
    if (affectedFiles.length === 0) {
      return { success: false };
    }

    // 1. Check for manual edits/drift unless force=true
    if (!force) {
      const drifted = await this.driftDetector.hasDrifted(checkpointId, affectedFiles);
      if (drifted) {
        return { success: false, drifted: true };
      }
    }

    try {
      // 2. Perform scoped checkout exclusively for the target files
      // git checkout <checkpointId> -- <file1> <file2>
      await this.shadowRepo.runGit(['checkout', checkpointId, '--', ...affectedFiles]);
      return { success: true };
    } catch (err) {
      // If batch checkout failed (e.g. one or more files in affectedFiles were newly created
      // after checkpointId and thus do not exist in that commit), restore each affected file individually:
      // - If the file existed in the checkpoint commit: checkout from commit.
      // - If the file did not exist in the checkpoint commit: delete it from the workspace disk.
      try {
        const workTree = this.shadowRepo.getWorkTree();
        let anyRestored = false;

        for (const rel of affectedFiles) {
          try {
            await this.shadowRepo.runGit(['checkout', checkpointId, '--', rel]);
            anyRestored = true;
          } catch {
            // File did not exist in the checkpoint commit (newly created file by the AI).
            // Safely delete it from the workspace disk.
            const fullPath = path.join(workTree, rel);
            if (fs.existsSync(fullPath)) {
              fs.rmSync(fullPath, { force: true, recursive: true });
              anyRestored = true;
            }
          }
        }

        if (anyRestored) {
          return { success: true };
        }
      } catch (innerErr) {
        console.error('[ScopedRestore] Failed to restore files individually:', innerErr);
      }

      console.error('[ScopedRestore] Failed to restore files from checkpoint:', err);
      return { success: false };
    }
  }
}
