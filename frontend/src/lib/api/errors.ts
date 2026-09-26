export interface ApiErrorPayload {
  message?: string;
  errors?: Record<string, string | string[]>;
  fieldErrors?: Record<string, string | string[]>;
  [key: string]: unknown;
}

export interface NormalizedApiError {
  message: string;
  status?: number;
  fieldErrors: Record<string, string>;
  isNetworkError: boolean;
}

function firstMessage(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0]) : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return undefined;
}

/**
 * Normalize any thrown value (fetch error, ApiError, plain object) into a
 * consistent shape so forms can map server field errors to the right input.
 */
export function normalizeApiError(error: unknown): NormalizedApiError {
  if (error instanceof TypeError) {
    return {
      message: error.message || 'Network request failed',
      fieldErrors: {},
      isNetworkError: true,
    };
  }

  if (error && typeof error === 'object') {
    const candidate = error as ApiErrorPayload & { status?: number };
    const rawFields = candidate.fieldErrors ?? candidate.errors ?? {};
    const fieldErrors: Record<string, string> = {};

    for (const [field, value] of Object.entries(rawFields)) {
      const message = firstMessage(value);
      if (message) {
        fieldErrors[field] = message;
      }
    }

    return {
      message: candidate.message || 'Something went wrong',
      status: typeof candidate.status === 'number' ? candidate.status : undefined,
      fieldErrors,
      isNetworkError: false,
    };
  }

  return {
    message: typeof error === 'string' && error ? error : 'Something went wrong',
    fieldErrors: {},
    isNetworkError: false,
  };
}

/**
 * Map normalized server field errors onto a form's known field names.
 * Unknown fields are ignored so stray server keys never leak into the UI.
 */
export function mapFieldErrors<TField extends string>(
  error: unknown,
  knownFields: readonly TField[],
): Partial<Record<TField, string>> {
  const { fieldErrors } = normalizeApiError(error);
  const mapped: Partial<Record<TField, string>> = {};

  for (const field of knownFields) {
    const message = fieldErrors[field];
    if (message) {
      mapped[field] = message;
    }
  }

  return mapped;
}
