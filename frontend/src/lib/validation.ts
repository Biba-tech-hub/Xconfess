/**
 * Unified form validation and error mapping layer.
 *
 * Provides a small, dependency-free toolkit that standardizes:
 *  - schema validation (field-level validators)
 *  - server error mapping (field errors + non-field/form errors)
 *  - touched state tracking
 *  - submission lifecycle (validate -> submit -> map errors)
 *
 * It is intentionally framework-agnostic so it can be reused across auth,
 * settings, reports, and exports forms without pulling in a form library.
 */

export type FieldErrors<Values> = Partial<Record<keyof Values, string>>;

export type Validator<Values> = (
  value: Values[keyof Values],
  values: Values,
) => string | undefined | null;

export type Schema<Values> = {
  [K in keyof Values]?: Validator<Values> | Validator<Values>[];
};

/**
 * A server error payload. Accepts either a flat field->message map or a
 * `{ fieldErrors, formErrors }` shape commonly returned by APIs.
 */
export type ServerErrorPayload<Values> =
  | FieldErrors<Values>
  | {
      fieldErrors?: FieldErrors<Values>;
      formErrors?: string[];
      message?: string;
    };

export type SubmitResult<Values, Result> =
  | { ok: true; result: Result; values: Values }
  | { ok: false; errors: FieldErrors<Values>; formErrors: string[] };

/**
 * Run a schema against a set of values and collect field errors.
 * Returns an empty object when the values are valid.
 */
export function validate<Values extends Record<string, unknown>>(
  values: Values,
  schema: Schema<Values>,
): FieldErrors<Values> {
  const errors: FieldErrors<Values> = {};

  for (const key of Object.keys(schema) as (keyof Values)[]) {
    const entry = schema[key];
    if (!entry) continue;

    const validators = Array.isArray(entry) ? entry : [entry];
    for (const validator of validators) {
      const message = validator(values[key], values);
      if (message) {
        errors[key] = message;
        break;
      }
    }
  }

  return errors;
}

/**
 * Normalize an arbitrary server error payload into field errors and
 * form-level errors. Unknown shapes fall back to a generic form error.
 */
export function mapServerErrors<Values extends Record<string, unknown>>(
  payload: ServerErrorPayload<Values> | null | undefined,
  fallbackMessage = "Something went wrong. Please try again.",
): { errors: FieldErrors<Values>; formErrors: string[] } {
  if (!payload) {
    return { errors: {}, formErrors: [fallbackMessage] };
  }

  if (typeof payload === "object" && ("fieldErrors" in payload || "formErrors" in payload || "message" in payload)) {
    const shaped = payload as {
      fieldErrors?: FieldErrors<Values>;
      formErrors?: string[];
      message?: string;
    };
    const formErrors = shaped.formErrors?.length
      ? shaped.formErrors
      : shaped.message
        ? [shaped.message]
        : [];
    return { errors: shaped.fieldErrors ?? {}, formErrors };
  }

  // Flat field->message map.
  const errors = payload as FieldErrors<Values>;
  return { errors, formErrors: [] };
}

/**
 * Merge client-side and server-side field errors. Server errors win for a
 * given field so the most authoritative message is shown.
 */
export function mergeErrors<Values extends Record<string, unknown>>(
  clientErrors: FieldErrors<Values>,
  serverErrors: FieldErrors<Values>,
): FieldErrors<Values> {
  return { ...clientErrors, ...serverErrors };
}

/**
 * Tracks which fields have been touched so errors are only surfaced after
 * the user has interacted with (or attempted to submit) a field.
 */
export function createTouchedState<Values extends Record<string, unknown>>() {
  const touched: Partial<Record<keyof Values, boolean>> = {};

  return {
    touched,
    markTouched(key: keyof Values) {
      touched[key] = true;
    },
    markAllTouched(keys: (keyof Values)[]) {
      for (const key of keys) touched[key] = true;
    },
    isTouched(key: keyof Values) {
      return touched[key] === true;
    },
    reset() {
      for (const key of Object.keys(touched) as (keyof Values)[]) {
        delete touched[key];
      }
    },
  };
}

/**
 * Return only the errors that should be visible given touched state.
 * When `showAll` is true (e.g. after a submit attempt) every error shows.
 */
export function visibleErrors<Values extends Record<string, unknown>>(
  errors: FieldErrors<Values>,
  isTouched: (key: keyof Values) => boolean,
  showAll = false,
): FieldErrors<Values> {
  const visible: FieldErrors<Values> = {};
  for (const key of Object.keys(errors) as (keyof Values)[]) {
    if (showAll || isTouched(key)) {
      visible[key] = errors[key];
    }
  }
  return visible;
}

/**
 * Drive the full submission lifecycle:
 *  1. validate client-side; if invalid, do NOT call the network.
 *  2. call the submit handler.
 *  3. map thrown/returned server errors back onto fields.
 */
export async function submitForm<Values extends Record<string, unknown>, Result>(options: {
  values: Values;
  schema: Schema<Values>;
  submit: (values: Values) => Promise<Result>;
  mapError?: (error: unknown) => ServerErrorPayload<Values> | null | undefined;
}): Promise<SubmitResult<Values, Result>> {
  const { values, schema, submit, mapError } = options;

  const clientErrors = validate(values, schema);
  if (Object.keys(clientErrors).length > 0) {
    return { ok: false, errors: clientErrors, formErrors: [] };
  }

  try {
    const result = await submit(values);
    return { ok: true, result, values };
  } catch (error) {
    const payload = mapError ? mapError(error) : (error as ServerErrorPayload<Values>);
    const { errors, formErrors } = mapServerErrors<Values>(payload);
    return { ok: false, errors, formErrors };
  }
}

/**
 * Common reusable validators.
 */
export const rules = {
  required:
    (message = "This field is required."): Validator<Record<string, unknown>> =>
    (value) => {
      if (value === undefined || value === null) return message;
      if (typeof value === "string" && value.trim() === "") return message;
      if (Array.isArray(value) && value.length === 0) return message;
      return undefined;
    },
  email:
    (message = "Enter a valid email address."): Validator<Record<string, unknown>> =>
    (value) => {
      if (typeof value !== "string" || value.trim() === "") return undefined;
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? undefined : message;
    },
  minLength:
    (length: number, message?: string): Validator<Record<string, unknown>> =>
    (value) => {
      if (typeof value !== "string") return undefined;
      return value.length >= length
        ? undefined
        : message ?? `Must be at least ${length} characters.`;
    },
};
