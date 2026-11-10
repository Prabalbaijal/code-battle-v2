'use client';

import type { AdminProblem, CalibrationReport } from '@cb/contracts';
import { LANGUAGE_KEYS } from '@cb/contracts/constants';
import { Alert, Badge, Button, Card, CardContent, Spinner, cn } from '@cb/ui';
import { AlertTriangle, CheckCircle2, Gauge, XCircle } from 'lucide-react';
import { isApiError, messageFor } from '@/lib/api';
import { detailMessages } from '@/lib/format';
import { useCalibrate } from '@/lib/problems';
import { LANGUAGE_LABEL } from './references-panel';

const STATUS = {
  pending: { label: 'Queued', variant: 'secondary' },
  running: { label: 'Running', variant: 'default' },
  passed: { label: 'Passed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
} as const;

export function CalibrationPanel({ problem: p }: { problem: AdminProblem }) {
  const calibrate = useCalibrate(p.id);
  const c = p.calibration;
  const busy = c?.status === 'pending' || c?.status === 'running';
  // limits are cleared whenever tests or verdict-affecting limits change after a calibration
  const stale = c?.status === 'passed' && !p.calibratedAt;
  const runs = p.testFiles.length * p.referenceSolutions.length;

  return (
    <div className="grid gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-6">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">Time limits</h3>
              {c && <Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge>}
              {stale && <Badge variant="warning">Out of date</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Runs each reference solution on every test file ({runs} file runs) through the judge and derives
              limits per language. This uses judge quota.
            </p>
          </div>
          <Button loading={calibrate.isPending || busy} disabled={busy} onClick={() => calibrate.mutate()}>
            {!calibrate.isPending && !busy && <Gauge aria-hidden />}
            {busy ? 'Calibrating…' : c ? 'Run again' : 'Run calibration'}
          </Button>
        </CardContent>
      </Card>

      {calibrate.isError && (
        <Alert variant="destructive">
          <XCircle aria-hidden />
          <div>
            {messageFor(calibrate.error)}
            {isApiError(calibrate.error) && (
              <ul className="mt-1 list-disc pl-4">
                {detailMessages(calibrate.error.details).map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        </Alert>
      )}

      {stale && (
        <Alert variant="warning">
          <AlertTriangle aria-hidden />
          <div>Tests or limits changed after this calibration. Run it again before publishing.</div>
        </Alert>
      )}

      {c ? (
        <Report report={c} problem={p} />
      ) : (
        <p className="text-sm text-muted-foreground">Not calibrated yet.</p>
      )}
    </div>
  );
}

function Report({ report: c, problem: p }: { report: CalibrationReport; problem: AdminProblem }) {
  if (c.status === 'pending' || c.status === 'running') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner className="size-4" /> Waiting for the judge. This page updates by itself.
      </div>
    );
  }
  const ordinals = [...new Set(c.runs.map((r) => r.ordinal))].sort((a, b) => a - b);
  const refs = [...new Map(c.runs.map((r) => [r.referenceId, r])).values()];
  const limits = p.calibratedAt ? p.limits : c.limits;

  return (
    <div className="grid gap-4">
      {c.status === 'passed' ? (
        <Alert variant="success">
          <CheckCircle2 aria-hidden />
          <div>Calibration passed{c.finishedAt ? ` on ${new Date(c.finishedAt).toLocaleString()}` : ''}.</div>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <XCircle aria-hidden />
          <div>
            <p className="font-medium">Calibration failed</p>
            <ul className="mt-1 list-disc pl-4">
              {c.problems.map((x, i) => (
                <li key={`${x.code}-${i}`}>{x.message}</li>
              ))}
            </ul>
          </div>
        </Alert>
      )}

      {refs.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="px-4 pt-4 text-left font-semibold">Reference runs (CPU time)</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  Reference
                </th>
                {ordinals.map((o) => (
                  <th key={o} scope="col" className="px-4 py-2 font-medium">
                    File {o}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {refs.map((ref) => (
                <tr key={ref.referenceId}>
                  <th scope="row" className="px-4 py-2 text-left font-medium whitespace-nowrap">
                    {LANGUAGE_LABEL[ref.languageKey]} · expects {ref.expectedVerdict}
                  </th>
                  {ordinals.map((o) => {
                    const run = c.runs.find((r) => r.referenceId === ref.referenceId && r.ordinal === o);
                    // green: accepted; amber: the failure this reference was meant to show; red: anything else
                    const tone =
                      run?.verdict === 'AC'
                        ? 'text-success'
                        : run?.verdict === ref.expectedVerdict
                          ? 'text-warning'
                          : 'text-destructive';
                    return (
                      <td key={o} className="px-4 py-2 whitespace-nowrap">
                        <span className={cn('font-medium', tone)}>{run?.verdict ?? '—'}</span>
                        {run?.cpuMs != null && (
                          <span className="ml-2 text-muted-foreground">{run.cpuMs} ms</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {limits.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="px-4 pt-4 text-left font-semibold">
              {p.calibratedAt ? 'Time limits in use' : 'Proposed time limits (not applied)'}
            </caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  Language
                </th>
                {[...new Set(limits.map((l) => l.ordinal))]
                  .sort((a, b) => a - b)
                  .map((o) => (
                    <th key={o} scope="col" className="px-4 py-2 font-medium">
                      File {o}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {LANGUAGE_KEYS.map((lang) => (
                <tr key={lang}>
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    {LANGUAGE_LABEL[lang]}
                  </th>
                  {[...new Set(limits.map((l) => l.ordinal))]
                    .sort((a, b) => a - b)
                    .map((o) => (
                      <td key={o} className="px-4 py-2 tabular-nums">
                        {limits.find((l) => l.languageKey === lang && l.ordinal === o)?.cpuLimitMs ?? '—'} ms
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
