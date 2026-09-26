import { useCallback, useMemo, useRef, useState } from 'react';

export type FieldErrors<Values> = Partial<Record<keyof Values, string>>;

export type Validator<Values> = (values: Values) => FieldErrors<Values> | null | undefined;

export type SubmitHandler<Values> = (values: Values) => Promise<unknown> | unknown;

export interface ServerErrorPayload<Values> {
  /** Field-keyed error map, e.g. { email: 'Already taken' } */
  fieldErrors?: FieldErrors<Values>;
  /** Optional top-level / non-field error message */
  message?: string;
  /** Optional error code for callers that branch on it */
  code?: string;
}

export interface UseFormOptions<Values> {
  initialValues: Values;
  /** Client-side schema validation. Return a field-keyed error map. */
  validate?: Validator<Values>;
  /** Submission lifecycle. Only invoked when client validation passes. */
  onSubmit: SubmitHandler<Values>;
  /** Map a thrown server error into field errors / a form-level message. */
  mapServerError?: (error: unknown) => ServerErrorPayload<Values>;
}

export interface UseFormResult<Values> {
  values: Values;
  errors: FieldErrors<Values>;
  /** Form-level (non-field) error, e.g. from the server. */
  formError: string | null;
  touched: Partial<Record<keyof Values, boolean>>;
  isSubmitting: boolean;
  isDirty: boolean;
  isValid: boolean;
  setFieldValue: <K extends keyof Values>(field: K, value: Values[K]) => void;
  setFieldTouched: <K extends keyof Values>(field: K, touched?: boolean) => void;
  setValues: (values: Values) => void;
  setErrors: (errors: FieldErrors<Values>) => void;
  /** Returns the field error only once the field has been touched. */
  getFieldError: <K extends keyof Values>(field: K) => string | undefined;
  handleChange: (event: { target: { name: string; value: unknown; type?: string; checked?: boolean } }) => void;
  handleBlur: (event: { target: { name: string } }) => void;
  handleSubmit: (event?: { preventDefault?: () => void }) => Promise<void>;
  reset: (nextValues?: Values) => void;
}

const EMPTY_ERRORS: FieldErrors<never> = {};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default server error mapper. Understands the common shapes:
 *   { fieldErrors: { email: '...' } }
 *   { errors: { email: '...' } }
 *   { errors: [{ field: 'email', message: '...' }] }
 *   { message: '...' }
 */
export function defaultMapServerError<Values>(error: unknown): ServerErrorPayload<Values> {
  if (!isPlainObject(error)) {
    return { message: typeof error === 'string' ? error : 'Something went wrong. Please try again.' };
  }

  const payload: ServerErrorPayload<Values> = {};
  const rawFieldErrors = error.fieldErrors ?? error.errors;

  if (isPlainObject(rawFieldErrors)) {
    const fieldErrors: FieldErrors<Values> = {};
    for (const [key, value] of Object.entries(rawFieldErrors)) {
      if (typeof value === 'string') {
        (fieldErrors as Record<string, string>)[key] = value;
      } else if (Array.isArray(value) && typeof value[0] === 'string') {
        (fieldErrors as Record<string, string>)[key] = value[0];
      }
    }
    payload.fieldErrors = fieldErrors;
  } else if (Array.isArray(rawFieldErrors)) {
    const fieldErrors: FieldErrors<Values> = {};
    for (const entry of rawFieldErrors) {
      if (isPlainObject(entry) && typeof entry.field === 'string' && typeof entry.message === 'string') {
        (fieldErrors as Record<string, string>)[entry.field] = entry.message;
      }
    }
    payload.fieldErrors = fieldErrors;
  }

  if (typeof error.message === 'string') {
    payload.message = error.message;
  }
  if (typeof error.code === 'string') {
    payload.code = error.code;
  }

  return payload;
}

/**
 * Unified form validation and error mapping layer.
 *
 * - Runs client-side schema validation before submitting.
 * - Blocks network requests when validation fails.
 * - Maps server errors back onto the correct fields.
 * - Tracks touched state so errors only surface after interaction.
 */
