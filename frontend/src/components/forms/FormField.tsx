import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';

export type FieldErrors<TValues> = Partial<Record<keyof TValues, string>>;

export type Validator<TValues> = (values: TValues) => FieldErrors<TValues>;

export type ServerErrorMapper<TValues> = (error: unknown) => FieldErrors<TValues>;

export interface FormState<TValues> {
  values: TValues;
  errors: FieldErrors<TValues>;
  touched: Partial<Record<keyof TValues, boolean>>;
  submitting: boolean;
  submitted: boolean;
}

export interface FormApi<TValues> extends FormState<TValues> {
  setValue: <K extends keyof TValues>(field: K, value: TValues[K]) => void;
  setTouched: (field: keyof TValues, touched?: boolean) => void;
  setServerErrors: (errors: FieldErrors<TValues>) => void;
  validate: () => FieldErrors<TValues>;
  handleSubmit: (onSubmit: (values: TValues) => Promise<unknown> | unknown) => (event?: { preventDefault?: () => void }) => Promise<void>;
  reset: (values?: TValues) => void;
}

export function createFormApi<TValues extends Record<string, unknown>>(
  initialValues: TValues,
  validate: Validator<TValues>,
  mapServerError?: ServerErrorMapper<TValues>,
): FormApi<TValues> {
  const [values, setValues] = useState<TValues>(initialValues);
  const [errors, setErrors] = useState<FieldErrors<TValues>>({});
  const [touched, setTouchedState] = useState<Partial<Record<keyof TValues, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const setValue = useCallback(<K extends keyof TValues>(field: K, value: TValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const setTouched = useCallback((field: keyof TValues, isTouched = true) => {
    setTouchedState((prev) => ({ ...prev, [field]: isTouched }));
  }, []);

  const setServerErrors = useCallback((serverErrors: FieldErrors<TValues>) => {
    setErrors((prev) => ({ ...prev, ...serverErrors }));
  }, []);

  const runValidation = useCallback(() => {
    const nextErrors = validate(values);
    setErrors(nextErrors);
    return nextErrors;
  }, [validate, values]);

  const handleSubmit = useCallback(
    (onSubmit: (values: TValues) => Promise<unknown> | unknown) =>
      async (event?: { preventDefault?: () => void }) => {
        event?.preventDefault?.();
        setSubmitted(true);
        const nextErrors = runValidation();
        if (Object.keys(nextErrors).length > 0) {
          return;
        }
        setSubmitting(true);
        try {
          await onSubmit(values);
        } catch (error) {
          if (mapServerError) {
            setServerErrors(mapServerError(error));
          }
        } finally {
          setSubmitting(false);
        }
      },
    [mapServerError, onSubmitPlaceholder, runValidation, setServerErrors, values],
  );

  const reset = useCallback((nextValues?: TValues) => {
    setValues(nextValues ?? initialValues);
    setErrors({});
    setTouchedState({});
    setSubmitted(false);
    setSubmitting(false);
  }, [initialValues]);

  return useMemo(
    () => ({
      values,
      errors,
      touched,
      submitting,
      submitted,
      setValue,
      setTouched,
      setServerErrors,
      validate: runValidation,
      handleSubmit,
      reset,
    }),
    [values, errors, touched, submitting, submitted, setValue, setTouched, setServerErrors, runValidation, handleSubmit, reset],
  );
}

const FormContext = createContext<FormApi<Record<string, unknown>> | null>(null);

export function FormProvider<TValues extends Record<string, unknown>>({
  api,
  children,
}: {
  api: FormApi<TValues>;
  children: React.ReactNode;
}) {
  return <FormContext.Provider value={api as unknown as FormApi<Record<string, unknown>>}>{children}</FormContext.Provider>;
}

export function useFormField<TValues extends Record<string, unknown>>(field: keyof TValues) {
  const api = useContext(FormContext) as FormApi<TValues> | null;
  if (!api) {
    throw new Error('useFormField must be used within a FormProvider');
  }
  const error = api.errors[field];
  const showError = Boolean(error) && (api.submitted || api.touched[field]);
  return {
    value: api.values[field],
    error: showError ? error : undefined,
    touched: Boolean(api.touched[field]),
    onChange: (value: TValues[keyof TValues]) => api.setValue(field, value),
    onBlur: () => api.setTouched(field, true),
  };
}

export interface FormFieldProps {
  label: string;
  name: string;
  error?: string;
  touched?: boolean;
  required?: boolean;
  children: React.ReactNode;
}

export function FormField({ label, name, error, touched, required, children }: FormFieldProps) {
  const errorId = `${name}-error`;
  const showError = Boolean(error) && touched !== false;
  return (
    <div className="form-field">
      <label htmlFor={name}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {showError ? (
        <p id={errorId} role="alert" className="form-field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default FormField;
