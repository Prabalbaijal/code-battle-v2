import { context, propagation, trace, ROOT_CONTEXT, SpanStatusCode, type Span } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { suppressTracing } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TelemetryHandle {
  enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * Start OpenTelemetry. Must run before the app imports instrumented modules, so apps load it
 * via `node --import ./dist/instrument.js` (or `tsx --import ./src/instrument.ts`).
 * Disabled unless OTEL_EXPORTER_OTLP_ENDPOINT is set (tests and CI stay quiet).
 */
export function startTelemetry(opts: { serviceName: string }): TelemetryHandle {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || process.env.OTEL_SDK_DISABLED === 'true') {
    return { enabled: false, shutdown: async () => {} };
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}

const tracer = () => trace.getTracer('code-battle');

/**
 * Run `fn` detached from the current trace and with auto-instrumentation suppressed.
 * Use it to schedule background polling loops (outbox relay, job dispatcher): otherwise a timer
 * created while handling a request inherits that request's context, so every later poll is
 * attached to the request's trace, and idle polling floods the tracing backend.
 */
export function runUntraced<T>(fn: () => T): T {
  return context.with(suppressTracing(ROOT_CONTEXT), fn);
}

/** Serialize the active trace context (W3C traceparent) into a carrier — e.g. Kafka headers, job data. */
export function injectTraceContext(carrier: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function currentTraceparent(): string | undefined {
  return injectTraceContext().traceparent;
}

/** Run `fn` inside a span whose parent is the context found in `carrier` (if any). */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  carrier?: Record<string, string | undefined>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(carrier ?? {})) if (v !== undefined) clean[k] = v;
  const parent = carrier ? propagation.extract(context.active(), clean) : context.active();
  return context.with(parent, () =>
    tracer().startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    }),
  );
}
