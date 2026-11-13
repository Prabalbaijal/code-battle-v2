import { createAuthHooks, JwtVerifier, type AuthHooks } from '@cb/auth';
import { TOPICS } from '@cb/contracts';
import { createDb, type DbHandle } from '@cb/db';
import { createKafka } from '@cb/events';
import type { Logger } from '@cb/logger';
import type { Kafka } from 'kafkajs';
import { HttpUpstreams, type Upstreams } from './clients.js';
import type { Env } from './config/env.js';
import { Budget } from './llm/budget.js';
import { HashEmbedder, LocalEmbedder, type Embedder } from './llm/embedder.js';
import { FakeProvider } from './llm/fake.js';
import { ModelGateway } from './llm/gateway.js';
import { GroqProvider } from './llm/groq.js';
import { loadPrompts, type Prompt } from './llm/prompts.js';
import type { ModelProvider } from './llm/provider.js';
import { HintService } from './modules/hints.service.js';
import { IntegrityService } from './modules/integrity.service.js';
import { KnowledgeService } from './modules/knowledge.service.js';
import { ReadModel } from './modules/readmodel.service.js';
import { RecommendationService } from './modules/recommend.service.js';
import { ReviewService } from './modules/review.service.js';
import { TutorService } from './modules/tutor.service.js';

/** ai-service reads problems (tutor corpus, tags), matches (who played what) and verdicts. */
export const SERVICE_TOPICS = [TOPICS.problem, TOPICS.battle, TOPICS.judge];

export interface Infra {
  env: Env;
  logger: Logger;
  db: DbHandle;
  kafka: Kafka;
  authHooks: AuthHooks;
  provider: ModelProvider | null;
  gateway: ModelGateway;
  readModel: ReadModel;
  knowledge: KnowledgeService;
  reviews: ReviewService;
  hints: HintService;
  tutor: TutorService;
  recommendations: RecommendationService;
  integrity: IntegrityService;
  close(): Promise<void>;
}

export interface InfraOptions {
  verifier?: JwtVerifier;
  upstreams?: Upstreams;
  provider?: ModelProvider | null;
  embedder?: Embedder;
  notesDir?: string;
}

function makeProvider(env: Env): ModelProvider | null {
  if (env.AI_PROVIDER === 'groq' && env.GROQ_API_KEY) {
    return new GroqProvider({ apiKey: env.GROQ_API_KEY, baseUrl: env.GROQ_BASE_URL });
  }
  if (env.AI_PROVIDER === 'fake') return new FakeProvider();
  return null;
}

export async function createInfra(env: Env, logger: Logger, opts: InfraOptions = {}): Promise<Infra> {
  const db = createDb({ connectionString: env.DATABASE_URL, applicationName: env.SERVICE_NAME, logger });
  const kafka = createKafka({
    clientId: env.SERVICE_NAME,
    brokers: env.KAFKA_BROKERS,
    logger,
    ssl: env.KAFKA_SSL,
    ...(env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD
      ? {
          sasl: {
            mechanism: 'scram-sha-256',
            username: env.KAFKA_SASL_USERNAME,
            password: env.KAFKA_SASL_PASSWORD,
          },
        }
      : {}),
  });
  const upstreams =
    opts.upstreams ??
    new HttpUpstreams({
      judgeUrl: env.JUDGE_SERVICE_URL,
      problemUrl: env.PROBLEM_SERVICE_URL,
      ratingUrl: env.RATING_SERVICE_URL,
      secret: env.INTERNAL_SERVICE_SECRET,
      service: env.SERVICE_NAME,
    });
  const provider = opts.provider !== undefined ? opts.provider : makeProvider(env);
  const limits = {
    tokensPerModel: env.AI_DAILY_TOKENS_PER_MODEL,
    requestsPerModel: env.AI_DAILY_REQUESTS_PER_MODEL,
    userTokens: env.AI_USER_DAILY_TOKENS,
  };
  const budget = new Budget(db.db, limits);
  const models = { fast: env.AI_MODEL_FAST, strong: env.AI_MODEL_STRONG };
  const gateway = new ModelGateway({ provider, db: db.db, budget, models, logger });
  const embedder =
    opts.embedder ??
    (env.EMBEDDINGS === 'hash'
      ? new HashEmbedder()
      : new LocalEmbedder({ model: env.EMBEDDING_MODEL, cacheDir: env.MODEL_CACHE_DIR, logger }));
  const prompts = loadPrompts();
  const prompt = (name: string): Prompt => {
    const p = prompts.get(name);
    if (!p) throw new Error(`missing prompt ${name}.md`);
    return p;
  };

  const readModel = new ReadModel(db.db);
  const knowledge = new KnowledgeService({
    db: db.db,
    embedder,
    upstreams,
    logger,
    ...(opts.notesDir ? { notesDir: opts.notesDir } : {}),
  });
  const verifier = opts.verifier ?? new JwtVerifier({ jwksUrl: env.JWKS_URL });

  return {
    env,
    logger,
    db,
    kafka,
    authHooks: createAuthHooks(verifier, { csrf: env.CSRF_REQUIRED }),
    provider,
    gateway,
    readModel,
    knowledge,
    reviews: new ReviewService({
      db: db.db,
      gateway,
      upstreams,
      readModel,
      prompt: prompt('review'),
      logger,
    }),
    hints: new HintService({
      db: db.db,
      gateway,
      upstreams,
      readModel,
      prompts: { hint: prompt('hint'), guard: prompt('leak-guard') },
      costs: env.HINT_COSTS,
      logger,
    }),
    tutor: new TutorService({ db: db.db, gateway, upstreams, readModel, knowledge, prompt: prompt('tutor') }),
    recommendations: new RecommendationService({ db: db.db, knowledge }),
    integrity: new IntegrityService({
      db: db.db,
      upstreams,
      readModel,
      logger,
      limits,
      models: [models.fast, models.strong],
    }),
    async close() {
      await db.close();
    },
  };
}
