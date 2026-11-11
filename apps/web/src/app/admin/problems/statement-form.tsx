'use client';

import type { AdminProblem } from '@cb/contracts';
import { CHECKER_TYPES, DIFFICULTIES, PROBLEM_LIMITS as L, SLUG_RE } from '@cb/contracts/constants';
import { Alert, Button, Card, CardContent, Field, Input, Label, Select, Textarea, cn } from '@cb/ui';
import { AlertTriangle, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  useFieldArray,
  useForm,
  useWatch,
  type Control,
  type FieldPath,
  type UseFormRegister,
} from 'react-hook-form';
import { FormError } from '@/components/auth-card';
import { LazyMarkdown as Markdown } from '@/components/lazy-markdown';
import { setApiErrors } from '@/lib/form';
import { lines, tagList, toValues, type StatementValues } from '@/lib/problem-form';

/** Fields whose change voids calibration and unpublishes (problem-service `LIMIT_FIELDS`). */
const VERDICT_FIELDS = ['memoryMb', 'outputLimitKb', 'checkerType', 'floatEps'] as const;

const FIELDS = [
  'slug',
  'title',
  'difficulty',
  'statementMd',
  'inputFormatMd',
  'outputFormatMd',
  'constraints',
  'tags',
  'memoryMb',
  'outputLimitKb',
  'checkerType',
  'floatEps',
] as const;

