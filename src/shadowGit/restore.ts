import { ShadowRepo } from './shadowRepo';
import { DriftDetection } from './driftDetection';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';

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

    const workTree = this.shadowRepo.getWorkTree();
    const normalizedFiles = affectedFiles
      .map((f) => {
        let rel = f.replace(/\\/g, '/');
        if (path.isAbsolute(f)) {
          rel = path.relative(workTree, f).replace(/\\/g, '/');
        }
        return rel.replace(/^\/+/, '').replace(/^\.\//, '');
      })
      .filter((rel) => rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel));

    if (normalizedFiles.length === 0) {
      return { success: false };
    }

    logger.info('SHADOW_GIT', `Restore requested from checkpoint ${checkpointId.substring(0, 7)} for ${normalizedFiles.length} file(s): [${normalizedFiles.join(', ')}] (force: ${force})`);

    // 1. Check for manual edits/drift unless force=true
    if (!force) {
      const drifted = await this.driftDetector.hasDrifted(checkpointId, normalizedFiles);
      if (drifted) {
        logger.warn('SHADOW_GIT', `Drift detected on files before restore from ${checkpointId.substring(0, 7)}: [${normalizedFiles.join(', ')}]`);
        return { success: false, drifted: true };
      }
    }

    try {
      // 2. Perform scoped checkout exclusively for the target files
      // git checkout <checkpointId> -- <file1> <file2>
      await this.shadowRepo.runGit(['checkout', checkpointId, '--', ...normalizedFiles]);
      await this._syncOpenDocuments(normalizedFiles, workTree);
      logger.info('SHADOW_GIT', `Batch restore successful from checkpoint ${checkpointId.substring(0, 7)} for: [${normalizedFiles.join(', ')}]`);
      return { success: true };
    } catch (err) {
      // If batch checkout failed (e.g. casing mismatch or one or more files were newly created
      // after checkpointId and do not exist in that commit), first try case-insensitive batch checkout:
      try {
        const icaseFiles = normalizedFiles.map((f) => `:(icase)${f}`);
        await this.shadowRepo.runGit(['checkout', checkpointId, '--', ...icaseFiles]);
        await this._syncOpenDocuments(normalizedFiles, workTree);
        logger.info('SHADOW_GIT', `Batch case-insensitive restore successful from checkpoint ${checkpointId.substring(0, 7)} for: [${normalizedFiles.join(', ')}]`);
        return { success: true };
      } catch {
        // Fall back to individual file restore
      }

      try {
        let anyRestored = false;

        for (const rel of normalizedFiles) {
          let fileRestored = false;

          // 1. Try exact checkout
          try {
            await this.shadowRepo.runGit(['checkout', checkpointId, '--', rel]);
            fileRestored = true;
            anyRestored = true;
            logger.info('SHADOW_GIT', `Individually restored ${rel} from checkpoint ${checkpointId.substring(0, 7)}`);
          } catch {
            // 2. Try case-insensitive checkout for platforms / git trees where casing differs
            try {
              await this.shadowRepo.runGit(['checkout', checkpointId, '--', `:(icase)${rel}`]);
              fileRestored = true;
              anyRestored = true;
              logger.info('SHADOW_GIT', `Individually restored ${rel} (case-insensitive) from checkpoint ${checkpointId.substring(0, 7)}`);
            } catch {
              // File does not exist in checkpoint commit in any casing
            }
          }

          if (!fileRestored) {
            // File did not exist in the checkpoint commit in ANY casing (brand new file created by the AI).
            // Safely delete it from the workspace disk only if strictly inside workTree.
            const fullPath = path.isAbsolute(rel) ? rel : path.join(workTree, rel);
            const relCheck = path.relative(workTree, fullPath);
            if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
              continue;
            }
            if (fs.existsSync(fullPath)) {
              fs.rmSync(fullPath, { force: true, recursive: true });
              anyRestored = true;
              logger.info('SHADOW_GIT', `Deleted post-checkpoint created file: ${rel}`);
            }
          }
        }

        if (anyRestored) {
          await this._syncOpenDocuments(normalizedFiles, workTree);
          logger.info('SHADOW_GIT', `Individual fallback restore completed for checkpoint ${checkpointId.substring(0, 7)}`);
          return { success: true };
        }
      } catch (innerErr) {
        logger.error('SHADOW_GIT', `Failed to restore files individually from checkpoint ${checkpointId.substring(0, 7)}: ${innerErr}`);
        console.error('[ScopedRestore] Failed to restore files individually:', innerErr);
      }

      logger.error('SHADOW_GIT', `Failed to restore files from checkpoint ${checkpointId.substring(0, 7)}: ${err}`);
      console.error('[ScopedRestore] Failed to restore files from checkpoint:', err);
      return { success: false };
    }
  }

  /**
   * Refreshes any open VS Code text documents to immediately reflect the restored disk contents on screen.
   */
  private async _syncOpenDocuments(files: string[], workTree: string): Promise<void> {
    try {
      if (!vscode.workspace || !vscode.workspace.textDocuments) return;
      for (const rel of files) {
        const fullPath = path.isAbsolute(rel) ? rel : path.join(workTree, rel);
        const normFullPath = path.resolve(fullPath).toLowerCase();
        for (const doc of vscode.workspace.textDocuments) {
          if (doc.uri?.fsPath && path.resolve(doc.uri.fsPath).toLowerCase() === normFullPath) {
            if (fs.existsSync(fullPath)) {
              const diskContent = fs.readFileSync(fullPath, 'utf8');
              if (doc.getText() !== diskContent) {
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                  doc.positionAt(0),
                  doc.positionAt(doc.getText().length)
                );
                edit.replace(doc.uri, fullRange, diskContent);
                await vscode.workspace.applyEdit(edit);
                if (typeof doc.save === 'function') {
                  await doc.save();
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ScopedRestore] Failed to sync open editor documents:', err);
    }
  }
}
