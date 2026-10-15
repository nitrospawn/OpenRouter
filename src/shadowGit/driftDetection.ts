import { ShadowRepo } from './shadowRepo';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';

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
          logger.warn('SHADOW_GIT', `Drift detected: file ${relFile} was deleted on disk since checkpoint ${checkpointId.substring(0, 7)}`);
          return true;
        }

        // Compare file with checkpoint blob using git diff
        let { stdout } = await this.shadowRepo.runGit([
          'diff',
          checkpointId,
          '--',
          relFile,
        ]);

        if (stdout.trim().length === 0) {
          // If exact match yielded no diff, check if casing differs in git index/tree
          try {
            const icaseRes = await this.shadowRepo.runGit([
              'diff',
              checkpointId,
              '--',
              `:(icase)${relFile}`,
            ]);
            stdout = icaseRes.stdout;
          } catch {
            // non-fatal
          }
        }

        if (stdout.trim().length > 0) {
          logger.warn('SHADOW_GIT', `Drift detected: file ${relFile} was modified on disk since checkpoint ${checkpointId.substring(0, 7)}`);
          return true;
        }
      }
      logger.info('SHADOW_GIT', `Drift check clean: 0 modifications detected against checkpoint ${checkpointId.substring(0, 7)}`);
      return false;
    } catch (err) {
      logger.error('SHADOW_GIT', `Error during drift check for checkpoint ${checkpointId.substring(0, 7)}: ${err}`);
      console.error('[DriftDetection] Error checking drift:', err);
      // Fail-safe: assume drift to avoid silent destructive overwrite
      return true;
    }
  }
}
