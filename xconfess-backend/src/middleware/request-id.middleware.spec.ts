import { sanitizeIncomingRequestId } from './request-id.middleware';

describe('sanitizeIncomingRequestId', () => {
  it('accepts a valid UUID v4', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(sanitizeIncomingRequestId(id)).toBe(id);
  });

  it('accepts an alphanumeric slug', () => {
    const id = 'trace-abc123';
    expect(sanitizeIncomingRequestId(id)).toBe(id);
  });

  it('trims surrounding whitespace', () => {
    const id = '  trace-abc123  ';
    expect(sanitizeIncomingRequestId(id)).toBe('trace-abc123');
  });

  it('returns null for an empty string', () => {
    expect(sanitizeIncomingRequestId('')).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(sanitizeIncomingRequestId(undefined)).toBeNull();
  });

  it('returns null for a string exceeding 128 characters', () => {
    const long = 'a'.repeat(129);
    expect(sanitizeIncomingRequestId(long)).toBeNull();
  });

  it('returns null for IDs containing newlines', () => {
    expect(sanitizeIncomingRequestId('trace\ninjection')).toBeNull();
  });

  it('returns null for IDs containing spaces', () => {
    expect(sanitizeIncomingRequestId('trace injection')).toBeNull();
  });

  it('returns null for IDs containing SQL metacharacters', () => {
    expect(sanitizeIncomingRequestId("abc'; DROP TABLE--")).toBeNull();
  });

  it('returns null for IDs containing angle brackets', () => {
    expect(sanitizeIncomingRequestId('<script>xss</script>')).toBeNull();
  });

  it('uses the first element when given an array', () => {
    const id = 'first-element';
    expect(sanitizeIncomingRequestId([id, 'second'])).toBe(id);
  });

  it('accepts exactly 128 character slug', () => {
    // 128 chars: starts and ends with letter, middle is alphanumeric/hyphen/underscore
    const id = 'a' + 'b'.repeat(126) + 'c';
    expect(sanitizeIncomingRequestId(id)).toBe(id);
  });

  it('accepts a valid lowercase UUID format', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(sanitizeIncomingRequestId(id)).toBe(id);
  });
});