export function useForm<Values extends Record<string, unknown>>({
  initialValues,
  validate,
  onSubmit,
  mapServerError = defaultMapServerError,
}: UseFormOptions<Values>): UseFormResult<Values> {
  const [values, setValuesState] = useState<Values>(initialValues);
  const [errors, setErrorsState] = useState<FieldErrors<Values>>(EMPTY_ERRORS as FieldErrors<Values>);
  const [formError, setFormError] = useState<string | null>(null);
  const [touched, setTouchedState] = useState<Partial<Record<keyof Values, boolean>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const initialValuesRef = useRef(initialValues);
  const isSubmittingRef = useRef(false);

  const runValidation = useCallback(
    (nextValues: Values): FieldErrors<Values> => {
      if (!validate) return EMPTY_ERRORS as FieldErrors<Values>;
      return validate(nextValues) ?? (EMPTY_ERRORS as FieldErrors<Values>);
    },
    [validate],
  );

  const setFieldValue = useCallback(<K extends keyof Values>(field: K, value: Values[K]) => {
    setValuesState((prev) => ({ ...prev, [field]: value }));
    setErrorsState((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const setFieldTouched = useCallback(<K extends keyof Values>(field: K, isTouched = true) => {
    setTouchedState((prev) => (prev[field] === isTouched ? prev : { ...prev, [field]: isTouched }));
  }, []);

  const setValues = useCallback((next: Values) => {
    setValuesState(next);
  }, []);

  const setErrors = useCallback((next: FieldErrors<Values>) => {
    setErrorsState(next);
  }, []);

  const handleChange = useCallback(
    (event: { target: { name: string; value: unknown; type?: string; checked?: boolean } }) => {
      const { name, value, type, checked } = event.target;
      const nextValue = type === 'checkbox' ? checked : value;
      setFieldValue(name as keyof Values, nextValue as Values[keyof Values]);
    },
    [setFieldValue],
  );

  const handleBlur = useCallback(
    (event: { target: { name: string } }) => {
      setFieldTouched(event.target.name as keyof Values, true);
    },
    [setFieldTouched],
  );

  const handleSubmit = useCallback(
    async (event?: { preventDefault?: () => void }) => {
      event?.preventDefault?.();
      if (isSubmittingRef.current) return;

      const clientErrors = runValidation(values);
      if (Object.keys(clientErrors).length > 0) {
        // Invalid submissions must not issue a request.
        setErrorsState(clientErrors);
        setFormError(null);
        setTouchedState((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(clientErrors)) {
            next[key as keyof Values] = true;
          }
          return next;
        });
        return;
      }

      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setFormError(null);
      try {
        await onSubmit(values);
      } catch (error) {
        const mapped = mapServerError(error);
        if (mapped.fieldErrors && Object.keys(mapped.fieldErrors).length > 0) {
          setErrorsState(mapped.fieldErrors);
          setTouchedState((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(mapped.fieldErrors as object)) {
              next[key as keyof Values] = true;
            }
            return next;
          });
        }
        setFormError(mapped.message ?? null);
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [mapServerError, onSubmit, runValidation, values],
  );

  const reset = useCallback((nextValues?: Values) => {
    const base = nextValues ?? initialValuesRef.current;
    initialValuesRef.current = base;
    setValuesState(base);
    setErrorsState(EMPTY_ERRORS as FieldErrors<Values>);
    setFormError(null);
    setTouchedState({});
    isSubmittingRef.current = false;
    setIsSubmitting(false);
  }, []);

  const getFieldError = useCallback(
    <K extends keyof Values>(field: K): string | undefined => {
      if (!touched[field]) return undefined;
      return errors[field];
    },
    [errors, touched],
  );

  const isValid = useMemo(() => Object.keys(runValidation(values)).length === 0, [runValidation, values]);

  const isDirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initialValuesRef.current),
    [values],
  );

  return {
    values,
    errors,
    formError,
    touched,
    isSubmitting,
    isDirty,
    isValid,
    setFieldValue,
    setFieldTouched,
    setValues,
    setErrors,
    getFieldError,
    handleChange,
    handleBlur,
    handleSubmit,
    reset,
  };
}

export default useForm;
