import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface VirtualizerOptions {
  /** Total number of items in the list. */
  count: number;
  /** Estimated height (px) for items that have not been measured yet. */
  estimateSize: (index: number) => number;
  /** Extra items rendered above and below the visible window. */
  overscan?: number;
  /** Optional scroll container. Defaults to the window. */
  getScrollElement?: () => HTMLElement | Window | null;
  /** Optional key extractor used to keep measurements stable across reorders. */
  getItemKey?: (index: number) => string | number;
}

export interface VirtualItem {
  index: number;
  key: string | number;
  start: number;
  size: number;
  end: number;
}

export interface Virtualizer {
  virtualItems: VirtualItem[];
  totalSize: number;
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' }) => void;
  measureElement: (element: HTMLElement | null, index: number) => void;
  getVirtualItemForIndex: (index: number) => VirtualItem | undefined;
}

const DEFAULT_OVERSCAN = 4;

function getViewportHeight(scrollElement: HTMLElement | Window | null): number {
  if (!scrollElement) return typeof window === 'undefined' ? 0 : window.innerHeight;
  if (scrollElement instanceof Window) return scrollElement.innerHeight;
  return scrollElement.clientHeight;
}

function getScrollOffset(scrollElement: HTMLElement | Window | null): number {
  if (!scrollElement) return typeof window === 'undefined' ? 0 : window.scrollY;
  if (scrollElement instanceof Window) return scrollElement.scrollY;
  return scrollElement.scrollTop;
}

/**
 * Minimal windowing hook for large feeds.
 *
 * Renders only the items intersecting the viewport (plus overscan), supports
 * variable item heights via measurement, and exposes helpers for keyboard
 * navigation and deep-link scroll restoration.
 */
export function useVirtualizer(options: VirtualizerOptions): Virtualizer {
  const { count, estimateSize, overscan = DEFAULT_OVERSCAN, getScrollElement, getItemKey } = options;

  const scrollElementRef = useRef<HTMLElement | Window | null>(null);
  const measurementsRef = useRef<Map<string | number, number>>(new Map());
  const [scrollOffset, setScrollOffset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [, forceUpdate] = useState(0);

  const resolveKey = useCallback(
    (index: number): string | number => (getItemKey ? getItemKey(index) : index),
    [getItemKey],
  );

  const getSize = useCallback(
    (index: number): number => {
      const measured = measurementsRef.current.get(resolveKey(index));
      return measured ?? estimateSize(index);
    },
    [estimateSize, resolveKey],
  );

  // Prefix sums of item offsets, recomputed when count or measurements change.
  const offsets = useMemo(() => {
    const result = new Array<number>(count + 1);
    result[0] = 0;
    for (let i = 0; i < count; i += 1) {
      result[i + 1] = result[i] + getSize(i);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, getSize, measurementsRef.current.size]);

  const totalSize = offsets[count] ?? 0;

  // Track scroll position and viewport size.
  useEffect(() => {
    const scrollElement = getScrollElement ? getScrollElement() : window;
    scrollElementRef.current = scrollElement;
    if (!scrollElement) return undefined;

    const handleScroll = () => setScrollOffset(getScrollOffset(scrollElement));
    const handleResize = () => setViewportHeight(getViewportHeight(scrollElement));

    handleScroll();
    handleResize();

    scrollElement.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize);
    return () => {
      scrollElement.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, [getScrollElement]);

  const virtualItems = useMemo(() => {
    if (count === 0) return [];

    const startOffset = scrollOffset;
    const endOffset = scrollOffset + viewportHeight;

    // Binary search for the first item whose end is past the viewport start.
    let low = 0;
    let high = count - 1;
    let firstVisible = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (offsets[mid + 1] <= startOffset) {
        low = mid + 1;
      } else {
        firstVisible = mid;
        high = mid - 1;
      }
    }

    const startIndex = Math.max(0, firstVisible - overscan);
    let endIndex = firstVisible;
    while (endIndex < count && offsets[endIndex] < endOffset) {
      endIndex += 1;
    }
    endIndex = Math.min(count, endIndex + overscan);

    const items: VirtualItem[] = [];
    for (let i = startIndex; i < endIndex; i += 1) {
      const start = offsets[i];
      const size = getSize(i);
      items.push({ index: i, key: resolveKey(i), start, size, end: start + size });
    }
    return items;
  }, [count, offsets, overscan, scrollOffset, viewportHeight, getSize, resolveKey]);

  const scrollToIndex = useCallback(
    (index: number, scrollOptions?: { align?: 'start' | 'center' | 'end' }) => {
      if (index < 0 || index >= count) return;
      const scrollElement = scrollElementRef.current;
      const align = scrollOptions?.align ?? 'start';
      const itemStart = offsets[index];
      const itemSize = getSize(index);
      let target = itemStart;
      if (align === 'center') {
        target = itemStart - (viewportHeight - itemSize) / 2;
      } else if (align === 'end') {
        target = itemStart - viewportHeight + itemSize;
      }
      target = Math.max(0, Math.min(target, totalSize - viewportHeight));

      if (!scrollElement) {
        window.scrollTo({ top: target });
      } else if (scrollElement instanceof Window) {
        scrollElement.scrollTo({ top: target });
      } else {
        scrollElement.scrollTop = target;
      }
      setScrollOffset(target);
    },
    [count, offsets, getSize, viewportHeight, totalSize],
  );

  const measureElement = useCallback(
    (element: HTMLElement | null, index: number) => {
      if (!element) return;
      const key = resolveKey(index);
      const nextSize = element.getBoundingClientRect().height;
      const previousSize = measurementsRef.current.get(key);
      if (previousSize === undefined || Math.abs(previousSize - nextSize) > 0.5) {
        measurementsRef.current.set(key, nextSize);
        forceUpdate((value) => value + 1);
      }
    },
    [resolveKey],
  );

  const getVirtualItemForIndex = useCallback(
    (index: number): VirtualItem | undefined => virtualItems.find((item) => item.index === index),
    [virtualItems],
  );

  return { virtualItems, totalSize, scrollToIndex, measureElement, getVirtualItemForIndex };
}

export default useVirtualizer;
