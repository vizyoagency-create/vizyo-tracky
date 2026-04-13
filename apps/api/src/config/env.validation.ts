import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  TRACKER_TCP_PORT: z.coerce.number().int().positive().default(5023),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:4200'),
  MOCK_POSITIONS: z.string().default('false'),

  // Vizyo Auth
  VIZYO_AUTH_API_URL: z.url(),
  VIZYO_AUTH_APP_ID: z.string().min(1),
  VIZYO_AUTH_APP_SECRET: z.string().min(16),
  VIZYO_AUTH_JWT_ACCESS_SECRET: z.string().min(1),
  VIZYO_AUTH_JWT_ISSUER: z.string().min(1),
  VIZYO_AUTH_APP_INTERNAL_ID: z.string().min(1),

  // Internal API (Manager → Tracky)
  INTERNAL_API_SECRET: z.string().min(16),

  // Observability
  WIRE_LOG_ENABLED: z.string().default('false'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:', z.treeifyError(parsed.error));
    throw new Error('Invalid environment variables');
  }
  return parsed.data;
}
