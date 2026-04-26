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

  // SMS Gateway (Twilio) — Sprint I, SUPER_ADMIN only.
  // Si TWILIO_ACCOUNT_SID est vide, le module SMS est en mode no-op (UI affiche
  // "SMS desactive" mais ne plante pas — utile en dev sans credentials).
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_PHONE_NUMBER: z.string().default(''),
  TWILIO_WEBHOOK_URL: z.string().default(''),

  // Email Gateway (Resend) — Sprint J. Si RESEND_API_KEY est vide, le module
  // est en mode no-op (les invitations sont creees mais l'email n'est pas envoye,
  // log de debug). Permet de developper sans compte Resend.
  RESEND_API_KEY: z.string().default(''),
  RESEND_FROM: z.string().default('contact@vizyoagency.com'),

  // URL publique de l'app Angular — utilise pour les liens dans les emails
  // d'invitation (`{APP_BASE_URL}/accept-invite?token=...`). En dev pointe sur
  // localhost:4200, en prod sur https://app-tracky.vizyoagency.com.
  APP_BASE_URL: z.string().default('http://localhost:4200'),

  // Secret JWT pour signer les tokens d'invitation (24h). Si vide, fallback
  // sur VIZYO_AUTH_JWT_ACCESS_SECRET. Differencier permet de revoquer les
  // invitations sans casser les sessions actives.
  INVITATION_JWT_SECRET: z.string().default(''),
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
