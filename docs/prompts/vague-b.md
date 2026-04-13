# Prompt Claude Code — Vague B (Phase 7 SMS)

> **Ne lancer qu'après :**
> 1. Vague A livrée et mergée
> 2. Bench 403C validé (rapport `docs/bench-403c-report.md` existant)
> 3. Test Twilio trial effectué (outbound + inbound validés sur SIM tracker)
>
> Ajuster le prompt si le bench 403C a révélé des divergences impactant les commandes SMS.

---

```
Mission : implémenter la Phase 7 (SMS Gateway via Twilio) complète, en un seul sprint,
sans points de validation intermédiaires.

AVANT DE CODER : lire dans cet ordre

1. docs/EXECUTION-TRACKER.md (état à jour)
2. docs/07-sms-gateway.md (roadmap Phase 7)
3. docs/bench-403c-report.md (divergences hardware observées)
4. packages/shared/src/protocol/coban.catalog.ts (catalog livré Vague A)
5. apps/api/src/tracker-commands/ (service + controller livrés Vague A)
6. apps/api/src/observability/ (logs livrés Vague A)
7. apps/api/prisma/schema.prisma (modèle TrackerCommand livré Vague A)

DÉCISIONS ARCHITECTURE (figées)

- Réutilisation du modèle TrackerCommand livré Vague A (champ `channel`)
  — NE PAS créer un modèle SmsCommand distinct
- SmsLog : table d'audit indépendante pour les SMS bruts (debug provider)
- Provider abstraction : interface SmsProvider + 2 impls (TwilioProvider,
  MockProvider) switchables via .env SMS_PROVIDER
- Matching ACK inbound : fenêtre 5 min, pattern du catalog, tracker résolu
  par phoneNumber
- Mode AUTO dans dispatch : TCP d'abord si online, fallback SMS si offline
  ET template availableVia.includes('sms')
- Webhook Twilio : guard HMAC obligatoire, route hors AuthGuard
- Throttling strict : 5 SMS/h par tracker, 50 SMS/j par flotte (valeurs .env)
- Whitelist dev/staging : SMS_ALLOWED_NUMBERS obligatoire hors prod

DÉCISIONS NAMING

- Module : SmsModule (isole Twilio de TrackerCommands)
- Service : SmsCommandsService + SmsProvidersService
- Guard : TwilioWebhookGuard
- Route webhook : POST /sms/webhook/inbound
- Route admin : GET /admin/sms-logs (+ /:id)
- WS event : tracker-command:updated (réutilisé Vague A, pas de nouveau)

NOUVELLE LIB AUTORISÉE

- `twilio` (SDK officiel)
Aucune autre. Si besoin d'autre chose : STOP et demander.

ORDRE DE LIVRAISON STRICT

1. Phase 7.1 — Prisma : phoneNumber sur Tracker + SmsLog model
   → migration générée et appliquée
   → commit "feat(api): tracker phone number and sms log model"

2. Phase 7.2 — Provider abstraction + TwilioProvider + MockProvider
   → tests verts sur MockProvider
   → doc inline des env vars Twilio requises
   → commit "feat(api): sms provider abstraction with twilio and mock impl"

3. Phase 7.3 — SmsCommandsService
   → dispatchViaSms + handleInboundSms avec matching ACK 5 min
   → WireLogger intégré sur chaque send/receive
   → 10+ tests
   → commit "feat(api): sms commands service with inbound matching"

4. Phase 7.4 — Webhook controller + TwilioWebhookGuard + admin endpoints
   → TwilioWebhookGuard : vérif signature HMAC obligatoire
   → Rate limit 100 req/min par IP sur le webhook
   → GET /admin/sms-logs (SUPER_ADMIN)
   → POST /sms/mock/inbound (dev only, protégé par NODE_ENV)
   → commit "feat(api): sms webhook guard and admin endpoints"

5. Phase 7.5 — Intégration dispatch TCP/SMS/AUTO
   → Modifier TrackerCommandsService.dispatch() pour router selon channel
   → Mode AUTO : essaie TCP si online + availableVia TCP, fallback SMS
   → Update tests existants TrackerCommands pour couvrir les 3 channels
   → commit "feat(api): auto channel routing for tracker commands"

6. Phase 7.6 — Angular UI
   → Channel selector dans CommandsPanel (Auto / TCP / SMS)
   → Badge "Tracker offline — SMS recommandé" quand applicable
   → Warning coût configurable via env SMS_COST_DISPLAY
   → Page /admin/sms-logs avec filtres direction/status/period/tracker
   → Icônes 📡 TCP / 📨 SMS dans l'historique
   → commit "feat(web): sms channel selector and admin logs page"

7. Phase 7.7 — Sécurité & monitoring
   → Throttling provider-level (5/h par tracker, 50/j par flotte)
   → Whitelist SMS_ALLOWED_NUMBERS en dev/staging (bloque envoi si absent)
   → Cron daily : somme coût du mois, compare SMS_MONTHLY_BUDGET, log WARN
   → Audit trail : entry ErrorLog info-level pour chaque envoi
   → 15+ tests cumulés
   → commit "feat(api): sms throttling, whitelist and budget alerting"

8. Mise à jour docs/04-roadmap.md et docs/EXECUTION-TRACKER.md
   → commit "docs: phase 7 sms gateway completion"

CONTRAINTES PERMANENTES

- TypeScript strict, zéro any non justifié
- NE JAMAIS toucher EngineControlModule
- NE JAMAIS modifier les commits de la Vague A
- NE JAMAIS logguer les secrets Twilio (AUTH_TOKEN, API_KEY)
- Redaction automatique dans pino : ajouter 'req.headers.authorization',
  '*.authToken', '*.apiKey', 'accountSid' dans la config redact
- Tests existants (Vague A + antérieurs) doivent rester verts à chaque commit
- Labels UI en français, code et commits en anglais
- Chaque commit auto-suffisant et build vert

VARIABLES D'ENV À DOCUMENTER

Ajouter dans apps/api/.env.example :

SMS_PROVIDER=mock               # 'twilio' | 'mock'
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
TWILIO_WEBHOOK_URL=             # pour vérifier signature
SMS_ALLOWED_NUMBERS=            # CSV E.164, obligatoire hors NODE_ENV=production
SMS_THROTTLE_PER_TRACKER_HOUR=5
SMS_THROTTLE_PER_FLEET_DAY=50
SMS_MONTHLY_BUDGET=20           # EUR, pour alerting
SMS_COST_DISPLAY=0.08           # EUR par SMS, affiché en UI

LOGS CRITIQUES À CAPTURER

1. SMS outbound : log INFO { commandId, imei, toNumber (masqué dernier 4),
   body, providerMessageId, cost }
2. SMS inbound reçu : log INFO { fromNumber (masqué), body, matched commandId
   ou null, providerMessageId }
3. Webhook signature invalide : log WARN + ErrorLog CRITICAL (surface
   d'attaque)
4. Throttle hit : log WARN { userId, trackerId, limit }
5. Budget dépassé : log WARN + entry admin visible

LIVRAISON FINALE

Produis un message récap avec :
- Commits dans l'ordre avec hash
- Nombre de tests ajoutés par module
- Captures de logs pour les 5 cas ci-dessus
- Checklist Phase 7 dans EXECUTION-TRACKER.md mise à jour
- Instructions manuelles à suivre pour valider en staging :
  * Inscrire un numéro dans SMS_ALLOWED_NUMBERS
  * Configurer webhook Twilio en pointant sur /sms/webhook/inbound
  * Envoyer une commande SMS depuis UI → vérifier SMS reçu sur tracker
  * Répondre SMS manuellement depuis tracker → vérifier matching ACK
- Points d'attention pour l'activation prod (budget, geo permissions Twilio)

STOP et demander si :
- Une divergence 403C impacte le format SMS (commandes ne répondent pas comme
  attendu selon le rapport bench)
- La signature du webhook Twilio ne peut pas être vérifiée (secret manquant
  dans .env)
- Un test d'intégration Twilio trial n'est pas documenté dans EXECUTION-TRACKER

GO.
```

---

## Après le retour de Claude Code

1. Review branche, `pnpm test` vert
2. Tests manuels en staging :
   - Webhook Twilio configuré et joignable
   - SMS outbound envoyé vers numéro whitelist → reçu physiquement
   - SMS inbound depuis tracker → matché à une commande
   - Throttle hit visible
   - Page /admin/sms-logs fonctionnelle
3. Merger sur main
4. Mettre à jour `docs/EXECUTION-TRACKER.md` :
   - Cases Phase 7 ✅
   - Progress bar Vague B → 100 %
   - Ligne journal session
5. Tracky V1 canal hardware = COMPLET 🎉
