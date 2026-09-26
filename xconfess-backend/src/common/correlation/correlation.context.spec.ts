import { CorrelationContext } from './correlation.context';

describe('CorrelationContext', () => {
  it('returns undefined when no context is active', () => {
    // Run outside any CorrelationContext.run() call
    expect(CorrelationContext.getRequestId()).toBeUndefined();
  });

  it('returns the bound request ID inside run()', () => {
    const id = 'test-correlation-id';
    CorrelationContext.run(id, () => {
      expect(CorrelationContext.getRequestId()).toBe(id);
    });
  });

  it('restores context after run() exits', () => {
    const outerDone = jest.fn();

    CorrelationContext.run('outer', () => {
      CorrelationContext.run('inner', () => {
        expect(CorrelationContext.getRequestId()).toBe('inner');
      });
      // After inner run, outer context should be restored
      expect(CorrelationContext.getRequestId()).toBe('outer');
      outerDone();
    });

    expect(outerDone).toHaveBeenCalled();
  });

  it('propagates context through async/await chains', async () => {
    const id = 'async-trace-id';
    const result: string[] = [];

    await CorrelationContext.run(id, async () => {
      await Promise.resolve();
      result.push(CorrelationContext.getRequestId() ?? 'missing');
      await Promise.resolve();
      result.push(CorrelationContext.getRequestId() ?? 'missing');
    });

    expect(result).toEqual([id, id]);
  });

  it('getOrGenerateRequestId returns bound ID when inside run()', () => {
    const id = 'bound-id';
    CorrelationContext.run(id, () => {
      expect(CorrelationContext.getOrGenerateRequestId()).toBe(id);
    });
  });

  it('getOrGenerateRequestId generates a UUID when outside any context', () => {
    const id = CorrelationContext.getOrGenerateRequestId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('isolates concurrent contexts', async () => {
    const ids: string[] = [];

    await Promise.all([
      CorrelationContext.run('request-1', async () => {
        await new Promise((r) => setTimeout(r, 5));
        ids.push(CorrelationContext.getRequestId() ?? 'missing');
      }),
      CorrelationContext.run('request-2', async () => {
        await new Promise((r) => setTimeout(r, 1));
        ids.push(CorrelationContext.getRequestId() ?? 'missing');
      }),
    ]);

    expect(ids).toContain('request-1');
    expect(ids).toContain('request-2');
    // Crucially: each context should see only its own ID
    expect(ids).not.toContain('missing');
  });
});
