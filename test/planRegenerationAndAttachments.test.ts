import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { ArtifactDocumentManager } from '../src/editor/artifactDocumentManager';
import { extractArtifacts } from '../src/prompt/responseParser';

describe('Plan Regeneration & Attachment Capsules', () => {
  test('ArtifactDocumentManager.isArtifactUri correctly detects internal artifact storage URIs', () => {
    const planUri = vscode.Uri.file('C:\\Users\\HP\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc\\artifacts\\implementation_plan_123.md');
    const walkthroughUri = vscode.Uri.file('/home/user/.config/Code/User/workspaceStorage/xyz/artifacts/walkthrough_456.md');
    const tempArtifactUri = vscode.Uri.file('/tmp/openrouter-artifacts/implementation_plan_default.md');
    const workspaceCodeUri = vscode.Uri.file('C:\\Users\\HP\\project\\src\\main.ts');
    const workspaceDocUri = vscode.Uri.file('C:\\Users\\HP\\project\\Docs\\PRD.md');

    assert.strictEqual(ArtifactDocumentManager.isArtifactUri(planUri), true);
    assert.strictEqual(ArtifactDocumentManager.isArtifactUri(walkthroughUri), true);
    assert.strictEqual(ArtifactDocumentManager.isArtifactUri(tempArtifactUri), true);
    assert.strictEqual(ArtifactDocumentManager.isArtifactUri(workspaceCodeUri), false);
    assert.strictEqual(ArtifactDocumentManager.isArtifactUri(workspaceDocUri), false);
  });

  test('extractArtifacts extracts ```plan blocks and inserts Plan docs ready', () => {
    const rawContent = `I have revised the plan based on your review feedback.
\`\`\`plan
# Phase 1 Implementation Plan (Revised)
## Steps
1. First step...
\`\`\`
Would you like me to proceed with this plan?`;

    const result = extractArtifacts(rawContent);

    assert.ok(result.planDocument);
    assert.ok(result.planDocument.includes('# Phase 1 Implementation Plan (Revised)'));
    assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
    assert.ok(!result.chatSummary.includes('## Steps'));
  });

  test('extractArtifacts: preserves full plan when plan contains inner untagged and tagged code blocks without premature truncation', () => {
    const rawContent = `Here is the fully revised Phase 1 implementation plan with all 10 review fixes applied, each marked with <!-- FIX-n --> so you can diff against the original:

\`\`\`plan
# Phase 1 Architecture
\`\`\`
-> Feature Controllers (Riverpod providers, sealed states)
-> Repositories (domain models)
-> DAOs (Drift table classes — NEVER imported into UI/Widgets)

\`\`\`text
- Drift table classes (\`Notes\`, \`Tasks\`, etc.) are **repository-internal**...
- Enforcement: lint rule + code-review checklist; a \`drift\` import in \`lib/ui/\` fails CI.

### 3.2 Controller State Types

Every feature controller exposes a **sealed state type**:
\`\`\`

\`\`\`dart
sealed class NotesState {}
class NotesLoading extends NotesState {}
class NotesData extends NotesState { final List<Note> notes; final bool isRefreshing; }
class NotesError extends NotesState { final AppError error; }
\`\`\`
\`\`\`
Would you like me to proceed with this plan?`;

    const result = extractArtifacts(rawContent);

    // Verify 100% of plan document was captured
    assert.ok(result.planDocument, 'planDocument must be defined');
    assert.ok(result.planDocument.includes('# Phase 1 Architecture'));
    assert.ok(result.planDocument.includes('-> Feature Controllers (Riverpod providers, sealed states)'));
    assert.ok(result.planDocument.includes('### 3.2 Controller State Types'));
    assert.ok(result.planDocument.includes('sealed class NotesState {}'));
    assert.ok(result.planDocument.includes('class NotesError extends NotesState'));

    // Verify zero plan leakage into chat summary
    assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
    assert.ok(!result.chatSummary.includes('-> Feature Controllers'));
    assert.ok(!result.chatSummary.includes('### 3.2 Controller State Types'));
    assert.ok(!result.chatSummary.includes('NotesState'));
    assert.ok(result.chatSummary.includes('Would you like me to proceed with this plan?'));
  });

  test('extractArtifacts: supports 4-backtick ````plan envelopes with inner 3-backtick code blocks', () => {
    const rawContent = `I have generated the plan.
\`\`\`\`plan
# Comprehensive Plan
\`\`\`typescript
export interface AppConfig {
  apiKey: string;
}
\`\`\`
## Next Steps
\`\`\`bash
npm run test
\`\`\`
\`\`\`\`
Would you like me to proceed?`;

    const result = extractArtifacts(rawContent);

    assert.ok(result.planDocument);
    assert.ok(result.planDocument.includes('# Comprehensive Plan'));
    assert.ok(result.planDocument.includes('export interface AppConfig'));
    assert.ok(result.planDocument.includes('npm run test'));
    assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
    assert.ok(!result.chatSummary.includes('AppConfig'));
    assert.ok(result.chatSummary.includes('Would you like me to proceed?'));
  });

  test('extractArtifacts resilient fallback: intercepts edit_file block targeting implementation_plan and extracts plan', () => {
    const rawContent = `I'll replace the Phase 1 implementation plan with a revised version addressing all 10 review fixes.
\`\`\`edit_file:C:\\Users\\HP\\AppData\\Roaming\\artifacts\\implementation_plan_123.md
<<<< SEARCH
Old plan text
=======
# Phase 1 Implementation Plan (Fixed)
## Updated Steps
1. Addressed comment 1
2. Addressed comment 2
>>>>
\`\`\`
Would you like me to proceed?`;

    const result = extractArtifacts(rawContent);

    assert.ok(result.planDocument);
    assert.ok(result.planDocument.includes('# Phase 1 Implementation Plan (Fixed)'));
    assert.ok(result.planDocument.includes('Addressed comment 1'));
    assert.ok(result.chatSummary.includes('📄 Plan docs ready — [view]'));
    assert.ok(!result.chatSummary.includes('<<<< SEARCH'));
  });

  test('Reviewer feedback parsing: extracts feedback data for capsule and cleans display content', () => {
    const rawUserMessage = `<!-- reviewer-feedback:start -->
[Reviewer Feedback]:
1. Fix section 2.
2. Add verification steps.
<!-- reviewer-feedback:end -->

make this fixes to the curret plan`;

    const feedbackMatch = rawUserMessage.match(/<!-- reviewer-feedback:start -->[\s\S]*?\[Reviewer Feedback\]:\s*([\s\S]*?)<!-- reviewer-feedback:end -->/);
    assert.ok(feedbackMatch);
    const reviewerFeedbackData = feedbackMatch[1].trim();
    assert.ok(reviewerFeedbackData.includes('1. Fix section 2.'));

    const stripped = rawUserMessage.replace(/<!-- reviewer-feedback:start -->[\s\S]*?<!-- reviewer-feedback:end -->\s*/g, '').trim();
    assert.strictEqual(stripped, 'make this fixes to the curret plan');
  });

  test('Attached file detection: extracts attached document filename', () => {
    const rawUserMessage = `\`\`\`PRD.md
# Product Requirements Document
...
\`\`\`

Please review this file`;

    const fileMatches = Array.from(rawUserMessage.matchAll(/(?:^|\n)```([a-zA-Z0-9_.\-/\\]+\.[a-zA-Z0-9]+)\r?\n[\s\S]*?```/g));
    assert.strictEqual(fileMatches.length, 1);
    assert.strictEqual(fileMatches[0][1], 'PRD.md');
  });
});
