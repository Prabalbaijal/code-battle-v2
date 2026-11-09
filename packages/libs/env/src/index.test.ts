import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvError, baseEnvSchema, envBool, envList, loadEnv } from './index.js';

describe('loadEnv', () => {
  const schema = baseEnvSchema.extend({ FLAG: envBool(false), HOSTS: envList.default([]) });

  it('applies defaults and coercions', () => {
    const env = loadEnv(schema, { SERVICE_NAME: 'x', PORT: '4000', FLAG: 'false', HOSTS: 'a, b,,c' });
    expect(env).toMatchObject({ PORT: 4000, FLAG: false, HOSTS: ['a', 'b', 'c'], NODE_ENV: 'development' });
    expect(loadEnv(schema, { SERVICE_NAME: 'x', FLAG: 'TRUE' }).FLAG).toBe(true);
  });

  it('lists every invalid variable', () => {
    try {
      loadEnv(schema.extend({ DB: z.string().url() }), { PORT: '-1', DB: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as EnvError).issues.join('|');
      expect(msg).toContain('SERVICE_NAME');
      expect(msg).toContain('PORT');
      expect(msg).toContain('DB');
    }
  });
});
