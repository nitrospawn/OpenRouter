/**
 * SmartScrollController
 * 
 * Manages autoscroll behavior for streaming chat containers.
 * Prevents "scroll fighting" by detecting when the user has intentionally scrolled up
 * to inspect previous text or history, pausing autoscroll until the user scrolls back
 * to the bottom or clicks the jump-to-bottom button.
 */
export class SmartScrollController {
  private el: HTMLElement;
  private userScrolledUp = false;
  private threshold: number;
  private scrollBtn?: HTMLElement | null;

  constructor(el: HTMLElement, scrollBtn?: HTMLElement | null, threshold = 60) {
    this.el = el;
    this.scrollBtn = scrollBtn;
    this.threshold = threshold;

    // Listen to scroll events to detect when the user moves away from or returns to the bottom
    this.el.addEventListener(
      'scroll',
      () => {
        this.checkScrollPosition();
      },
      { passive: true }
    );

    // Fast-track user intent on mouse wheel up
    this.el.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        if (e.deltaY < 0) {
          this.userScrolledUp = true;
          if (this.scrollBtn) {
            this.scrollBtn.classList.remove('hidden');
          }
        }
      },
      { passive: true }
    );

    // Fast-track touch gestures
    this.el.addEventListener(
      'touchmove',
      () => {
        this.checkScrollPosition();
      },
      { passive: true }
    );

    if (this.scrollBtn) {
      this.scrollBtn.addEventListener('click', () => {
        this.scrollToBottom(true);
      });
    }
  }

  public checkScrollPosition(): void {
    const distFromBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
    if (distFromBottom > this.threshold) {
      this.userScrolledUp = true;
      if (this.scrollBtn) {
        this.scrollBtn.classList.remove('hidden');
      }
    } else {
      this.userScrolledUp = false;
      if (this.scrollBtn) {
        this.scrollBtn.classList.add('hidden');
      }
    }
  }

  /**
   * Only scrolls to the bottom if the user has NOT intentionally scrolled up.
   * Called on incoming stream chunks / render updates.
   */
  public scrollToBottomIfAtBottom(): void {
    if (!this.userScrolledUp) {
      this.el.scrollTop = this.el.scrollHeight;
    }
  }

  /**
   * Force scrolls to the bottom, resetting userScrolledUp flag.
   * Called when the user sends a new message or clicks the jump-to-bottom button.
   */
  public scrollToBottom(force = true): void {
    if (force) {
      this.userScrolledUp = false;
      if (this.scrollBtn) {
        this.scrollBtn.classList.add('hidden');
      }
      this.el.scrollTop = this.el.scrollHeight;
    } else {
      this.scrollToBottomIfAtBottom();
    }
  }

  public isUserScrolledUp(): boolean {
    return this.userScrolledUp;
  }

  public setUserScrolledUp(scrolledUp: boolean): void {
    this.userScrolledUp = scrolledUp;
    if (this.scrollBtn) {
      if (scrolledUp) {
        this.scrollBtn.classList.remove('hidden');
      } else {
        this.scrollBtn.classList.add('hidden');
      }
    }
  }
}
