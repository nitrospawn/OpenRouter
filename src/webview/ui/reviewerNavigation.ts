/**
 * Reviewer Navigation & Stream Preservation Helper
 *
 * Handles view switching decisions, active streaming indicator on the
 * header toggle button, and preservation of in-flight DOM elements
 * (step pill and assistant message bubble) across view toggles and session updates.
 */

export interface ReviewerNavigationState {
  hasStreamingAssistant: boolean;
  hasProgressManager: boolean;
  activeSessionId: string;
}

/**
 * Determines whether clicking the Reviewer toggle button should directly switch views
 * locally in the webview, or dispatch an OPEN_DIRECT_REVIEWER IPC message to the extension host.
 *
 * Direct local switch is used whenever:
 * 1. An active streaming assistant bubble exists, OR
 * 2. An active ReviewerProgressManager pill exists, OR
 * 3. A reviewer session is already loaded in memory (activeSessionId is non-empty).
 *
 * Otherwise (cold open on fresh start), it returns false to trigger OPEN_DIRECT_REVIEWER.
 */
export function shouldSwitchDirectToReviewer(state: ReviewerNavigationState): boolean {
  return Boolean(state.hasStreamingAssistant || state.hasProgressManager || state.activeSessionId);
}

/**
 * Manages the background streaming indicator class on the Reviewer toggle button.
 */
export function setReviewerButtonActivity(buttonEl: HTMLElement | null, active: boolean): void {
  if (!buttonEl) return;
  if (active) {
    buttonEl.classList.add('reviewer-streaming-active');
  } else {
    buttonEl.classList.remove('reviewer-streaming-active');
  }
}

/**
 * Safely preserves in-flight streaming DOM nodes (the progress pill and assistant message bubble)
 * when a session data message is received, ensuring that live streams are never wiped out of the DOM.
 */
export function preserveStreamingElements(
  container: HTMLElement,
  pillEl: HTMLElement | null,
  assistantBubbleEl: HTMLElement | null,
  renderHistory: () => void
): void {
  const preservedPill = pillEl && pillEl.parentNode === container ? pillEl : null;
  const preservedBubble = assistantBubbleEl && assistantBubbleEl.parentNode === container ? assistantBubbleEl : null;

  container.innerHTML = '';
  renderHistory();

  if (preservedPill) {
    container.appendChild(preservedPill);
  }
  if (preservedBubble) {
    container.appendChild(preservedBubble);
  }
}
