# Phase 7 — Passerelle SMS (Twilio) pour recovery tracker offline

**Objectif** : permettre d'envoyer les commandes Coban en SMS au numéro de la SIM du tracker, et parser les SMS de retour, quand le tracker n'est pas joignable en TCP (GPRS coupé, config initiale, reset après factory).

**Durée estimée** : 2–3 jours de dev.

**Prérequis** : Phase 6 livrée (catalog de commandes réutilisé en SMS).

---

## 7.0 Pré-requis critique à valider AVANT de coder

⚠️ **Point bloquant à tester en amont sur un compte Twilio trial** :

Les trackers Coban 403C envoient/reçoivent des SMS sur la SIM insérée. Avant de coder, valider sur un compte Twilio trial :

1. **Achat d'un numéro Twilio capable d'écrire vers les pays cibles** → [Twilio SMS geo permissions](https://www.twilio.com/console/sms/settings/geo-permissions). Certains pays sont "High risk" par défaut, à activer manuellement dans la console.
2. **Réception de SMS inbound** depuis la SIM opérateur du tracker vers le numéro Twilio → Twilio ne garantit pas tous les senders internationaux. À tester en vrai.
3. **Alternative si Twilio bloque** : [MessageBird](https://messagebird.com/) ou [Vonage](https://www.vonage.com/communications-apis/messages/) ont des couvertures différentes. Budget à prévoir : ~0.05–0.08€ par SMS envoyé.
4. **Alternative pragmatique V1** : SMS Gateway Android (vieux smartphone + app [SMS Gateway](https://sms-gate.app/) + SIM locale → webhook sur l'API). Coût = forfait SMS de la SIM, pas par message. À reconsidérer si le provider cloud pose problème.

**Action avant le kickoff code** : faire un test trial 5€ avec 2 SMS de validation bidirectionnel (outbound API → tracker, inbound tracker → webhook).

---

## 7.1 Architecture SMS

```
┌────────────────────┐         ┌────────────────┐
│   Tracker Coban    │  SMS    │  SIM Twilio /  │
│   403C             │◄────────┤   Provider     │
└─────────┬──────────┘         └───────┬────────┘
          │                             │
          │ SMS sortant                 │ Webhook HTTPS
          │ (ACK commande)              │ POST /sms/inbound
          ▼                             ▼
┌────────────────────────────────────────────┐
│       API Tracky (NestJS)                  │
│  ┌────────────────┐  ┌──────────────────┐  │
│  │ SmsProvider    │  │ SmsCommands      │  │
│  │ (Twilio client)│  │ Service          │  │
│  └────────┬───────┘  └────────┬─────────┘  │
│           │                   │            │
│           ▼                   ▼            │
│  ┌────────────────────────────────────┐    │
│  │ tracker_sms_commands (Prisma)      │    │
│  └────────────────────────────────────┘    │
└────────────────────────────────────────────┘
```

Le `TrackerCommandsService` de la phase 6 est enrichi d'un paramètre `channel: 'tcp' | 'sms' | 'auto'`. En mode `auto`, il essaie TCP d'abord, fallback SMS si offline ET le template le supporte (`availableVia.includes('sms')`).

---

## 7.2 Sous-phase 7.1 — Enrichir le modèle Prisma

Ajouter à `Tracker` :

```prisma
model Tracker {
  // ... champs existants
  phoneNumber String? @unique  // format E.164, ex: +33600000000
  simProvider String?          // label libre, ex: 'ORANGE', 'TWILIO_TEST'
  simCountry  String?          // ISO 3166-1 alpha-2
  // ...
}
```

Le numéro est saisi à la création/assignation du tracker dans l'UI (onglet "Tracker" de la fiche véhicule).

Réutiliser `TrackerCommand` (déjà doté d'un champ `channel` en phase 6). **Décision** : ne pas dupliquer, la différence est uniquement dans le dispatcher.

Ajouter table dédiée pour les **SMS bruts** inbound/outbound (audit indépendant, utile pour debug Twilio) :

```prisma
enum SmsDirection {
  INBOUND
  OUTBOUND
}

enum SmsStatus {
  QUEUED
  SENT
  DELIVERED
  FAILED
  RECEIVED
}

model SmsLog {
  id                String       @id @default(uuid()) @db.Uuid
  direction         SmsDirection
  fromNumber        String
  toNumber          String
  body              String
  status            SmsStatus
  providerMessageId String?      // Twilio SID
  providerError     String?
  cost              Decimal?     @db.Decimal(10, 5)
  costCurrency      String?
  trackerCommandId  String?      @db.Uuid
  trackerCommand    TrackerCommand? @relation(fields: [trackerCommandId], references: [id], onDelete: SetNull)
  trackerId         String?      @db.Uuid
  tracker           Tracker?     @relation(fields: [trackerId], references: [id], onDelete: SetNull)
  rawPayload        Json?        // webhook payload Twilio complet
  receivedAt        DateTime     @default(now())

  @@index([trackerId, receivedAt(sort: Desc)])
  @@index([providerMessageId])
  @@map("sms_logs")
}
```

---

## 7.3 Sous-phase 7.2 — Provider abstraction

**Fichier** : `apps/api/src/sms/providers/sms-provider.interface.ts`

```ts
export interface SmsProvider {
  send(to: string, body: string): Promise<SmsProviderResult>;
  verifyWebhookSignature(req: Request): boolean;
  parseInboundWebhook(body: unknown): ParsedInboundSms;
}

export interface SmsProviderResult {
  providerMessageId: string;
  status: 'queued' | 'sent' | 'failed';
  error?: string;
  cost?: { amount: number; currency: string };
}

export interface ParsedInboundSms {
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
  receivedAt: Date;
}
```

Implémentations à livrer :

- `TwilioProvider` (prod) — utilise `twilio` npm package, `accountSid + authToken + fromNumber` via `ConfigService`
- `MockProvider` (dev / tests) — persist en DB, loggue, permet de simuler un inbound avec un endpoint admin `POST /sms/mock/inbound` (désactivé en prod)

Sélection via `SMS_PROVIDER=twilio|mock` dans `.env`.

---

## 7.4 Sous-phase 7.3 — `SmsCommandsService`

**Fichier** : `apps/api/src/sms/sms-commands.service.ts`

Méthodes :

- `dispatchViaSms(command: TrackerCommand)` :
  1. Load tracker → vérifier `phoneNumber` non null
  2. `buildPayload` depuis catalog (identique TCP sauf que certaines commandes ont une forme SMS différente : `reset123456` au lieu de `reset<IMEI>`)
  3. `provider.send(phoneNumber, payload)` → créer `SmsLog` OUTBOUND
  4. Update `TrackerCommand.status = SENT, sentAt`
  5. Pas de `waitForAck` synchrone : l'ACK arrive en SMS inbound via webhook, matché async (voir 7.5)
- `handleInboundSms(parsed: ParsedInboundSms)` :
  1. Créer `SmsLog` INBOUND
  2. Résoudre tracker par `fromNumber` → si inconnu, logguer et ignorer
  3. Chercher `TrackerCommand` récent (< 5 min) pour ce tracker, status `SENT`, channel `SMS`, dont `expectedAckPattern.test(body)` = true
  4. Si match : update `ACKNOWLEDGED, ackedAt, ackResponse = body` + lier `SmsLog.trackerCommandId`
  5. Sinon : laisser le SMS orphelin (visible dans le SmsLog admin) — peut être un SMS non sollicité (ex : SOS du tracker si config SMS activée)
  6. Émettre event WS `command:updated` ou `sms:received`

---

## 7.5 Sous-phase 7.4 — Controller webhook + controller admin

**Fichier** : `apps/api/src/sms/sms.controller.ts`

```
POST /sms/webhook/inbound       # appelé par Twilio, signature HMAC vérifiée
GET  /sms/logs                  # liste paginée pour admin (SUPER_ADMIN only)
GET  /sms/logs/:id              # détail
POST /sms/mock/inbound          # dev only, simule un inbound
```

Sécurité webhook :
- Route hors `AuthGuard`
- Mais obligatoirement derrière `@UseGuards(TwilioWebhookGuard)` qui vérifie la signature `X-Twilio-Signature` contre `authToken`
- Rate limit 100 req/min par IP

---

## 7.6 Sous-phase 7.5 — Intégration dans `TrackerCommandsService`

Modifier le `dispatch` de phase 6 :

```ts
async dispatch(command: TrackerCommand) {
  if (command.channel === 'TCP') {
    return this.dispatchViaTcp(command);
  }
  if (command.channel === 'SMS') {
    return this.smsCommands.dispatchViaSms(command);
  }
  if (command.channel === 'AUTO') {
    const online = this.socketRegistry.has(command.tracker.imei);
    const template = catalog[command.templateId];
    if (online && template.availableVia.includes('tcp')) {
      return this.dispatchViaTcp(command);
    }
    if (template.availableVia.includes('sms') && command.tracker.phoneNumber) {
      return this.smsCommands.dispatchViaSms(command);
    }
    throw new ServiceUnavailableException(
      'Tracker offline et SMS indisponible (pas de numéro ou template incompatible)'
    );
  }
}
```

---

## 7.7 Sous-phase 7.6 — UI Angular

Dans `CommandsPanelComponent` de phase 6 :

1. Ajouter un sélecteur de **canal** : `[ Auto | TCP | SMS ]` (Auto par défaut)
2. Si tracker offline → badge "Offline — SMS recommandé" et pré-sélection SMS
3. Si template pas dispo en SMS → griser l'option SMS
4. Warning coût : "Envoi SMS via Twilio — coût ~0.08€ par message" (configurable)
5. Dans l'historique : colonne "Canal" avec icône 📡 TCP / 📨 SMS

Nouvelle page **admin** `/admin/sms-logs` (SUPER_ADMIN only) :
- Liste paginée de tous les SMS inbound/outbound
- Filtres : direction, status, provider, date, tracker
- Détail : payload webhook brut + status + erreur

---

## 7.8 Sous-phase 7.7 — Monitoring & sécurité

- **Throttling** agressif sur envoi SMS : max 5 SMS/heure par tracker, max 50 SMS/jour par fleet (configurable via `.env`). Dépassement → `TooManyRequestsException`.
- **Whitelist numéros destination** en dev/staging : ne peut envoyer que vers les numéros déclarés dans `SMS_ALLOWED_NUMBERS` (évite blast en test).
- **Alerte** si budget SMS mensuel dépasse un seuil (cron daily, lit `SUM(cost)` du mois, compare à `SMS_MONTHLY_BUDGET`).
- **Audit** : chaque envoi SMS créé par un user → entry dans audit trail (qui, quand, vers quel tracker, coût estimé).
- **Secrets** : `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` dans `.env`, jamais loggués.

---

## 7.9 Livrables phase 7

- [ ] Provider abstraction + Twilio impl + Mock impl
- [ ] `SmsLog` + migration
- [ ] Champ `phoneNumber` sur `Tracker` + migration + UI edit
- [ ] `SmsCommandsService` + controller + webhook guard
- [ ] Intégration `dispatch` avec canal `AUTO`
- [ ] UI sélecteur canal + page admin SMS logs
- [ ] Throttling + whitelist dev + audit
- [ ] 15+ tests unitaires (provider mock, parsing inbound, matching ACK, throttling)
- [ ] E2E avec un vrai tracker sur banc : `status` en SMS, ACK parsé, matching correct
- [ ] Doc `docs/sms-gateway-setup.md` : setup Twilio pas à pas, activation pays cibles, budget recommandé
- [ ] Mise à jour `docs/04-roadmap.md`

---

## 7.10 Risques et mitigations

| Risque | Mitigation |
|---|---|
| Twilio inbound ne fonctionne pas sur un pays cible | Fallback MessageBird / SMS Gateway Android, testé avant de coder |
| Coût SMS explose | Throttling + budget alerting + whitelist dev |
| Webhook Twilio non sécurisé | `TwilioWebhookGuard` avec signature HMAC obligatoire |
| ACK SMS matche mauvaise commande (2 commandes pending) | Fenêtre 5 min + match le plus récent + si ambiguïté → logger warning et laisser orphelin |
| SMS inbound d'un tracker non enregistré | Ignorer + log, pas d'erreur |
| Tracker envoie du SOS en SMS | Mapping dédié → créer une `Alert` SOS (hors de ce scope, noter en TODO) |
