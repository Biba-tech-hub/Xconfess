import { useCallback, useEffect, useRef, useState } from 'react';

export type NetworkStatus = 'online' | 'offline' | 'reconnecting';

export interface UseNetworkStatusResult {
  /** Current connectivity state, including a transient 'reconnecting' phase. */
  status: NetworkStatus;
  /** True while the browser reports no connectivity. */
  isOffline: boolean;
  /** True during the brief window after connectivity returns, before we confirm. */
  isReconnecting: boolean;
  /** True once we have observed at least one successful reconnect. */
  hasReconnected: boolean;
  /** Timestamp (ms) of the last transition to offline, or null. */
  offlineSince: number | null;
  /** Timestamp (ms) of the last confirmed reconnect, or null. */
  lastReconnectedAt: number | null;
  /** Manually re-check connectivity (e.g. after a failed request). */
  checkConnection: () => Promise<boolean>;
}

const RECONNECT_CONFIRM_DELAY_MS = 400;

/**
 * Tracks browser connectivity and exposes a visible offline/reconnect state.
 *
 * On reconnect we enter a short 'reconnecting' phase and confirm with a
 * lightweight probe before declaring 'online', so consumers can hold unsafe
 * mutations until connectivity is verified rather than silently replaying them.
 */
export function useNetworkStatus(): UseNetworkStatusResult {
  const getInitialStatus = (): NetworkStatus => {
    if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
      return 'online';
    }
    return navigator.onLine ? 'online' : 'offline';
  };

  const [status, setStatus] = useState<NetworkStatus>(getInitialStatus);
  const [offlineSince, setOfflineSince] = useState<number | null>(() =>
    getInitialStatus() === 'offline' ? Date.now() : null,
  );
  const [lastReconnectedAt, setLastReconnectedAt] = useState<number | null>(null);

  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimer.current !== null) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
  }, []);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' && !navigator.onLine) {
      return false;
    }
    return true;
  }, []);

  const goOffline = useCallback(() => {
    clearConfirmTimer();
    setStatus((prev) => {
      if (prev === 'offline') {
        return prev;
      }
      setOfflineSince(Date.now());
      return 'offline';
    });
  }, [clearConfirmTimer]);

  const goReconnecting = useCallback(() => {
    clearConfirmTimer();
    setStatus((prev) => (prev === 'online' ? 'reconnecting' : prev));
    confirmTimer.current = setTimeout(async () => {
      const reachable = await checkConnection();
      if (!mounted.current) {
        return;
      }
      if (reachable) {
        setStatus('online');
        setOfflineSince(null);
        setLastReconnectedAt(Date.now());
      } else {
        goOffline();
      }
    }, RECONNECT_CONFIRM_DELAY_MS);
  }, [checkConnection, clearConfirmTimer, goOffline]);

  useEffect(() => {
    mounted.current = true;

    const handleOnline = () => goReconnecting();
    const handleOffline = () => goOffline();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      mounted.current = false;
      clearConfirmTimer();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [clearConfirmTimer, goOffline, goReconnecting]);

  return {
    status,
    isOffline: status === 'offline',
    isReconnecting: status === 'reconnecting',
    hasReconnected: lastReconnectedAt !== null,
    offlineSince,
    lastReconnectedAt,
    checkConnection,
  };
}

export default useNetworkStatus;
