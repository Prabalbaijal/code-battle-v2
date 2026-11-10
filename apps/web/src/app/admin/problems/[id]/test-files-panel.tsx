'use client';

import type { AdminProblem } from '@cb/contracts';
import { PACK_KINDS, PROBLEM_LIMITS as L, type PackKind } from '@cb/contracts/constants';
import { Alert, Badge, Button, Card, CardContent, Field, Input, Select } from '@cb/ui';
import { AlertTriangle, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { FormError } from '@/components/auth-card';
import { isApiError, messageFor } from '@/lib/api';
import { detailMessages, formatBytes } from '@/lib/format';
import { useDeleteTestFile, usePutTestFile } from '@/lib/problems';

type TestFile = AdminProblem['testFiles'][number];
const ORDINALS = Array.from({ length: L.testFiles }, (_, i) => i + 1);
const KIND_HINT: Record<PackKind, string> = {
  sample: 'the statement examples',
  small: 'every correctness and edge case',
  large: 'performance (big inputs, small outputs)',
};

export function TestFilesPanel({ problem: p }: { problem: AdminProblem }) {
  return (
    <div className="grid gap-4">
      <Alert variant="info">
        <AlertTriangle aria-hidden />
        <div>
          Each file is a <strong>packed</strong> test: the input starts with <code>t</code>, the number of
          cases; the output has one line per case. Up to {L.testFiles} files, input ≤{' '}
          {formatBytes(L.testInputBytes)}, output ≤ {formatBytes(L.testOutputBytes)}. Changing a file returns
          the problem to draft and needs calibration again.
        </div>
      </Alert>
      <div className="grid gap-3 md:grid-cols-2">
        {ORDINALS.map((o) => (
          <Slot key={o} problemId={p.id} ordinal={o} file={p.testFiles.find((f) => f.ordinal === o)} />
        ))}
      </div>
    </div>
  );
}

function Slot({
  problemId,
  ordinal,
  file,
}: {
  problemId: string;
  ordinal: number;
  file?: TestFile | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const del = useDeleteTestFile(problemId);

  return (
    <Card role="region" aria-label={`Test file ${ordinal}`}>
      <CardContent className="grid gap-3 pt-6">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">File {ordinal}</h3>
          {file && <Badge>{file.kind}</Badge>}
        </div>
        {file ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Cases</dt>
            <dd>{file.caseCount.toLocaleString()}</dd>
            <dt className="text-muted-foreground">Input</dt>
            <dd>{formatBytes(file.inputBytes)}</dd>
            <dt className="text-muted-foreground">SHA-256</dt>
            <dd className="truncate font-mono text-xs" title={file.sha256}>
              {file.sha256.slice(0, 16)}…
            </dd>
          </dl>
        ) : (
          !editing && <p className="text-sm text-muted-foreground">Empty slot.</p>
        )}
        {editing ? (
          <UploadForm
            problemId={problemId}
            ordinal={ordinal}
            defaultKind={file?.kind ?? (ordinal === 1 ? 'sample' : ordinal === 2 ? 'small' : 'large')}
            onDone={() => setEditing(false)}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={file ? 'outline' : 'default'} onClick={() => setEditing(true)}>
              <Upload aria-hidden /> {file ? 'Replace' : 'Upload'}
            </Button>
            {file && (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                loading={del.isPending}
                onClick={() => {
                  if (window.confirm(`Delete test file ${ordinal}?`)) del.mutate(ordinal);
                }}
              >
                {!del.isPending && <Trash2 aria-hidden />} Delete
              </Button>
            )}
          </div>
        )}
        {del.isError && <Alert variant="destructive">{messageFor(del.error)}</Alert>}
      </CardContent>
    </Card>
  );
}

interface UploadValues {
  kind: PackKind;
  input: FileList;
  output: FileList;
  /** Optional, for problems where a case prints several lines: "1, 3, 2". */
  lineCounts: string;
}

function UploadForm({
  problemId,
  ordinal,
  defaultKind,
  onDone,
}: {
  problemId: string;
  ordinal: number;
  defaultKind: PackKind;
  onDone: () => void;
}) {
  const put = usePutTestFile(problemId);
  const [problems, setProblems] = useState<string[]>([]);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UploadValues>({ defaultValues: { kind: defaultKind, lineCounts: '' } });
  const id = (name: string) => `file-${ordinal}-${name}`;
  const sizeRule = (max: number, label: string) => ({
    validate: (files: FileList) => {
      const f = files[0];
      if (!f) return `Choose the ${label} file`;
      return f.size <= max || `${label} is ${formatBytes(f.size)}; the limit is ${formatBytes(max)}`;
    },
  });

  const submit = handleSubmit(async (v) => {
    setProblems([]);
    const counts = v.lineCounts.trim()
      ? v.lineCounts
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number)
      : null;
    if (counts?.some((n) => !Number.isInteger(n) || n < 1)) {
      setError('lineCounts', { message: 'Whole numbers ≥ 1, separated by commas' });
      return;
    }
    try {
      const [input, output] = await Promise.all([v.input[0]!.text(), v.output[0]!.text()]);
      await put.mutateAsync({ ordinal, kind: v.kind, input, output, outputCaseLineCounts: counts });
      onDone();
    } catch (err) {
      if (isApiError(err, 'TEST_PACK_INVALID')) setProblems(detailMessages(err.details));
      setError('root.server', { message: messageFor(err) });
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid gap-3 border-t border-border pt-3">
      <FormError message={problems.length > 1 ? undefined : errors.root?.server?.message} />
      {problems.length > 1 && (
        <Alert variant="destructive">
          <ul className="list-disc pl-4">
            {problems.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Field
        id={id('kind')}
        label="Kind"
        hint={`For ${KIND_HINT.sample}, ${KIND_HINT.small} or ${KIND_HINT.large}.`}
      >
        <Select {...register('kind')}>
          {PACK_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}: {KIND_HINT[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={id('input')} label="Input file" error={errors.input?.message}>
        <Input
          type="file"
          accept=".in,.txt,text/plain"
          {...register('input', sizeRule(L.testInputBytes, 'Input'))}
        />
      </Field>
      <Field id={id('output')} label="Expected output file" error={errors.output?.message}>
        <Input
          type="file"
          accept=".out,.ans,.txt,text/plain"
          {...register('output', sizeRule(L.testOutputBytes, 'Output'))}
        />
      </Field>
      <Field
        id={id('lines')}
        label="Output lines per case (optional)"
        hint="Only if a case prints more than one line, e.g. 1, 3, 2"
        error={errors.lineCounts?.message}
      >
        <Input {...register('lineCounts')} className="font-mono" />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={isSubmitting}>
          Save file {ordinal}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
