import {
  WS_PAYLOAD_LIMIT_BYTES,
  WS_MAX_SOCKETS_PER_USER,
  assertPayloadSize,
  enforceSocketCap,
  estimatePayloadBytes,
} from './ws-memory-guard';

function makeSocket(id: string): any {
  return {
    id,
    emittedEvents: [] as Array<{ event: string; data: unknown }>,
    disconnected: false,
    emit(event: string, data: unknown) {
      this.emittedEvents.push({ event, data });
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

describe('ws-memory-guard', () => {
  describe('WS_PAYLOAD_LIMIT_BYTES', () => {
    it('is a positive integer', () => {
      expect(WS_PAYLOAD_LIMIT_BYTES).toBeGreaterThan(0);
      expect(Number.isInteger(WS_PAYLOAD_LIMIT_BYTES)).toBe(true);
    });
  });

  describe('WS_MAX_SOCKETS_PER_USER', () => {
    it('is a positive integer', () => {
      expect(WS_MAX_SOCKETS_PER_USER).toBeGreaterThan(0);
      expect(Number.isInteger(WS_MAX_SOCKETS_PER_USER)).toBe(true);
    });
  });

  describe('estimatePayloadBytes()', () => {
    it('returns 0 for null / undefined', () => {
      expect(estimatePayloadBytes(null)).toBe(0);
      expect(estimatePayloadBytes(undefined)).toBe(0);
    });

    it('returns byte length for a string', () => {
      const str = 'hello';
      expect(estimatePayloadBytes(str)).toBe(Buffer.byteLength(str, 'utf8'));
    });

    it('returns buffer length for a Buffer', () => {
      const buf = Buffer.alloc(32);
      expect(estimatePayloadBytes(buf)).toBe(32);
    });

    it('returns JSON byte length for an object', () => {
      const obj = { a: 1, b: 'test' };
      const expected = Buffer.byteLength(JSON.stringify(obj), 'utf8');
      expect(estimatePayloadBytes(obj)).toBe(expected);
    });

    it('returns a value > limit for a non-serialisable value', () => {
      const circular: any = {};
      circular.self = circular;
      expect(estimatePayloadBytes(circular)).toBeGreaterThan(WS_PAYLOAD_LIMIT_BYTES);
    });
  });

  describe('assertPayloadSize()', () => {
    it('returns true for a payload within the limit', () => {
      const client = makeSocket('s1');
      const smallPayload = { id: '1' };
      expect(assertPayloadSize(client, 'mark-read', smallPayload)).toBe(true);
      expect(client.emittedEvents).toHaveLength(0);
    });

    it('returns false and emits ws:error for an oversized payload', () => {
      const client = makeSocket('s2');
      const oversized = 'x'.repeat(WS_PAYLOAD_LIMIT_BYTES + 1);
      const result = assertPayloadSize(client, 'mark-read', oversized);
      expect(result).toBe(false);
      expect(client.emittedEvents).toHaveLength(1);
      expect(client.emittedEvents[0].event).toBe('ws:error');
      const data = client.emittedEvents[0].data as any;
      expect(data.code).toBe('WS_PAYLOAD_TOO_LARGE');
      expect(data.limitBytes).toBe(WS_PAYLOAD_LIMIT_BYTES);
    });

    it('emits the event name in the error response', () => {
      const client = makeSocket('s3');
      const oversized = 'x'.repeat(WS_PAYLOAD_LIMIT_BYTES + 1);
      assertPayloadSize(client, 'custom-event', oversized);
      const data = client.emittedEvents[0].data as any;
      expect(data.event).toBe('custom-event');
    });

    it('handles null payload gracefully', () => {
      const client = makeSocket('s4');
      expect(assertPayloadSize(client, 'event', null)).toBe(true);
    });
  });

  describe('enforceSocketCap()', () => {
    function buildUserSockets(socketIds: string[]): Map<string, Set<string>> {
      const map = new Map<string, Set<string>>();
      map.set('user1', new Set(socketIds));
      return map;
    }

    it('allows connections below the cap without eviction', () => {
      const sockets = buildUserSockets(['s1', 's2']);
      const newClient = makeSocket('s3');
      sockets.get('user1')!.add('s3');
      enforceSocketCap('user1', 's3', sockets, null);
      // No eviction — size is still 3 < WS_MAX_SOCKETS_PER_USER (5)
      expect(sockets.get('user1')!.size).toBe(3);
    });

    it('evicts the oldest socket when cap is reached', () => {
      const existingIds = Array.from(
        { length: WS_MAX_SOCKETS_PER_USER },
        (_, i) => `s${i}`,
      );
      const sockets = buildUserSockets(existingIds);
      sockets.get('user1')!.add('s-new');
      // Mock server that can look up sockets by ID.
      const evicted: string[] = [];
      const serverRef = {
        sockets: {
          sockets: new Map(
            existingIds.map((id) => [
              id,
              {
                emit: () => {},
                disconnect: () => { evicted.push(id); },
              },
            ]),
          ),
        },
      };

      enforceSocketCap('user1', 's-new', sockets, serverRef as any);
      // Total sockets should be exactly WS_MAX_SOCKETS_PER_USER.
      expect(sockets.get('user1')!.size).toBe(WS_MAX_SOCKETS_PER_USER);
      // The oldest socket was evicted.
      expect(evicted).toHaveLength(1);
      expect(sockets.get('user1')!.has(existingIds[0])).toBe(false);
    });

    it('does nothing when userId is not in the map', () => {
      const sockets = new Map<string, Set<string>>();
      // Should not throw.
      expect(() => enforceSocketCap('unknown', 's1', sockets, null)).not.toThrow();
    });

    it('handles a null serverRef without throwing during eviction', () => {
      const existingIds = Array.from(
        { length: WS_MAX_SOCKETS_PER_USER },
        (_, i) => `s${i}`,
      );
      const sockets = buildUserSockets(existingIds);
      sockets.get('user1')!.add('s-new');
      expect(() =>
        enforceSocketCap('user1', 's-new', sockets, null),
      ).not.toThrow();
    });
  });
});
