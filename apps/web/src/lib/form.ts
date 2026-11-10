import {
  EMAIL_MAX_LENGTH,
  FULLNAME_MAX_LENGTH,
  isReservedUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_RE,
} from '@cb/contracts/constants';
import type { FieldValues, Path, RegisterOptions, UseFormSetError } from 'react-hook-form';
import { isApiError, messageFor } from './api';

/**
 * react-hook-form rules built from the same constants as the server's zod schemas
 * (`@cb/contracts/constants`). We don't ship zod to the browser (~45 KB gzip); the API stays the
 * authority, and anything that slips through comes back as VALIDATION_FAILED and is mapped below.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const trim = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

export const rules = {
  required: (label: string) => ({ required: `${label} is required` }) satisfies RegisterOptions,
  identifier: { required: 'Enter your username or email', setValueAs: trim } satisfies RegisterOptions,
  fullname: {
    required: 'Full name is required',
    maxLength: { value: FULLNAME_MAX_LENGTH, message: 'Name is too long' },
    setValueAs: trim,
  } satisfies RegisterOptions,
  username: {
    required: 'Username is required',
    setValueAs: trim,
    pattern: { value: USERNAME_RE, message: 'Use 3–20 letters, digits or _' },
    validate: (v: string) => !isReservedUsername(v) || 'This username is reserved',
  } satisfies RegisterOptions,
  email: {
    required: 'Email is required',
    setValueAs: (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    pattern: { value: EMAIL_RE, message: 'Enter a valid email' },
    maxLength: { value: EMAIL_MAX_LENGTH, message: 'Email is too long' },
  } satisfies RegisterOptions,
  password: {
    required: 'Password is required',
    minLength: { value: PASSWORD_MIN_LENGTH, message: `Use at least ${PASSWORD_MIN_LENGTH} characters` },
    maxLength: { value: PASSWORD_MAX_LENGTH, message: `Use at most ${PASSWORD_MAX_LENGTH} characters` },
  } satisfies RegisterOptions,
  /** Confirmation field: must equal the `password` field. */
  confirm: {
    required: 'Confirm your password',
    validate: (v: string, all: FieldValues) => v === all.password || 'Passwords do not match',
  } satisfies RegisterOptions,
};

/** Key for errors that belong to no single field: read `formState.errors.root?.server?.message`. */
export const SERVER = 'root.server' as const;

/**
 * Put an API error onto the form: VALIDATION_FAILED details go to their fields (`/email` → email),
 * known codes to the field they concern, everything else to the form-level message.
 */
export function setApiErrors<T extends FieldValues>(
  err: unknown,
  setError: UseFormSetError<T>,
  opts: {
    fields: readonly Path<T>[];
    codeToField?: Partial<Record<string, Path<T>>>;
    messages?: Record<string, string>;
  } = {
    fields: [],
  },
): void {
  const formError = (message: string) => setError(SERVER as Path<T>, { type: 'server', message });
  if (!isApiError(err)) return formError(messageFor(err));
  const custom = opts.messages?.[err.code];
  if (custom) return formError(custom);

  if (err.code === 'VALIDATION_FAILED' && Array.isArray(err.details)) {
    let placed = false;
    for (const d of err.details as { path?: string; message?: string }[]) {
      const key = d.path?.replace(/^\//, '').split('/')[0];
      if (key && opts.fields.includes(key as Path<T>)) {
        setError(key as Path<T>, { type: 'server', message: d.message ?? 'Invalid value' });
        placed = true;
      }
    }
    if (placed) return;
  }
  const field = opts.codeToField?.[err.code];
  if (field) return setError(field, { type: 'server', message: err.message }, { shouldFocus: true });
  formError(messageFor(err));
}
