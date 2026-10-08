const esbuild = require('esbuild');
const path = require('path');
const { spawnSync } = require('child_process');

async function run() {
  console.log('[test] Bundling test suite...');
  await esbuild.build({
    entryPoints: [
      'test/pricing.test.ts',
      'test/permissions.test.ts',
      'test/restore.test.ts',
      'test/secretScanner.test.ts',
      'test/contextReader.test.ts',
      'test/streamRetry.test.ts',
      'test/session.test.ts',
      'test/multiFileDiff.test.ts',
      'test/diagnostics.test.ts',
      'test/codeBlockUI.test.ts',
      'test/reasoningEffort.test.ts',
      'test/systemPrompt.test.ts',
      'test/terminalVerification.test.ts',
      'test/version.test.ts',
      'test/appendMessage.test.ts',
      'test/patchEdit.test.ts',
      'test/terminalOutputTracker.test.ts',
      'test/permissionConsolidation.test.ts',
      'test/artifacts.test.ts',
      'test/reviewerSettings.test.ts',
      'test/reviewerFlow.test.ts',
      'test/clarifyQuoteAttachment.test.ts',
      'test/usageReportSpend.test.ts',
      'test/agentProgressIndicator.test.ts',
      'test/reviewerStreamNavigation.test.ts',
      'test/childProcessTerminal.test.ts',
      'test/smartScroll.test.ts',
      'test/terminalSelfHealing.test.ts',
      'test/chunkManager.test.ts',
      'test/executionDuration.test.ts',
      'test/terminalMultilineVerification.test.ts',
      'test/filePathLinking.test.ts',
      'test/planRegenerationAndAttachments.test.ts',
      'test/terminalCollapseAndContinuation.test.ts',
      'test/diffCardCollapseAndOrdering.test.ts',
      'test/contextPreservation.test.ts',
      'test/executionSelfHealingAndContinuation.test.ts',
      'test/commandClassifier.test.ts',
      'test/fileMutationGuardAndTerminalDropdown.test.ts',
      'test/memoryManifest.test.ts',
      'test/filePreInjection.test.ts',
      'test/notificationSound.test.ts',
    ],
    bundle: true,
    outdir: 'dist/test',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    alias: {
      vscode: path.resolve(__dirname, 'mockVscode.ts'),
    },
  });

  console.log('[test] Executing tests via node --test...');
  const res = spawnSync(
    process.execPath,
    [
      '--test',
      'dist/test/pricing.test.js',
      'dist/test/permissions.test.js',
      'dist/test/restore.test.js',
      'dist/test/secretScanner.test.js',
      'dist/test/contextReader.test.js',
      'dist/test/streamRetry.test.js',
      'dist/test/session.test.js',
      'dist/test/multiFileDiff.test.js',
      'dist/test/diagnostics.test.js',
      'dist/test/codeBlockUI.test.js',
      'dist/test/reasoningEffort.test.js',
      'dist/test/systemPrompt.test.js',
      'dist/test/terminalVerification.test.js',
      'dist/test/version.test.js',
      'dist/test/appendMessage.test.js',
      'dist/test/patchEdit.test.js',
      'dist/test/terminalOutputTracker.test.js',
      'dist/test/permissionConsolidation.test.js',
      'dist/test/artifacts.test.js',
      'dist/test/reviewerSettings.test.js',
      'dist/test/reviewerFlow.test.js',
      'dist/test/clarifyQuoteAttachment.test.js',
      'dist/test/usageReportSpend.test.js',
      'dist/test/agentProgressIndicator.test.js',
      'dist/test/reviewerStreamNavigation.test.js',
      'dist/test/childProcessTerminal.test.js',
      'dist/test/smartScroll.test.js',
      'dist/test/terminalSelfHealing.test.js',
      'dist/test/chunkManager.test.js',
      'dist/test/executionDuration.test.js',
      'dist/test/terminalMultilineVerification.test.js',
      'dist/test/filePathLinking.test.js',
      'dist/test/planRegenerationAndAttachments.test.js',
      'dist/test/terminalCollapseAndContinuation.test.js',
      'dist/test/diffCardCollapseAndOrdering.test.js',
      'dist/test/contextPreservation.test.js',
      'dist/test/executionSelfHealingAndContinuation.test.js',
      'dist/test/commandClassifier.test.js',
      'dist/test/fileMutationGuardAndTerminalDropdown.test.js',
      'dist/test/memoryManifest.test.js',
      'dist/test/filePreInjection.test.js',
      'dist/test/notificationSound.test.js',
    ],
    {
      stdio: 'inherit',
    }
  );

  process.exit(res.status || 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
