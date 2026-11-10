'use client';

import type { AdminProblem } from '@cb/contracts';
import {
  LANGUAGE_KEYS,
  MAX_CODE_BYTES,
  REFERENCE_VERDICTS,
  type LanguageKey,
  type ReferenceVerdict,
} from '@cb/contracts/constants';
import { Alert, Badge, Button, Card, CardContent, Field, Input, Select, Textarea } from '@cb/ui';
import { Info, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { FormError } from '@/components/auth-card';
import { messageFor } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useAddReference, useDeleteReference } from '@/lib/problems';

export const LANGUAGE_LABEL: Record<LanguageKey, string> = {
  cpp: 'C++',
  java: 'Java',
  python: 'Python',
  javascript: 'JavaScript',
};
const VERDICT_HINT: Record<ReferenceVerdict, string> = {
  AC: 'correct and efficient: sets the time limits',
  TLE: 'correct but too slow (e.g. brute force): must not pass',
  WA: 'subtly wrong: must fail some test',
};
const VERDICT_VARIANT = { AC: 'success', TLE: 'warning', WA: 'destructive' } as const;

export function ReferencesPanel({ problem: p }: { problem: AdminProblem }) {
  const del = useDeleteReference(p.id);
  return (
    <div className="grid gap-4">
      <Alert variant="info">
        <Info aria-hidden />
        <div>
          Calibration runs every reference on every test file. You need an accepted C++ solution (it sets the
          limits) and a must-TLE one (proves slow solutions fail). Other languages without their own accepted
          reference get C++ time × a language factor.
        </div>
      </Alert>

      {p.referenceSolutions.length > 0 && (
        <Card className="divide-y divide-border">
          {p.referenceSolutions.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="font-medium">{LANGUAGE_LABEL[r.languageKey]}</span>
              <Badge variant={VERDICT_VARIANT[r.expectedVerdict as ReferenceVerdict] ?? 'secondary'}>
                expects {r.expectedVerdict}
              </Badge>
              <span className="text-xs text-muted-foreground">
                added {new Date(r.createdAt).toLocaleString()}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-destructive"
                disabled={del.isPending}
                aria-label={`Delete ${LANGUAGE_LABEL[r.languageKey]} ${r.expectedVerdict} reference`}
                onClick={() => {
                  if (window.confirm('Delete this reference solution?')) del.mutate(r.id);
                }}
              >
                <Trash2 aria-hidden /> Delete
              </Button>
            </div>
          ))}
        </Card>
      )}
      {del.isError && <Alert variant="destructive">{messageFor(del.error)}</Alert>}

      <AddReference problemId={p.id} />
    </div>
  );
}

interface Values {
  languageKey: LanguageKey;
  expectedVerdict: ReferenceVerdict;
  code: string;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

function AddReference({ problemId }: { problemId: string }) {
  const add = useAddReference(problemId);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ defaultValues: { languageKey: 'cpp', expectedVerdict: 'AC', code: '' } });

  const submit = handleSubmit(async (v) => {
    try {
      await add.mutateAsync(v);
      reset({ ...v, code: '' });
    } catch (err) {
      setError('root.server', { message: messageFor(err) });
    }
  });

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={submit} noValidate className="grid gap-4">
          <h3 className="font-semibold">Add a reference solution</h3>
          <FormError message={errors.root?.server?.message} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ref-language" label="Language">
              <Select {...register('languageKey')}>
                {LANGUAGE_KEYS.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABEL[l]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="ref-verdict" label="Expected verdict">
              <Select {...register('expectedVerdict')}>
                {REFERENCE_VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {v}: {VERDICT_HINT[v]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            id="ref-code"
            label="Code"
            error={errors.code?.message}
            hint={`Paste it or load a file. Up to ${formatBytes(MAX_CODE_BYTES)}.`}
          >
            <Textarea
              rows={12}
              className="font-mono text-xs"
              spellCheck={false}
              {...register('code', {
                validate: (c) =>
                  !c.trim()
                    ? 'Code is required'
                    : byteLength(c) <= MAX_CODE_BYTES || `Code is larger than ${formatBytes(MAX_CODE_BYTES)}`,
              })}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={isSubmitting}>
              Add reference
            </Button>
            <label className="text-sm text-muted-foreground">
              <span className="sr-only">Load code from a file</span>
              <Input
                type="file"
                accept=".cpp,.cc,.java,.py,.js,.txt"
                className="h-9 w-auto"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setValue('code', await f.text(), { shouldValidate: true, shouldDirty: true });
                }}
              />
            </label>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
