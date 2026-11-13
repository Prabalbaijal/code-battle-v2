import { createHttpServer, type HttpServer } from '@cb/http-server';
import type { Infra } from './infra.js';
import { registerAiRoutes } from './modules/ai.routes.js';

/** HTTP app: coach, hints, tutor (SSE), notes, recommendations, admin flags and usage. */
export async function buildApp(infra: Infra): Promise<HttpServer> {
  const app = await createHttpServer({
    serviceName: infra.env.SERVICE_NAME,
    logger: infra.logger,
    readiness: { db: infra.db.ping },
    critical: ['db'],
    openapi: { title: 'ai-service', version: '1.0.0' },
  });
  registerAiRoutes(app, {
    auth: infra.authHooks,
    gateway: infra.gateway,
    features: infra.env.AI_FEATURES,
    hintCosts: infra.env.HINT_COSTS,
    reviews: infra.reviews,
    hints: infra.hints,
    tutor: infra.tutor,
    knowledge: infra.knowledge,
    recommendations: infra.recommendations,
    integrity: infra.integrity,
    logger: infra.logger,
  });
  return app;
}
