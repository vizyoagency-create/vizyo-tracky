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

  // Sonde active des dependances (DependencyHeartbeatService). URL PUBLIQUES a
  // sonder — elles doivent traverser Traefik/TLS, sinon la sonde ne verrait pas
  // une panne de ROUTAGE (le cas exact de la coupure Vizyo Auth du 18-21/07 :
  // conteneur sain, route morte). Vides => repli sur VIZYO_AUTH_API_URL /
  // VIZYO_TEXTO_URL, avec un avertissement au demarrage si l'URL est interne.
  // ⚠️ En prod VIZYO_AUTH_API_URL vaut http://vizyo-auth-api:3200 (interne) :
  // DEPENDENCY_PROBE_AUTH_URL est donc NECESSAIRE pour que la sonde serve.
  DEPENDENCY_PROBE_AUTH_URL: z.string().default(''),
  DEPENDENCY_PROBE_TEXTO_URL: z.string().default(''),

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

  // URL absolue du logo PNG des e-mails. Gmail/Outlook/Yahoo suppriment le SVG
  // inline → le logo doit etre une image hebergee. Servi par la LP
  // (lp/public/email/vizyo-logo.png). Override possible en prod si le domaine differe.
  EMAIL_LOGO_URL: z.string().default('https://tracky.vizyoagency.com/email/vizyo-logo.png'),

  // Secret du webhook Resend (Svix, format 'whsec_…'). Sert a verifier la signature
  // des events entrants (delivered/opened/clicked/bounced/complained) sur /api/email/webhook.
  // Si vide : en production le webhook REJETTE tout (fail-closed) ; en dev on tolere.
  RESEND_WEBHOOK_SECRET: z.string().default(''),

  // Facturation (Stripe) — 2026-07. Si STRIPE_SECRET_KEY est vide, le module billing est DESACTIVE
  // (no-op, comme Resend) : l'app tourne sans facturation, l'IA reste pilotee par le toggle
  // super-admin (COMP). Cle secrete serveur (sk_test_… / sk_live_…).
  STRIPE_SECRET_KEY: z.string().default(''),
  // Cle publiable (pk_test_… / pk_live_…) — NON secrete, exposee au front pour Stripe.js.
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),
  // Secret de signature du webhook Stripe (whsec_…) pour verifier /api/billing/webhook.
  // Vide : en production le webhook REJETTE tout (fail-closed) ; en dev on tolere.
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

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

  // Retention donnees — purge auto nocturne (3h30), cf. DataRetentionService.
  // SAMPLING_DECISIONS_RETENTION_DAYS : audit-trail du sampling. Defaut 7j. 0 => desactive.
  // --- Retention des positions GPS — CIBLE CNIL 60 JOURS (lot 1, 21/07/2026) ---
  // POSITIONS_RETENTION_DAYS : fenetre ACTIVE (jours). Defaut 60 (recommandation CNIL ~2 mois
  //   pour la geolocalisation fine). 0 => retention infinie = TOUT desactive (ni snapshot ni
  //   suppression) : c'est l'ARRET D'URGENCE, y compris en production.
  // POSITIONS_ARCHIVE_DAYS : preavis/archive recuperable AU-DELA de la fenetre active, avant
  //   suppression. Defaut 0 : on garde 60 jours, au-dela c'est supprime (decision 21/07).
  // POSITIONS_PURGE_ENABLED : armement de la SUPPRESSION REELLE (par lots de 10k bornes).
  //   Defaut 'true'. EN PRODUCTION le drapeau ne peut PAS desactiver la purge (cf.
  //   resolvePurgeArmed) : desactivable en developpement/test uniquement.
  // Garde-fou commun : toute fenetre effective < 30 j fait ECHOUER le job (retention-guard.ts).
  SAMPLING_DECISIONS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(7),
  POSITIONS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(60),
  // RGPD — retention des TRAJETS (mois). 0 = desactive. Meme regle d'armement que les positions
  // (production = toujours arme). La purge emporte aussi TripAnalysis + TripFuelStop des trajets
  // purges (narratifs de localisation — pas de FK en base, nettoyage explicite).
  TRIPS_RETENTION_MONTHS: z.coerce.number().int().nonnegative().default(12),
  TRIPS_PURGE_ENABLED: z.string().default('true'),
  POSITIONS_ARCHIVE_DAYS: z.coerce.number().int().nonnegative().default(0),
  POSITIONS_PURGE_ENABLED: z.string().default('true'),
  // RGPD — retention des JOURNAUX SMS (sms_logs : numeros + contenu = donnees personnelles).
  // Purgee par LogCleanupService (cron 3h00). Defaut 90 j. 0 = desactive.
  SMS_LOGS_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  // Retention des logs (LogCleanupService, cron 3h00) — env-configurables pour
  // ajuster sans redeploy. WIRE_LOGS = trames brutes (volumineux : 1 ligne/trame),
  // ERROR_LOGS = erreurs applicatives.
  WIRE_LOGS_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  ERROR_LOGS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // MUTATION_AUDIT : lignes system_activity_logs categorie MUTATION (audit des
  // mutations HTTP attribuees par utilisateur) — conservees plus longtemps que le
  // reste du journal systeme (valeur d'audit).
  MUTATION_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),

  // Sprint 4 — Écoute audio à distance (micro vehicule), LEGALEMENT SENSIBLE.
  // AUDIO_MONITORING_ENABLED : interrupteur prod. En production, sans 'true'
  //   explicite, l'ecoute est techniquement IMPOSSIBLE (AudioMonitoringGuard
  //   garde-fou #2). Defaut 'false' (OFF) — lecture via
  //   config.get('AUDIO_MONITORING_ENABLED',{infer:true})==='true'.
  // (Il n'y a PAS de retention de clip audio : AUCUN clip n'est recu ni stocke par le serveur —
  //  l'ecoute est un appel telephonique du boitier vers un numero autorise. Voir
  //  docs/rgpd-retention-donnees.md et audio-monitoring.service.ts. L'ancienne variable morte
  //  AUDIO_RETENTION_DAYS a ete retiree le 21/07/2026 : elle n'etait lue par aucun job.)
  AUDIO_MONITORING_ENABLED: z.string().default('false'),
  // AUDIO_SUPERADMIN_ENABLED : phase de test interne (Sprint 4). En production,
  //   le super-admin (prestataire) ne declenche PAS d'ecoute PAR DEFAUT (garde-fou
  //   #3). Poser 'true' l'autorise EXPLICITEMENT pour la phase de test — reversible
  //   d'un flag. Defaut 'false' (OFF). Lecture via
  //   config.get('AUDIO_SUPERADMIN_ENABLED',{infer:true})==='true'.
  AUDIO_SUPERADMIN_ENABLED: z.string().default('false'),
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

  // Sprint 9 — Copilote IA d'optimisation (Claude). Si ANTHROPIC_API_KEY est vide,
  // les endpoints /ai/* renvoient 503 (le reste de l'app tourne). A tester d'abord
  // en Console Anthropic ; lue cote serveur via process.env, jamais loggee.
  ANTHROPIC_API_KEY: z.string().default(''),

  // Couche IA multi-provider (2026-07) — moteur GPT (OpenAI Responses API). Si OPENAI_API_KEY est
  // vide, le provider 'gpt' est indisponible (le routeur retombe sur Claude si sélectionné). Modèle
  // par défaut surchargeable (OPENAI_MODEL, ex. gpt-4.1 / gpt-4.1-mini / gpt-4o). Lue via process.env.
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default(''),

  // ─── Integration partenaire (Tracky x Maestroo) — lot 0 ────────────────────
  // KILL-SWITCH DE DEPLOIEMENT : a false, TOUT le module partenaire est inerte
  // (routes montees mais qui repondent 404). Le code peut donc partir en prod et
  // etre verifie sans qu'aucun lien ne soit creable. Default false = on n'active
  // JAMAIS par accident.
  PARTNER_MAESTROO_ENABLED: z.string().default('false'),
  // Base de l'API Maestroo, appelee serveur-a-serveur pendant le handshake.
  PARTNER_MAESTROO_API_URL: z.string().default(''),
  // Secret d'AMORCAGE de la confiance, partage entre les deux DEPLOIEMENTS (pas
  // par client). Il ne sert QU'au handshake et aux webhooks ; chaque lien a
  // ensuite son propre secret. Vide = le module refuse de servir (fail-closed,
  // cf. verifyPartnerRequest qui rejette tout sur un secret vide).
  PARTNER_PLATFORM_SECRET: z.string().default(''),
  // Duree de vie du bail (jeton opaque). Courte VOLONTAIREMENT : c'est le filet
  // de securite si la purge Redis echoue a la revocation.
  PARTNER_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
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
