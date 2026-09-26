import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter((node) => {
    if (node.hasAttribute('disabled')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.hidden) return false;
    // Skip elements that are not rendered (display:none / visibility:hidden).
    return node.offsetParent !== null || node === document.activeElement;
  });
}

/**
 * Stack of currently active focus traps. The most recently mounted trap owns
 * focus so nested dialogs (e.g. a confirm dialog opened from a drawer) behave
 * correctly and closing the inner dialog returns focus to the outer one.
 */
const trapStack: HTMLElement[] = [];

function isTopTrap(container: HTMLElement): boolean {
  return trapStack[trapStack.length - 1] === container;
}

export interface UseFocusTrapOptions {
  /** Whether the trap is currently active. Defaults to true. */
  active?: boolean;
  /**
   * Element (or selector) that should receive initial focus when the dialog
   * opens. Falls back to the first focusable element inside the container.
   */
  initialFocus?: HTMLElement | string | null;
  /**
   * Element that should receive focus when the dialog closes. Defaults to the
   * element that was focused when the trap activated (the origin).
   */
  restoreFocus?: HTMLElement | null;
  /** Called when the user presses Escape while this trap owns focus. */
  onEscape?: () => void;
}

/**
 * Traps keyboard focus within a dialog/drawer container.
 *
 * - Tab / Shift+Tab cycle within the container and never escape it.
 * - Initial focus is deterministic (explicit target, else first focusable).
 * - On close, focus is restored to the originating element.
 * - Nested traps are supported via a stack; only the top trap handles keys.
 */
export function useFocusTrap<T extends HTMLElement>(
  options: UseFocusTrapOptions = {},
) {
  const { active = true, initialFocus, restoreFocus, onEscape } = options;
  const containerRef = useRef<T | null>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // Capture the origin before we move focus so we can restore it later.
    originRef.current =
      restoreFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);

    trapStack.push(container);

    const resolveInitial = (): HTMLElement | null => {
      if (initialFocus instanceof HTMLElement) return initialFocus;
      if (typeof initialFocus === 'string') {
        return container.querySelector<HTMLElement>(initialFocus);
      }
      return null;
    };

    const focusInitial = () => {
      const target = resolveInitial() ?? getFocusable(container)[0] ?? container;
      if (target === container && !container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: true });
    };

    // Defer so the dialog is mounted/visible before we move focus.
    const raf = requestAnimationFrame(focusInitial);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopTrap(container)) return;

      if (event.key === 'Escape') {
        if (onEscapeRef.current) {
          event.stopPropagation();
          onEscapeRef.current();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (current === first || !container.contains(current)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (current === last || !container.contains(current)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    // Capture phase so we win over handlers that stop propagation.
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);

      const index = trapStack.lastIndexOf(container);
      if (index !== -1) trapStack.splice(index, 1);

      // Restore focus to the origin, but only if focus is not already inside
      // another (outer) trap that has since taken over.
      const origin = originRef.current;
      const activeEl = document.activeElement;
      const insideOtherTrap = trapStack.some((el) => el.contains(activeEl));
      if (origin && origin.isConnected && !insideOtherTrap) {
        origin.focus({ preventScroll: true });
      }
    };
  }, [active, initialFocus, restoreFocus]);

  return containerRef;
}

export default useFocusTrap;
