import { z } from 'zod';

/** Env vars every service has (plan §23.5). Extend with `baseEnvSchema.extend({...})`. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** "true"/"1"/"yes" → true. zod's coerce.boolean treats "false" as true, so don't use it for env. */
export const envBool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['true', '1', 'yes'].includes(v.toLowerCase())));

/** Comma-separated list → string[]. */
export const envList = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment:\n  ${issues.join('\n  ')}`);
    this.name = 'EnvError';
  }
}

/** Parse and validate env; throws EnvError listing every problem (fail fast at boot). */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const res = schema.safeParse(source);
  if (!res.success) {
    throw new EnvError(res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return res.data;
}
