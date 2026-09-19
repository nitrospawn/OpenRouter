import * as vscode from 'vscode';

export class ReviewerCommentController implements vscode.Disposable {
  private _commentController: vscode.CommentController;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this._commentController = vscode.comments.createCommentController(
      'openrouter-reviewer',
      'OpenRouter Reviewer Comments'
    );

    // Provide commenting ranges across any lines in artifact documents
    this._commentController.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument, _token: vscode.CancellationToken) => {
        // Only provide commenting ranges for markdown artifacts (.md) or artifact paths
        const fsPath = document.uri.fsPath || document.uri.path || '';
        if (fsPath.includes('artifacts') || fsPath.endsWith('.md')) {
          const lineCount = document.lineCount || 1000;
          return [new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lineCount, 0))];
        }
        return undefined;
      },
    };

    this._disposables.push(this._commentController);
  }

  public get controller(): vscode.CommentController {
    return this._commentController;
  }

  /**
   * Adds or creates a comment thread bound to an artifact URI and line range.
   */
  public addCommentThread(
    uri: vscode.Uri,
    range: vscode.Range,
    initialCommentText: string,
    authorName = 'User'
  ): vscode.CommentThread {
    const newComment: vscode.Comment = {
      body: new vscode.MarkdownString(initialCommentText),
      mode: vscode.CommentMode.Preview,
      author: {
        name: authorName,
      },
    };

    const thread = this._commentController.createCommentThread(uri, range, [newComment]);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
    return thread;
  }

  /**
   * Appends a reply to an existing comment thread.
   */
  public replyToThread(
    thread: vscode.CommentThread,
    replyText: string,
    authorName = 'Reviewer'
  ): void {
    const reply: vscode.Comment = {
      body: new vscode.MarkdownString(replyText),
      mode: vscode.CommentMode.Preview,
      author: {
        name: authorName,
      },
    };
    thread.comments = [...thread.comments, reply];
  }

  public dispose() {
    this._disposables.forEach((d) => d.dispose());
    this._disposables = [];
  }
}
