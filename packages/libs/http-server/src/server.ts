import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import { REQUEST_ID_HEADER, type ErrorBody, type ErrorCode, type Health } from '@cb/contracts';
import { isAppError } from '@cb/errors';
import { newId } from '@cb/ids';
import { histogram, initMetrics, metricsContentType, renderMetrics } from '@cb/metrics';
import type { Logger } from '@cb/logger';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type HttpServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export type ReadinessCheck = () => Promise<boolean>;

export interface CreateHttpServerOptions {
  serviceName: string;
  logger: Logger;
  /** Max JSON body in bytes. Default 100 KB (plan §7.3). */
  bodyLimit?: number;
  /** Named dependency checks for /health/ready. */
  readiness?: Record<string, ReadinessCheck>;
  /** Checks whose failure makes the service not ready (503). Others only mark it "degraded". */
  critical?: string[];
  /**
   * Trust X-Forwarded-* (default true: internal services sit behind the gateway, which sets it).
   * A string trusts only those proxy addresses/CIDRs (e.g. "loopback, 172.18.0.0/16"); the
   * internet-facing gateway uses this so clients cannot spoof X-Forwarded-For.
   */
  trustProxy?: boolean | string;
  /**
   * Generate an OpenAPI 3 document from the routes' zod schemas and serve it at GET /openapi.json
   * (the gateway aggregates these at /docs). Routes registered after creation are included.
   */
  openapi?: { title: string; version?: string; description?: string };
}

/** Routes that never appear in OpenAPI documents. */
const HIDDEN = { schema: { hide: true } } as const;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const QUIET_ROUTES = new Set(['/health/live', '/health/ready', '/metrics']);

function errorBody(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorBody {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

export async function createHttpServer(opts: CreateHttpServerOptions): Promise<HttpServer> {
  const app = Fastify({
    loggerInstance: opts.logger as FastifyBaseLogger,
    bodyLimit: opts.bodyLimit ?? 100 * 1024,
    trustProxy: opts.trustProxy ?? true,
    // We log one line per request ourselves in onResponse (quieter than Fastify's two lines).
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : newId();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(helmet, { global: true });

  if (opts.openapi) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.0.3',
        info: {
          title: opts.openapi.title,
          version: opts.openapi.version ?? '1.0.0',
          ...(opts.openapi.description ? { description: opts.openapi.description } : {}),
        },
      },
      transform: jsonSchemaTransform,
      transformObject: jsonSchemaTransformObject,
    });
    app.get('/openapi.json', HIDDEN, async () => app.swagger());
  }

  // plan §19: request latency per route pattern (not raw URL: bounded label values), and /metrics
  initMetrics(opts.serviceName);
  const httpDuration = histogram('http_server_duration_seconds', 'HTTP request duration', [
    'method',
    'route',
    'status_code',
  ]);
  app.get('/metrics', HIDDEN, async (_req, reply) =>
    reply.header('content-type', metricsContentType).send(await renderMetrics()),
  );

  app.addHook('onSend', async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    if (QUIET_ROUTES.has(req.routeOptions.url ?? '')) return;
    httpDuration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
    req.log.info(
      { method: req.method, url: req.url, statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request completed',
    );
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody('NOT_FOUND', `Route ${req.method} ${req.url} not found`, req.id));
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (isAppError(err)) {
      if (err.status >= 500) req.log.error({ err }, 'app error');
      return reply
        .code(err.status)
        .send(errorBody(err.code, err.expose ? err.message : 'Internal error', req.id, err.details));
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send(
        errorBody(
          'VALIDATION_FAILED',
          'Request validation failed',
          req.id,
          err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        ),
      );
    }
    if (err.name === 'CircuitOpenError') {
      return reply.code(503).send(errorBody('SERVICE_UNAVAILABLE', 'Dependency unavailable', req.id));
    }
    if (err.statusCode === 413) {
      return reply.code(413).send(errorBody('PAYLOAD_TOO_LARGE', 'Payload too large', req.id));
    }
    if (err.statusCode === 429) {
      return reply.code(429).send(errorBody('RATE_LIMITED', err.message, req.id));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send(errorBody('BAD_REQUEST', err.message, req.id));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL_ERROR', 'Internal error', req.id));
  });

  app.get('/health/live', HIDDEN, async () => ({ status: 'ok' as const, checks: {} }) satisfies Health);

  app.get('/health/ready', HIDDEN, async (_req, reply) => {
    const checks: Health['checks'] = {};
    const entries = Object.entries(opts.readiness ?? {});
    await Promise.all(
      entries.map(async ([name, check]) => {
        const ok = await Promise.race([
          check().catch(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
        ]);
        checks[name] = ok ? 'ok' : 'down';
      }),
    );
    const critical = new Set(opts.critical ?? entries.map(([n]) => n));
    const criticalDown = Object.entries(checks).some(([n, s]) => s === 'down' && critical.has(n));
    const anyDown = Object.values(checks).includes('down');
    const body: Health = { status: criticalDown ? 'down' : anyDown ? 'degraded' : 'ok', checks };
    return reply.code(criticalDown ? 503 : 200).send(body);
  });

  return app;
}
