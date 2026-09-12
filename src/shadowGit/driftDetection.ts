import { ShadowRepo } from './shadowRepo';
import * as fs from 'fs';
import * as path from 'path';

export class DriftDetection {
  constructor(private readonly shadowRepo: ShadowRepo) {}

  /**
   * Checks whether any affected file has drifted (modified on disk) compared to
   * the shadow git tree at checkpointId.
   */
  public async hasDrifted(checkpointId: string, affectedFiles: string[]): Promise<boolean> {
    try {
      const workTree = this.shadowRepo.getWorkTree();

      for (const relFile of affectedFiles) {
        const fullPath = path.join(workTree, relFile);
        if (!fs.existsSync(fullPath)) {
          // File was deleted manually
          return true;
        }

        // Compare file with checkpoint blob using git diff
        const { stdout } = await this.shadowRepo.runGit([
          'diff',
          checkpointId,
          '--',
          relFile,
        ]);

        if (stdout.trim().length > 0) {
          return true;
        }
      }
      return false;
    } catch (err) {
      console.error('[DriftDetection] Error checking drift:', err);
      // Fail-safe: assume drift to avoid silent destructive overwrite
      return true;
    }
  }
}
