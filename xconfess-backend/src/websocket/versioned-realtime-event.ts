/**
 * Realtime Event Version Negotiation & Envelope Utilities
 *
 * Ensures backward compatibility across overlapping backend and frontend deployments.
 */

export const REALTIME_EVENT_CURRENT_VERSION = 2;
export const REALTIME_EVENT_MIN_SUPPORTED_VERSION = 1;
export const REALTIME_DEFAULT_DEPRECATION_WINDOW_DAYS = 30;

export interface VersionedRealtimeEnvelope<T = any> {
  eventVersion: number;
  minSupportedVersion: number;
  maxSupportedVersion: number;
  deprecatedVersions?: number[];
  deprecationWindowDays?: number;
  data: T;
  timestamp: string;
}

export interface VersionNegotiationResult {
  acceptedVersion: number;
  isDeprecated: boolean;
  minSupportedVersion: number;
  maxSupportedVersion: number;
  supported: boolean;
}

export function negotiateClientVersion(
  requestedVersion?: number,
): VersionNegotiationResult {
  const version = requestedVersion ?? 1;

  if (version < REALTIME_EVENT_MIN_SUPPORTED_VERSION) {
    return {
      acceptedVersion: REALTIME_EVENT_MIN_SUPPORTED_VERSION,
      isDeprecated: true,
      minSupportedVersion: REALTIME_EVENT_MIN_SUPPORTED_VERSION,
      maxSupportedVersion: REALTIME_EVENT_CURRENT_VERSION,
      supported: false,
    };
  }

  const accepted = Math.min(version, REALTIME_EVENT_CURRENT_VERSION);
  return {
    acceptedVersion: accepted,
    isDeprecated: accepted < REALTIME_EVENT_CURRENT_VERSION,
    minSupportedVersion: REALTIME_EVENT_MIN_SUPPORTED_VERSION,
    maxSupportedVersion: REALTIME_EVENT_CURRENT_VERSION,
    supported: true,
  };
}

export function wrapVersionedRealtimeEvent<T>(
  data: T,
  version = REALTIME_EVENT_CURRENT_VERSION,
): VersionedRealtimeEnvelope<T> {
  return {
    eventVersion: version,
    minSupportedVersion: REALTIME_EVENT_MIN_SUPPORTED_VERSION,
    maxSupportedVersion: REALTIME_EVENT_CURRENT_VERSION,
    deprecatedVersions: [1],
    deprecationWindowDays: REALTIME_DEFAULT_DEPRECATION_WINDOW_DAYS,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Transforms an event payload to match the negotiated client version.
 * Old clients receive V1 shapes; V2+ clients receive the enriched envelope.
 */
export function formatPayloadForClient<T extends Record<string, any>>(
  clientVersion: number,
  payload: T,
): any {
  if (clientVersion <= 1) {
    // Legacy V1 client expects raw unboxed object
    return {
      ...payload,
      _v: 1,
    };
  }

  // Version 2+ client receives standard versioned envelope
  return wrapVersionedRealtimeEvent(payload, clientVersion);
}

/**
 * Safe consumer helper: unknown event types or unparseable versions
 * are safely ignored without crashing client event loops.
 */
export function safelyConsumeRealtimeEvent(
  rawEvent: any,
  supportedEventTypes: string[],
): { safe: boolean; eventType?: string; payload?: any; reason?: string } {
  if (!rawEvent || typeof rawEvent !== 'object') {
    return { safe: false, reason: 'Invalid non-object payload' };
  }

  const type = rawEvent.type || rawEvent.eventType;
  if (type && !supportedEventTypes.includes(type)) {
    return {
      safe: true,
      reason: `Unknown event type '${type}' safely ignored (forward compatibility)`,
    };
  }

  return {
    safe: true,
    eventType: type,
    payload: rawEvent.data || rawEvent,
  };
}
