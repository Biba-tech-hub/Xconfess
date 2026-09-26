/**
 * Deep-linkable view state helpers.
 *
 * Encodes validated filter + sort state into URL query strings and parses
 * them back with backward-compatible, privacy-safe fallbacks. Unknown or
 * malformed values never throw; they resolve to the provided defaults.
 */

export type UrlStateValue = string | number | boolean | null | undefined;

export type UrlStateSchema<T> = {
  [K in keyof T]: {
    /** Query-string key. Defaults to the field name. */
    key?: string;
    /** Legacy keys accepted when parsing (backward compatibility). */
    aliases?: string[];
    /** Coerce a raw string into the typed value, or return undefined to reject. */
    parse?: (raw: string) => T[K] | undefined;
    /** Serialize a typed value into a string, or return undefined to omit. */
    serialize?: (value: T[K]) => string | undefined;
    /** When true, the value is never written to the URL (privacy-safe). */
    private?: boolean;
  };
};

const DEFAULT_PARSE = (raw: string): string => raw;

function defaultSerialize(value: UrlStateValue): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a query string (with or without a leading "?") into a typed state
 * object. Missing, unknown, or malformed params fall back to `defaults`.
 */
export function parseUrlState<T extends Record<string, UrlStateValue>>(
  search: string,
  schema: UrlStateSchema<T>,
  defaults: T,
): T {
  const params = new URLSearchParams(
    typeof search === 'string' ? search.replace(/^\?/, '') : '',
  );
  const result: Record<string, UrlStateValue> = { ...defaults };

  for (const field of Object.keys(schema) as Array<keyof T>) {
    const config = schema[field];
    const keys = [config.key ?? String(field), ...(config.aliases ?? [])];

    let raw: string | null = null;
    for (const key of keys) {
      const candidate = params.get(key);
      if (candidate !== null) {
        raw = candidate;
        break;
      }
    }

    if (raw === null) continue;

    const parse = config.parse ?? (DEFAULT_PARSE as (value: string) => T[keyof T]);
    try {
      const parsed = parse(raw);
      if (parsed !== undefined) {
        result[field as string] = parsed;
      }
    } catch {
      // Malformed input: keep the default rather than throwing.
    }
  }

  return result as T;
}

/**
 * Serialize typed state into a query string. Private fields are omitted so
 * sensitive values never leak into shareable URLs. Empty/default values are
 * dropped to keep links clean.
 */
export function serializeUrlState<T extends Record<string, UrlStateValue>>(
  state: T,
  schema: UrlStateSchema<T>,
  defaults?: Partial<T>,
): string {
  const params = new URLSearchParams();

  for (const field of Object.keys(schema) as Array<keyof T>) {
    const config = schema[field];
    if (config.private) continue;

    const value = state[field];
    if (value === null || value === undefined) continue;
    if (defaults && Object.is(value, defaults[field])) continue;

    const serialize = config.serialize ?? defaultSerialize;
    const encoded = serialize(value);
    if (encoded === undefined || encoded === '') continue;

    params.set(config.key ?? String(field), encoded);
  }

  return params.toString();
}

/**
 * Merge the current state into a URL, preserving unrelated params and
 * returning a full href suitable for history.pushState / <Link>.
 */
export function buildUrlStateHref<T extends Record<string, UrlStateValue>>(
  baseUrl: string,
  state: T,
  schema: UrlStateSchema<T>,
  defaults?: Partial<T>,
): string {
  const [path, existing = ''] = baseUrl.split('?');
  const params = new URLSearchParams(existing);

  for (const field of Object.keys(schema) as Array<keyof T>) {
    const config = schema[field];
    const key = config.key ?? String(field);

    if (config.private) {
      params.delete(key);
      continue;
    }

    const value = state[field];
    if (value === null || value === undefined || (defaults && Object.is(value, defaults[field]))) {
      params.delete(key);
      continue;
    }

    const serialize = config.serialize ?? defaultSerialize;
    const encoded = serialize(value);
    if (encoded === undefined || encoded === '') {
      params.delete(key);
    } else {
      params.set(key, encoded);
    }
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Convenience parsers for common filter/sort primitives. Each returns
 * undefined for invalid input so callers fall back to defaults safely.
 */
export const urlStateParsers = {
  string: (raw: string): string | undefined => (raw === '' ? undefined : raw),
  int: (raw: string): number | undefined => {
    if (!/^-?\d+$/.test(raw)) return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  },
  bool: (raw: string): boolean | undefined => {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return undefined;
  },
  oneOf:
    <V extends string>(allowed: readonly V[]) =>
    (raw: string): V | undefined =>
      (allowed as readonly string[]).includes(raw) ? (raw as V) : undefined,
  list:
    (allowed?: readonly string[]) =>
    (raw: string): string[] | undefined => {
      const items = raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      if (items.length === 0) return undefined;
      if (allowed) {
        const filtered = items.filter((item) => allowed.includes(item));
        return filtered.length > 0 ? filtered : undefined;
      }
      return items;
    },
};

/**
 * Serialize a list value back into a comma-separated string.
 */
export function serializeList(values: readonly string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.join(',');
}

/**
 * Guard against non-object state (e.g. corrupted history entries) so callers
 * can safely read a field without throwing.
 */
export function readUrlStateField<T>(
  state: unknown,
  field: string,
  fallback: T,
): T {
  if (!isPlainObject(state)) return fallback;
  const value = state[field];
  return (value as T) ?? fallback;
}
