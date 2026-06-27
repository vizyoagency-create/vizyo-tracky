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
  VIZYO_AUTH_WEB_URL: z.string().default('https://auth.vizyoagency.com'),
  VIZYO_AUTH_DB_URL: z.string().optional(),

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

  // vizyo-texto — passerelle SMS maison (remplace Twilio). Si VIZYO_TEXTO_URL +
  // VIZYO_TEXTO_API_KEY sont definis, SmsGatewayService les utilise EN PRIORITE.
  // VIZYO_TEXTO_WEBHOOK_SECRET sert a valider les webhooks entrants (X-Vizyo-Signature).
  VIZYO_TEXTO_URL: z.string().default(''),
  VIZYO_TEXTO_API_KEY: z.string().default(''),
  VIZYO_TEXTO_WEBHOOK_SECRET: z.string().default(''),

  // SMS heartbeat (V1.15) — "preuve de vie" hebdo de la chaine SMS. CSV de
  // numeros E.164 (ex: +33656691615,+33687654321) qui recoivent chaque lundi
  // 09h00 (Europe/Paris) un SMS de test. Si la chaine casse, un ErrorLog
  // CRITICAL est cree. Vide => le cron skip (no-op safe en dev). Cf.
  // SmsHeartbeatService.
  SMS_HEARTBEAT_RECIPIENTS: z.string().default(''),

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

  // Web Push (Sprint M). Generer une fois via :
  //   npx web-push generate-vapid-keys
  // VAPID_SUBJECT doit etre un mailto: ou https:// (cf. RFC 8292).
  // Si VAPID_PUBLIC_KEY est vide, le push est desactive (mode no-op).
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:contact@vizyoagency.com'),

  // WhereverSIM — parc de cartes SIM M2M (V1.16). API GraphQL.
  // Si WHEREVER_SIM_TOKEN est vide, le module SIM est en mode no-op : l'UI
  // fonctionne sur le cache local mais aucun appel fournisseur n'est tente
  // (sync/lifecycle renvoient "non configure"). Le token se passe brut dans
  // le header Authorization (PAS de prefixe Bearer — verifie en live).
  WHEREVER_SIM_API_URL: z.string().default('https://graphql.api.whereversim.com/graphql'),
  WHEREVER_SIM_TOKEN: z.string().default(''),

  // Retention donnees (V1.18) — purge auto nocturne (3h30), cf. DataRetentionService.
  // SAMPLING_DECISIONS_RETENTION_DAYS : audit-trail du sampling. Defaut 7j (deja
  //   documente dans le schema Prisma). 0 => desactive.
  // POSITIONS_RETENTION_DAYS : positions GPS. DESACTIVE par defaut (0 = retention
  //   infinie, comportement historique). Purger supprime le replay des vieux
  //   trajets => duree de conservation = decision metier/legale, a activer en
  //   connaissance de cause. Suppression par lots (10k) pour ne pas verrouiller
  //   l'ingestion temps reel.
  SAMPLING_DECISIONS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  POSITIONS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Retention des logs (LogCleanupService, cron 3h00) — env-configurables pour
  // ajuster sans redeploy. WIRE_LOGS = trames brutes (volumineux : 1 ligne/trame),
  // ERROR_LOGS = erreurs applicatives.
  WIRE_LOGS_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  ERROR_LOGS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Sprint 4 — Écoute audio à distance (micro vehicule), LEGALEMENT SENSIBLE.
  // AUDIO_MONITORING_ENABLED : interrupteur prod. En production, sans 'true'
  //   explicite, l'ecoute est techniquement IMPOSSIBLE (AudioMonitoringGuard
  //   garde-fou #2). Defaut 'false' (OFF) — lecture via
  //   config.get('AUDIO_MONITORING_ENABLED',{infer:true})==='true'.
  // AUDIO_RETENTION_DAYS : retention des clips audio (garde-fou #8, DIFFEREE).
  //   Audit de la commande = conserve (legal) ; le clip est court.
  AUDIO_MONITORING_ENABLED: z.string().default('false'),
  // AUDIO_SUPERADMIN_ENABLED : phase de test interne (Sprint 4). En production,
  //   le super-admin (prestataire) ne declenche PAS d'ecoute PAR DEFAUT (garde-fou
  //   #3). Poser 'true' l'autorise EXPLICITEMENT pour la phase de test — reversible
  //   d'un flag. Defaut 'false' (OFF). Lecture via
  //   config.get('AUDIO_SUPERADMIN_ENABLED',{infer:true})==='true'.
  AUDIO_SUPERADMIN_ENABLED: z.string().default('false'),
  AUDIO_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  // AUDIO_DEVICE_PASSWORD : mot de passe boitier Coban/Baanool pour l'armement du
  //   micro. ARM = SMS `monitor<password>` (le boitier ouvre son micro), DISARM =
  //   SMS `tracker<password>` (retour mode tracking). Convention 123456 par defaut
  //   (meme que stop123456/resume123456 du coupe-circuit). Lecture via
  //   config.get('AUDIO_DEVICE_PASSWORD',{infer:true}).
  AUDIO_DEVICE_PASSWORD: z.string().default('123456'),
  // AUDIO_AUTO_DISARM_MINUTES : filet de securite. Le mode monitor COUPE le report
  //   de position GPS — un vehicule laisse arme « disparait » de la carte. Un cron
  //   desarme automatiquement (SMS `tracker<password>`) toute ecoute SENT non desarmee
  //   plus vieille que cette fenetre. Defaut 5 min. DB-driven (survit aux redemarrages).
  AUDIO_AUTO_DISARM_MINUTES: z.coerce.number().int().positive().default(5),
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
