'use client';

import { useCallback, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { FieldValues, Path, RegisterOptions, UseFormSetError } from 'react-hook-form';

/**
 * The slice of react-hook-form the auth pages use (`register`, `handleSubmit`, `setError`,
 * `errors`, `isSubmitting`, `mode: 'onTouched'`), in ~1 KB instead of ~10 KB gzip: the auth pages
 * are the entry funnel and must fit the first-load budget (plan §21.4). Same rule objects
 * (`lib/form.ts`) and the same `setApiErrors`. Bigger forms (admin) keep react-hook-form.
 */
type Rule = RegisterOptions;
type Msg = { message?: string };
export type LiteErrors<T> = Partial<Record<keyof T, Msg>> & { root?: { server?: Msg } };

const text = (r: unknown): string | undefined =>
  typeof r === 'string' ? r : (r as { message?: string } | undefined)?.message;
const limit = (r: unknown): number | undefined =>
  typeof r === 'number' ? r : (r as { value?: number } | undefined)?.value;

export function check(rule: Rule, value: unknown, all: FieldValues): string | undefined {
  const s = typeof value === 'string' ? value : '';
  if (rule.required && !s) return text(rule.required) ?? 'Required';
  if (!s) return undefined;
  const min = limit(rule.minLength);
  if (min !== undefined && s.length < min) return text(rule.minLength);
  const max = limit(rule.maxLength);
  if (max !== undefined && s.length > max) return text(rule.maxLength);
  const pattern = rule.pattern as { value: RegExp; message?: string } | RegExp | undefined;
  const re = pattern instanceof RegExp ? pattern : pattern?.value;
  if (re && !re.test(s)) return text(pattern) ?? 'Invalid value';
  if (typeof rule.validate === 'function') {
    const r = (rule.validate as (v: unknown, all: FieldValues) => unknown)(value, all);
    if (r !== true && r !== undefined) return typeof r === 'string' ? r : 'Invalid value';
  }
  return undefined;
}

export function useLiteForm<T extends FieldValues>(_opts: { mode: 'onTouched' } = { mode: 'onTouched' }) {
  const fields = useRef(new Map<string, { el: HTMLInputElement | null; rule: Rule }>());
  const touched = useRef(new Set<string>());
  const [errors, setErrors] = useState<LiteErrors<T>>({});
  const [isSubmitting, setSubmitting] = useState(false);

  const values = useCallback((): T => {
    const out: FieldValues = {};
    for (const [name, f] of fields.current) {
      const raw = f.el?.value ?? '';
      out[name] = f.rule.setValueAs ? f.rule.setValueAs(raw) : raw;
    }
    return out as T;
  }, []);

  const validateOne = useCallback(
    (name: string) => {
      const f = fields.current.get(name);
      if (!f) return;
      const all = values();
      const message = check(f.rule, all[name], all);
      setErrors((e) => ({ ...e, [name]: message ? { message } : undefined }));
    },
    [values],
  );

  const register = (name: Path<T>, rule: Rule = {}) => {
    const entry = fields.current.get(name) ?? { el: null, rule };
    entry.rule = rule;
    fields.current.set(name, entry);
    return {
      name,
      ref: (el: HTMLInputElement | null) => {
        entry.el = el;
      },
      onBlur: () => {
        touched.current.add(name);
        validateOne(name);
      },
      onChange: (_e: ChangeEvent<HTMLInputElement>) => {
        if (touched.current.has(name)) validateOne(name);
      },
    };
  };

  const setError = ((name: string, error: Msg, options?: { shouldFocus?: boolean }) => {
    if (name === 'root.server') setErrors((e) => ({ ...e, root: { server: { message: error.message } } }));
    else setErrors((e) => ({ ...e, [name]: { message: error.message } }));
    if (options?.shouldFocus) fields.current.get(name)?.el?.focus();
  }) as UseFormSetError<T>;

  const handleSubmit = (fn: (values: T) => Promise<void> | void) => async (e?: FormEvent) => {
    e?.preventDefault();
    const all = values();
    const next: LiteErrors<T> = {};
    let first: HTMLInputElement | null = null;
    for (const [name, f] of fields.current) {
      touched.current.add(name);
      const message = check(f.rule, all[name], all);
      if (message) {
        (next as Record<string, Msg>)[name] = { message };
        first ??= f.el;
      }
    }
    setErrors(next);
    if (first) return first.focus();
    setSubmitting(true);
    try {
      await fn(all);
    } finally {
      setSubmitting(false);
    }
  };

  return { register, handleSubmit, setError, formState: { errors, isSubmitting } };
}
