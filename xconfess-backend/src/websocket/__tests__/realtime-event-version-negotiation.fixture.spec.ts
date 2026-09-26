import {
  negotiateClientVersion,
  wrapVersionedRealtimeEvent,
  formatPayloadForClient,
  safelyConsumeRealtimeEvent,
  REALTIME_EVENT_CURRENT_VERSION,
  REALTIME_EVENT_MIN_SUPPORTED_VERSION,
} from '../versioned-realtime-event';

describe('Realtime Event Version Negotiation Fixtures', () => {
  const sampleNotification = {
    id: 'notif-1234',
    type: 'comment_notification',
    message: 'Someone commented on your confession',
    unreadCount: 3,
  };

  it('negotiates default V1 for legacy unversioned clients', () => {
    const result = negotiateClientVersion(undefined);
    expect(result.acceptedVersion).toBe(1);
    expect(result.supported).toBe(true);
    expect(result.isDeprecated).toBe(true);
  });

  it('negotiates current V2 for upgraded clients', () => {
    const result = negotiateClientVersion(2);
    expect(result.acceptedVersion).toBe(REALTIME_EVENT_CURRENT_VERSION);
    expect(result.supported).toBe(true);
    expect(result.isDeprecated).toBe(false);
  });

  it('caps future versions to current server max version', () => {
    const result = negotiateClientVersion(99);
    expect(result.acceptedVersion).toBe(REALTIME_EVENT_CURRENT_VERSION);
    expect(result.supported).toBe(true);
  });

  it('formats payload correctly for legacy V1 clients (raw shape)', () => {
    const v1Payload = formatPayloadForClient(1, sampleNotification);
    expect(v1Payload.id).toBe(sampleNotification.id);
    expect(v1Payload.message).toBe(sampleNotification.message);
    expect(v1Payload._v).toBe(1);
    expect(v1Payload.minSupportedVersion).toBeUndefined();
  });

  it('formats payload with full versioned envelope for V2 clients', () => {
    const v2Payload = formatPayloadForClient(2, sampleNotification);
    expect(v2Payload.eventVersion).toBe(2);
    expect(v2Payload.minSupportedVersion).toBe(REALTIME_EVENT_MIN_SUPPORTED_VERSION);
    expect(v2Payload.maxSupportedVersion).toBe(REALTIME_EVENT_CURRENT_VERSION);
    expect(v2Payload.data.id).toBe(sampleNotification.id);
    expect(v2Payload.deprecationWindowDays).toBe(30);
  });

  it('safely ignores unknown event types without throwing errors', () => {
    const unknownEvent = {
      type: 'future_super_feature_event',
      data: { foo: 'bar' },
    };
    const supportedTypes = ['notification', 'reaction', 'comment'];

    const result = safelyConsumeRealtimeEvent(unknownEvent, supportedTypes);
    expect(result.safe).toBe(true);
    expect(result.reason).toContain('safely ignored');
  });

  it('processes known event types correctly', () => {
    const knownEvent = {
      type: 'notification',
      data: sampleNotification,
    };
    const supportedTypes = ['notification', 'reaction'];

    const result = safelyConsumeRealtimeEvent(knownEvent, supportedTypes);
    expect(result.safe).toBe(true);
    expect(result.eventType).toBe('notification');
    expect(result.payload.id).toBe(sampleNotification.id);
  });
});
