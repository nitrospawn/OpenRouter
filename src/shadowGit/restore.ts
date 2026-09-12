import { ShadowRepo } from './shadowRepo';
import { DriftDetection } from './driftDetection';
import * as vscode from 'vscode';

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
      console.error('[ScopedRestore] Failed to restore files from checkpoint:', err);
      return { success: false };
    }
  }
}
