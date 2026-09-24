// Agent Progress Indicator Module (Main Chat + Reviewer Panel)

export type MainAgentPhase = 'working' | 'context' | 'planning' | 'writing' | 'verifying';
export type ReviewerPhase = 'reviewing' | 'issues' | 'feedback';

export const MAIN_AGENT_LABELS: Record<MainAgentPhase, string> = {
  working: 'Working',
  context: 'Resolving context',
  planning: 'Drawing up a plan',
  writing: 'Writing changes',
  verifying: 'Verifying results',
};

export const REVIEWER_LABELS: Record<ReviewerPhase, string> = {
  reviewing: 'Reviewing',
  issues: 'Identifying issues',
  feedback: 'Formulating feedback',
};

const MAIN_CONTEXT_KEYWORDS = ['search', 'looking', 'found', 'clarif', 'resolv', 'inspect'];
const MAIN_PLANNING_KEYWORDS = [
  'plan',
  'i will',
  "i'll",
  "here's what",
  'here is what',
  'step 1',
  'implementation',
  'implement',
];
const CODE_BLOCK_REGEX = /(?:```|~~~)(?:edit_file|create_file|file:|bash)\b/i;
const PLAN_BLOCK_REGEX = /(?:```|~~~)(?:plan)\b/i;
const WALKTHROUGH_BLOCK_REGEX = /(?:```|~~~)(?:walkthrough)\b/i;
const VERIFY_KEYWORDS = ['verif', 'check', 'diagnostic', 'test', 'walkthrough'];

const REVIEWER_ISSUE_KEYWORDS = [
  'concern',
  'issue',
  'bug',
  'vulnerab',
  'risk',
  'problem',
  'flaw',
  'defect',
  'warning',
];
const REVIEWER_FEEDBACK_KEYWORDS = [
  'suggest',
  'recommend',
  'consider',
  'improve',
  'feedback',
  'advice',
  'proposal',
  'optimiz',
];
const REVIEWER_REVIEW_KEYWORDS = ['review', 'assess', 'analyz', 'evaluat', 'inspect', 'examin'];

export interface MainProgressState {
  phase: MainAgentPhase;
  prefixLocked: boolean;
  codeBlockDetected: boolean;
}

export interface ReviewerProgressState {
  phase: ReviewerPhase;
  locked: boolean;
}

/**
 * Evaluates accumulated text and updates Main Chat step detection state.
 */
export function detectMainAgentStep(
  accumulated: string,
  state: MainProgressState
): { changed: boolean; phase: MainAgentPhase; label: string } {
  const prevPhase = state.phase;

  // 1. Code block detection across full content (Action Execution)
  if (!state.codeBlockDetected) {
    if (CODE_BLOCK_REGEX.test(accumulated)) {
      state.codeBlockDetected = true;
      state.phase = 'writing';
    } else if (PLAN_BLOCK_REGEX.test(accumulated) && state.phase !== 'writing') {
      state.phase = 'planning';
      state.prefixLocked = true;
    }
  } else if (state.phase === 'writing') {
    // 2. Verification keyword or walkthrough detection after code block
    if (WALKTHROUGH_BLOCK_REGEX.test(accumulated)) {
      state.phase = 'verifying';
    } else {
      const match = CODE_BLOCK_REGEX.exec(accumulated);
      if (match) {
        const postCodeText = accumulated.slice(match.index + match[0].length).toLowerCase();
        if (VERIFY_KEYWORDS.some((kw) => postCodeText.includes(kw))) {
          state.phase = 'verifying';
        }
      }
    }
  }

  // 3. Prefix matching if code block has not overridden and prefix not yet locked
  if (!state.codeBlockDetected && !state.prefixLocked) {
    const prefix = accumulated.slice(0, 300).toLowerCase();

    if (MAIN_CONTEXT_KEYWORDS.some((kw) => prefix.includes(kw))) {
      state.phase = 'context';
      state.prefixLocked = true;
    } else if (MAIN_PLANNING_KEYWORDS.some((kw) => prefix.includes(kw)) || PLAN_BLOCK_REGEX.test(accumulated)) {
      state.phase = 'planning';
      state.prefixLocked = true;
    }
  }

  return {
    changed: state.phase !== prevPhase,
    phase: state.phase,
    label: MAIN_AGENT_LABELS[state.phase],
  };
}

/**
 * Evaluates accumulated text and updates Reviewer step detection state.
 */
export function detectReviewerStep(
  accumulated: string,
  state: ReviewerProgressState
): { changed: boolean; phase: ReviewerPhase; label: string } {
  const prevPhase = state.phase;

  if (!state.locked) {
    const prefix = accumulated.slice(0, 350).toLowerCase();

    // Priority 1: Check issues first as it is the most critical and specific review finding
    if (REVIEWER_ISSUE_KEYWORDS.some((kw) => prefix.includes(kw))) {
      state.phase = 'issues';
      state.locked = true;
    } else if (REVIEWER_FEEDBACK_KEYWORDS.some((kw) => prefix.includes(kw))) {
      // Priority 2: Actionable feedback / recommendations
      state.phase = 'feedback';
      state.locked = true;
    } else if (REVIEWER_REVIEW_KEYWORDS.some((kw) => prefix.includes(kw))) {
      // Priority 3: General review
      state.phase = 'reviewing';
      state.locked = true;
    } else if (accumulated.length >= 350) {
      state.locked = true;
    }
  }

  return {
    changed: state.phase !== prevPhase,
    phase: state.phase,
    label: REVIEWER_LABELS[state.phase],
  };
}

/**
 * Controls the activity-reactive left-border glow on the message bubble.
 * Pulses faster (~0.6s) during chunk arrival and slower (~2.2s) during idle pauses.
 */
export class BubbleActivityController {
  private el: HTMLElement | null = null;
  private idleTimer: any = null;
  private isFast: boolean = false;

  constructor(el: HTMLElement) {
    this.el = el;
    this.el.classList.add('streaming-active');
    this.setSpeed('2.2s');
  }

  public onChunk(): void {
    if (!this.el) return;

    if (!this.isFast) {
      this.isFast = true;
      this.setSpeed('0.6s');
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.isFast = false;
      this.setSpeed('2.2s');
    }, 400);
  }

  private setSpeed(speed: string): void {
    if (this.el) {
      this.el.style.setProperty('--streaming-pulse-speed', speed);
    }
  }

  public cleanup(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.el) {
      this.el.classList.remove('streaming-active');
      this.el.style.removeProperty('--streaming-pulse-speed');
      this.el = null;
    }
    this.isFast = false;
  }
}

/**
 * Creates the DOM element for the Step-Label Pill with animated CSS ellipsis.
 */
export function createStepPill(initialLabel: string): HTMLElement {
  const pill = document.createElement('div');
  pill.className = 'agent-step-pill';

  const dot = document.createElement('span');
  dot.className = 'pill-dot';

  const label = document.createElement('span');
  label.className = 'pill-label';
  label.textContent = initialLabel;

  const ellipsis = document.createElement('span');
  ellipsis.className = 'pill-ellipsis';
  ellipsis.textContent = '...';

  pill.appendChild(dot);
  pill.appendChild(label);
  pill.appendChild(ellipsis);

  return pill;
}

/**
 * Updates the label displayed in an existing pill.
 */
export function updateStepPillLabel(pillEl: HTMLElement | null, labelText: string): void {
  if (!pillEl) return;
  const labelSpan = pillEl.querySelector('.pill-label');
  if (labelSpan && labelSpan.textContent !== labelText) {
    labelSpan.textContent = labelText;
  }
}

/**
 * Removes a pill immediately without fade transition.
 */
export function removePillImmediately(pillEl: HTMLElement | null): void {
  if (pillEl && pillEl.parentNode) {
    pillEl.remove();
  }
}

/**
 * Fades out a pill (150ms) and calls onRemoved callback only after the pill is completely removed from DOM.
 * Handles prefers-reduced-motion synchronously.
 */
export function removePillWithFade(pillEl: HTMLElement | null, onRemoved: () => void): void {
  if (!pillEl || !pillEl.parentNode) {
    onRemoved();
    return;
  }

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReducedMotion) {
    pillEl.remove();
    onRemoved();
    return;
  }

  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    pillEl.removeEventListener('transitionend', onTransitionEnd);
    if (pillEl.parentNode) {
      pillEl.remove();
    }
    onRemoved();
  };

  const onTransitionEnd = (e: TransitionEvent) => {
    if (e.propertyName === 'opacity') {
      finish();
    }
  };

  pillEl.addEventListener('transitionend', onTransitionEnd);
  // Safety timeout in case transitionend is swallowed
  setTimeout(finish, 200);

  pillEl.classList.add('pill-fading-out');
}

/**
 * Manager for Main Chat agent progress indicator.
 */
export class MainProgressManager {
  private pillEl: HTMLElement | null = null;
  private bubbleController: BubbleActivityController | null = null;
  private state: MainProgressState = {
    phase: 'working',
    prefixLocked: false,
    codeBlockDetected: false,
  };
  private accumulated: string = '';
  private currentCustomLabel: string | null = null;

  constructor(container: HTMLElement, bubbleEl: HTMLElement) {
    this.pillEl = createStepPill(MAIN_AGENT_LABELS.working);
    if (bubbleEl.parentNode === container) {
      container.insertBefore(this.pillEl, bubbleEl);
    } else {
      container.appendChild(this.pillEl);
    }
    this.bubbleController = new BubbleActivityController(bubbleEl);
  }

  public setStep(label: string, detail?: string): void {
    const text = detail ? `${label}: ${detail}` : label;
    this.currentCustomLabel = text;
    updateStepPillLabel(this.pillEl, text);
    if (this.bubbleController) {
      this.bubbleController.onChunk();
    }
  }

  public onChunk(chunk: string): void {
    this.accumulated += chunk;
    if (this.bubbleController) {
      this.bubbleController.onChunk();
    }
    const res = detectMainAgentStep(this.accumulated, this.state);
    if (res.changed) {
      this.currentCustomLabel = null;
      updateStepPillLabel(this.pillEl, res.label);
    }
  }

  public getPhase(): MainAgentPhase {
    return this.state.phase;
  }

  public getLabel(): string {
    return this.currentCustomLabel || MAIN_AGENT_LABELS[this.state.phase];
  }

  public getPillElement(): HTMLElement | null {
    return this.pillEl;
  }

  public cleanupImmediate(): void {
    if (this.bubbleController) {
      this.bubbleController.cleanup();
      this.bubbleController = null;
    }
    removePillImmediately(this.pillEl);
    this.pillEl = null;
  }

  public cleanupWithFade(onRemoved: () => void): void {
    if (this.bubbleController) {
      this.bubbleController.cleanup();
      this.bubbleController = null;
    }
    const currentPill = this.pillEl;
    this.pillEl = null;
    removePillWithFade(currentPill, onRemoved);
  }
}

/**
 * Manager for Reviewer Panel agent progress indicator.
 */
export class ReviewerProgressManager {
  private pillEl: HTMLElement | null = null;
  private bubbleController: BubbleActivityController | null = null;
  private state: ReviewerProgressState = {
    phase: 'reviewing',
    locked: false,
  };
  private accumulated: string = '';
  private currentCustomLabel: string | null = null;

  constructor(container: HTMLElement) {
    this.pillEl = createStepPill(REVIEWER_LABELS.reviewing);
    container.appendChild(this.pillEl);
  }

  public setStep(label: string, detail?: string): void {
    const text = detail ? `${label}: ${detail}` : label;
    this.currentCustomLabel = text;
    updateStepPillLabel(this.pillEl, text);
    if (this.bubbleController) {
      this.bubbleController.onChunk();
    }
  }

  public attachBubble(bubbleEl: HTMLElement): void {
    if (!this.bubbleController) {
      this.bubbleController = new BubbleActivityController(bubbleEl);
    }
  }

  public onChunk(chunk: string): void {
    this.accumulated += chunk;
    if (this.bubbleController) {
      this.bubbleController.onChunk();
    }
    const res = detectReviewerStep(this.accumulated, this.state);
    if (res.changed) {
      this.currentCustomLabel = null;
      updateStepPillLabel(this.pillEl, res.label);
    }
  }

  public getPhase(): ReviewerPhase {
    return this.state.phase;
  }

  public getLabel(): string {
    return this.currentCustomLabel || REVIEWER_LABELS[this.state.phase];
  }

  public getPillElement(): HTMLElement | null {
    return this.pillEl;
  }

  public cleanupImmediate(): void {
    if (this.bubbleController) {
      this.bubbleController.cleanup();
      this.bubbleController = null;
    }
    removePillImmediately(this.pillEl);
    this.pillEl = null;
  }

  public cleanupWithFade(onRemoved: () => void): void {
    if (this.bubbleController) {
      this.bubbleController.cleanup();
      this.bubbleController = null;
    }
    const currentPill = this.pillEl;
    this.pillEl = null;
    removePillWithFade(currentPill, onRemoved);
  }
}