export function StatementForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  /** Absent when creating. */
  initial?: AdminProblem;
  submitLabel: string;
  onSubmit: (values: StatementValues, changed: Set<keyof StatementValues>) => Promise<unknown>;
}) {
  const creating = !initial;
  const {
    register,
    control,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting, dirtyFields, isDirty },
  } = useForm<StatementValues>({
    mode: 'onTouched',
    // follows the server copy (e.g. after another tab saves) without dropping unsaved edits
    values: toValues(initial),
    resetOptions: { keepDirtyValues: true },
  });
  const examples = useFieldArray({ control, name: 'examples' });
  const checker = useWatch({ control, name: 'checkerType' });
  const touchesVerdicts = !creating && VERDICT_FIELDS.some((f) => dirtyFields[f]);

  const submit = handleSubmit(async (values) => {
    const changed = new Set(
      (Object.keys(dirtyFields) as (keyof StatementValues)[]).filter((k) => dirtyFields[k]),
    );
    try {
      await onSubmit(values, changed);
      if (!creating) reset(values);
    } catch (err) {
      setApiErrors(err, setError, {
        fields: FIELDS,
        codeToField: { SLUG_TAKEN: 'slug' },
      });
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid gap-6">
      <FormError message={errors.root?.server?.message} />

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <Field id="title" label="Title" error={errors.title?.message}>
            <Input
              {...register('title', {
                required: 'Title is required',
                minLength: { value: L.title.min, message: `At least ${L.title.min} characters` },
                maxLength: { value: L.title.max, message: `At most ${L.title.max} characters` },
              })}
            />
          </Field>
          <Field
            id="slug"
            label="Slug"
            error={errors.slug?.message}
            hint={creating ? 'Used in URLs; it cannot change later.' : 'Slugs cannot change.'}
          >
            <Input
              {...register('slug', {
                required: 'Slug is required',
                pattern: { value: SLUG_RE, message: 'Lowercase words joined by hyphens, e.g. two-sum' },
                minLength: { value: L.slug.min, message: `At least ${L.slug.min} characters` },
                maxLength: { value: L.slug.max, message: `At most ${L.slug.max} characters` },
              })}
              disabled={!creating}
              className="font-mono"
              spellCheck={false}
            />
          </Field>
          <Field id="difficulty" label="Difficulty" error={errors.difficulty?.message}>
            <Select {...register('difficulty')}>
              {DIFFICULTIES.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </Select>
          </Field>
          <Field
            id="tags"
            label="Tags"
            hint="Comma separated, e.g. arrays, two pointers"
            error={errors.tags?.message}
          >
            <Input
              {...register('tags', {
                validate: (v) =>
                  (tagList(v).length <= L.tags.count && tagList(v).every((t) => t.length <= L.tags.length)) ||
                  `Up to ${L.tags.count} tags of ${L.tags.length} characters`,
              })}
            />
          </Field>
        </CardContent>
      </Card>

      <MarkdownField
        name="statementMd"
        label="Statement"
        max={L.statementMd}
        rows={10}
        register={register}
        control={control}
        error={errors.statementMd?.message}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <MarkdownField
          name="inputFormatMd"
          label="Input format"
          max={L.formatMd}
          rows={5}
          register={register}
          control={control}
          error={errors.inputFormatMd?.message}
        />
        <MarkdownField
          name="outputFormatMd"
          label="Output format"
          max={L.formatMd}
          rows={5}
          register={register}
          control={control}
          error={errors.outputFormatMd?.message}
        />
      </div>

      <Field
        id="constraints"
        label="Constraints"
        hint="One per line; math works, e.g. $1 \le n \le 10^5$"
        error={errors.constraints?.message}
      >
        <Textarea
          rows={4}
          className="font-mono"
          {...register('constraints', {
            validate: (v) =>
              (lines(v).length <= L.constraints.count &&
                lines(v).every((c) => c.length <= L.constraints.length)) ||
              `Up to ${L.constraints.count} lines of ${L.constraints.length} characters`,
          })}
        />
      </Field>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-medium">Examples (shown in the statement)</legend>
        {examples.fields.map((f, i) => (
          <Card key={f.id}>
            <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
              <Field
                id={`ex-${i}-input`}
                label={`Input ${i + 1}`}
                error={errors.examples?.[i]?.input?.message}
              >
                <Textarea
                  rows={4}
                  className="font-mono"
                  {...register(`examples.${i}.input`, {
                    required: 'Input is required',
                    maxLength: { value: L.examples.text, message: 'Too long' },
                  })}
                />
              </Field>
              <Field
                id={`ex-${i}-output`}
                label={`Output ${i + 1}`}
                error={errors.examples?.[i]?.output?.message}
              >
                <Textarea
                  rows={4}
                  className="font-mono"
                  {...register(`examples.${i}.output`, {
                    required: 'Output is required',
                    maxLength: { value: L.examples.text, message: 'Too long' },
                  })}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field
                  id={`ex-${i}-explanation`}
                  label="Explanation (optional)"
                  error={errors.examples?.[i]?.explanation?.message}
                >
                  <Textarea
                    rows={2}
                    {...register(`examples.${i}.explanation`, {
                      maxLength: { value: L.examples.explanation, message: 'Too long' },
                    })}
                  />
                </Field>
              </div>
              {examples.fields.length > L.examples.min && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-self-start text-destructive"
                  onClick={() => examples.remove(i)}
                >
                  <Trash2 aria-hidden /> Remove example {i + 1}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
        {examples.fields.length < L.examples.max && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() => examples.append({ input: '', output: '', explanation: '' })}
          >
            <Plus aria-hidden /> Add example
          </Button>
        )}
      </fieldset>

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="memoryMb" label="Memory limit (MB)" error={errors.memoryMb?.message}>
            <Input
              type="number"
              inputMode="numeric"
              {...register('memoryMb', {
                valueAsNumber: true,
                min: { value: L.memoryKb.min / 1024, message: `At least ${L.memoryKb.min / 1024} MB` },
                max: { value: L.memoryKb.max / 1024, message: `At most ${L.memoryKb.max / 1024} MB` },
              })}
            />
          </Field>
          <Field id="outputLimitKb" label="Output limit (KB)" error={errors.outputLimitKb?.message}>
            <Input
              type="number"
              inputMode="numeric"
              {...register('outputLimitKb', {
                valueAsNumber: true,
                min: { value: L.outputKb.min, message: `At least ${L.outputKb.min} KB` },
                max: { value: L.outputKb.max, message: `At most ${L.outputKb.max} KB` },
              })}
            />
          </Field>
          <Field id="checkerType" label="Checker" error={errors.checkerType?.message}>
            <Select {...register('checkerType')}>
              {CHECKER_TYPES.map((c) => (
                <option key={c} value={c}>
                  {c === 'tokens' ? 'tokens (ignore spacing)' : c === 'float' ? 'float (± eps)' : 'exact'}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="floatEps" label="Float epsilon" error={errors.floatEps?.message}>
            <Input
              inputMode="decimal"
              placeholder="1e-6"
              disabled={checker !== 'float'}
              {...register('floatEps', {
                validate: (v, all) =>
                  all.checkerType !== 'float' ||
                  (Number(v) > 0 && Number(v) <= 1) ||
                  'A number in (0, 1], e.g. 1e-6',
              })}
            />
          </Field>
        </CardContent>
      </Card>

      {touchesVerdicts && (
        <Alert variant="warning">
          <AlertTriangle aria-hidden />
          <div>
            Changing limits or the checker affects verdicts: the problem goes back to draft and needs
            calibration again.
          </div>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button type="submit" loading={isSubmitting} disabled={!creating && !isDirty}>
          {submitLabel}
        </Button>
        {!creating && isDirty && (
          <Button type="button" variant="ghost" onClick={() => reset()}>
            Discard changes
          </Button>
        )}
      </div>
    </form>
  );
}

/** Markdown textarea with a Write / Preview switch (preview uses the same renderer as players). */
function MarkdownField({
  name,
  label,
  max,
  rows,
  register,
  control,
  error,
}: {
  name: Extract<FieldPath<StatementValues>, 'statementMd' | 'inputFormatMd' | 'outputFormatMd'>;
  label: string;
  max: number;
  rows: number;
  register: UseFormRegister<StatementValues>;
  control: Control<StatementValues>;
  error?: string | undefined;
}) {
  const [preview, setPreview] = useState(false);
  const value = useWatch({ control, name });
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={name}>{label}</Label>
        <div className="flex items-center gap-1" role="group" aria-label={`${label} view`}>
          <Button
            type="button"
            size="sm"
            variant={preview ? 'ghost' : 'secondary'}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            <Pencil aria-hidden /> Write
          </Button>
          <Button
            type="button"
            size="sm"
            variant={preview ? 'secondary' : 'ghost'}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            <Eye aria-hidden /> Preview
          </Button>
        </div>
      </div>
      <Textarea
        id={name}
        rows={rows}
        className={cn('font-mono', preview && 'hidden')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : `${name}-hint`}
        {...register(name, {
          validate: (v) => v.trim().length > 0 || `${label} is required`,
          maxLength: { value: max, message: `At most ${max.toLocaleString()} characters` },
        })}
      />
      {preview && (
        <div className="min-h-24 rounded-md border border-border p-3">
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing to preview.</p>
          )}
        </div>
      )}
      {error ? (
        <p id={`${name}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p id={`${name}-hint`} className="text-xs text-muted-foreground">
          Markdown with $math$. {value.length.toLocaleString()} / {max.toLocaleString()}
        </p>
      )}
    </div>
  );
}
