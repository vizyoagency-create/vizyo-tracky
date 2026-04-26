# 13 — Roadmap V1.5 Finition (production-ready avant clients payants)

> **Statut :** Draft — 2026-04-26
> **Perimetre :** consolidation de toutes les taches restantes pour atteindre un produit production-ready, vendable et exploitable a echelle (5-50 clients) sans intervention manuelle. Sequence 7 sprints (I-O).
> **Source :** demande utilisateur 2026-04-26 — apres livraison V1.4 (correctifs urgents) et V1.5 partielle (tracking adaptatif H1-H5).
> **Pre-requis :** branches `feat/roadmap-v1.4-correctifs` (V1.4 livre) + `worktree-tracking-adaptatif` (V1.5 H1-H5 livre, en attente de merge).

---

## 0. Synthese executive

### 0.1 Tableau des sprints

| Sprint | Chantier | Severite | Effort | Pourquoi maintenant |
| --- | --- | --- | --- | --- |
| **I** | SMS Gateway + Backup auto | 🔴 Critique | ~16h | Debloque le fallback fix mode (H3) + automatise les sauvegardes prod |
| **J** | Onboarding UX (wizard + email + Mon compte) | 🔴 Critique | ~10h | Indispensable pour onboarder un nouveau client < 30min |
| **K** | Scheduling horaire V2 | 🟠 Eleve | ~14h | Multi-plages + jours feries necessaires pour les pros (livraison taxi, transport) |
| **L** | Rapports & export | 🟠 Eleve | ~13h | PDF/CSV demandes par les gestionnaires de flotte |
| **M** | Alertes avancees (push/email/WhatsApp + escalade) | 🟠 Eleve | ~15h | Etre prevenu hors-app = differentiateur majeur |
| **N** | Geofences V2 (alertes par vehicule, corridors, GeoJSON) | 🟢 Moyen | ~8h | Complete les fondations geofences V1 |
| **O** | Tests qualite (coverage + integration + E2E Playwright) | 🟢 Moyen | ~10h | Filet de securite avant mise en production a l'echelle |

**Total : ~86h (~10-11 jours dev)**

### 0.2 Decisions actees (2026-04-26)

| # | Sujet | Decision | Justification |
| - | --- | --- | --- |
| 1 | CI/CD GitHub Actions | ❌ Reporte | User prefere deployer a la main pendant la phase d'iteration rapide. Re-evaluer apres V1.5. |
| 2 | Landing page Next.js | ❌ Hors scope | LP HTML statique deja deployee (`tracky.vizyoagency.com`) et fonctionnelle. Pas de gain a la porter en Next.js maintenant. |
| 3 | SMS Gateway | ✅ SUPER_ADMIN seulement | Les FLEET_ADMIN n'ont pas besoin d'acces direct aux SMS. Simplifie la UI + reduit la surface d'attaque. |
| 4 | Priorite basse V2 §3 (mobile, Stripe, scaling, conformite) | ⏸ Differe | Re-evaluer quand 5+ clients payants. |

---

## 1. Sprint I — SMS Gateway + Backup auto (Critique, ~16h)

### 1.1 Objectifs

1. Permettre au SUPER_ADMIN de provisionner un tracker neuf sans acces physique au boitier (sequence SMS Coban automatisee).
2. Debloquer le **fallback SMS du fix mode adaptatif** (Sprint H3 §5.2-C) quand la socket TCP est indisponible > 5 min.
3. Automatiser les sauvegardes Postgres en prod (cron + offsite + alerte si echec).

### 1.2 Architecture SMS

**Provider :** Twilio (decision §0.3 ; alternatives MessageBird / Android Gateway differees).

**Endpoints API (SUPER_ADMIN only via `@Roles(UserRole.SUPER_ADMIN)`) :**

| Methode | Route | Action |
| --- | --- | --- |
| POST | `/api/sms/send` | Envoi SMS arbitraire (debug, override) |
| POST | `/api/sms/provision-tracker` | Sequence init 9 SMS automatisee pour un IMEI |
| GET | `/api/sms/history` | Historique des SMS sortants/entrants |
| POST | `/api/sms/webhook` | Callback Twilio inbound (replies du boitier) |

**Sequence init Coban (cf. [03-protocol-coban-gps403d.md §5.7](docs/03-protocol-coban-gps403d.md)) :**

```
1. begin123456                 → reset config
2. apn123456 <APN>             → APN GPRS
3. apnuser123456 <USER>        → user APN (souvent vide)
4. apnpasswd123456 <PASSWD>    → password APN (souvent vide)
5. adminip123456 <IP> 5001     → IP serveur Tracky + port TCP
6. gprs123456                  → activer GPRS
7. fix030s***n123456           → reporting 30s en mouvement
8. acc123456 on                → activation alarme ACC
9. lowbattery123456 <PHONE> on → alarme batterie faible

Timeout entre chaque SMS : 30s
ACK attendu sur chaque : "ok 123456"
```

### 1.3 Fallback fix mode

Etendre `TrackerFixModeService.requestChange()` ([apps/api/src/tracker-fix-mode/tracker-fix-mode.service.ts](apps/api/src/tracker-fix-mode/tracker-fix-mode.service.ts)) :

```ts
const sent = this.registry.send(tracker.imei, payload);
if (!sent) {
  // Tentative SMS si tracker offline > 5min
  const offlineMs = tracker.lastSeenAt
    ? Date.now() - tracker.lastSeenAt.getTime()
    : Infinity;
  if (offlineMs > 5 * 60 * 1000) {
    const smsSent = await this.smsService.sendCommand(tracker.imei, payload);
    if (smsSent) {
      // marquer la commande SENT via canal SMS
      await this.prisma.trackerCommand.update({
        where: { id: command.id },
        data: { status: 'SENT', sentAt: new Date(), channel: 'SMS' },
      });
      return { commandId: command.id };
    }
  }
  // Sinon FAILED comme avant
}
```

### 1.4 Backup auto Postgres

**Script :** etend `deploy/vps/backup-db.sh` existant + cron systemd timer.

**Cible :** S3 / Backblaze B2 (gratuit < 10 GB).

**Retention :** 30 jours rolling.

**Alerting :** si le backup echoue 2 jours d'affilee → record dans `error_logs` + bandeau dans `/admin/alerts` (centre d'alertes deja livre Sprint H3).

### 1.5 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| I.A | Compte Twilio + numero + variables env | 30min (manuel) |
| I.B | Module SMS NestJS (`SmsGatewayService` send/receive) | 3h |
| I.C | Sequence init 9 SMS automatisee (state machine + ACK wait) | 3h |
| I.D | UI provisionnement tracker (`/admin/sms/provision/:imei`) | 2h |
| I.E | Endpoint webhook Twilio inbound + parsing replies | 1h |
| I.F | Wirage fallback fix mode → SMS | 2h |
| I.G | Backup auto Postgres (script + systemd timer + S3 upload) | 2h |
| I.H | Alerting si backup rate (record `error_logs` + bandeau admin) | 1h |
| I.I | Tests E2E avec SIM reelle (boitier dans tiroir) | 1h30 |

**Total : ~16h**

### 1.6 Criteres d'acceptation

- [ ] Un SUPER_ADMIN peut provisionner un nouveau tracker via `/admin/sms/provision/:imei` en cliquant un seul bouton.
- [ ] Si le tracker est OFFLINE > 5min et qu'un fix mode change est demande, le serveur tente automatiquement par SMS.
- [ ] La FLEET_ADMIN ne voit PAS le menu SMS dans la sidebar (test RBAC).
- [ ] Un backup quotidien apparait dans le bucket S3 a 03:00 UTC.
- [ ] Si le backup rate, un bandeau rouge apparait dans `/admin/alerts` dans les 24h.

---

## 2. Sprint J — Onboarding UX (Critique, ~10h)

### 2.1 Objectifs

Permettre a un nouveau client (cree par le SUPER_ADMIN) de se connecter pour la premiere fois et d'etre operationnel en < 30 min, sans assistance.

### 2.2 Wizard premier login

Component Angular `OnboardingWizardComponent` declenche au premier login d'un FLEET_ADMIN :

| Etape | Contenu |
| --- | --- |
| 1. Bienvenue | Logo Tracky + presentation 3 lignes + bouton "Commencer" |
| 2. Profil | Email confirme + prenom/nom + telephone optionnel + photo de profil |
| 3. Premier vehicule | Plaque + type + marque/modele + association a un tracker (par IMEI) |
| 4. Premier user (optionnel) | Inviter un FLEET_MANAGER ou VIEWER par email |
| 5. Dashboard | Redirection vers `/dashboard` avec toast "Bienvenue Younes !" |

State persiste cote backend : `User.onboardingCompletedAt: DateTime?`. Skippe les etapes deja faites (ex: si un vehicule existe deja, etape 3 sautee).

### 2.3 Email invitation utilisateur

Provider : **Resend** (free tier 3000 emails/mois, simple API).

Template HTML (Tailwind via [@react-email](https://react.email/) ou manuel) :

```
Subject: [Vizyo Tracky] Vous etes invite a rejoindre <FleetName>

Bonjour <Prenom>,

<UserAdmin> vous a invite a rejoindre la flotte <FleetName> sur Vizyo Tracky
en tant que <Role>.

Cliquer le lien ci-dessous pour creer votre mot de passe :

  <BoutonAction>

Lien valide 24h. Si ce mail n'est pas pour vous, ignorez-le.

— L'equipe Vizyo
```

Backend : nouveau endpoint `POST /api/auth/invitations/accept?token=...` qui valide un JWT court (1h) + permet de set le password.

### 2.4 Page "Mon compte"

Route Angular `/account` :

| Section | Contenu |
| --- | --- |
| Profil | Email, prenom/nom, telephone, photo |
| Mot de passe | Ancien + nouveau + confirmation |
| Notifications | Toggles email / push / WhatsApp (lien chantier M) |
| Securite | Sessions actives + bouton "Se deconnecter partout" |
| Suppression | Bouton "Supprimer mon compte" (RGPD) avec confirmation 2x |

### 2.5 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| J.A | Migration Prisma `User.onboardingCompletedAt` + `User.phone`/`avatarUrl` | 30min |
| J.B | Component `OnboardingWizardComponent` 5 etapes + skip-logic | 3h |
| J.C | Setup Resend API + variables env + `EmailService` (NestJS) | 1h |
| J.D | Endpoint `POST /api/auth/invitations` (super-admin invite user) + email | 2h |
| J.E | Endpoint `POST /api/auth/invitations/accept` (set password depuis invitation) | 1h30 |
| J.F | Page Angular `/account` (profil + password + notif + securite + suppression) | 2h |

**Total : ~10h**

---

## 3. Sprint K — Scheduling horaire V2 (~14h)

### 3.1 Objectifs

Etendre le scheduler existant ([VehicleScheduleModule](apps/api/src/vehicle-schedules)) avec :

1. **Multi-plages par jour** : autoriser 2-3 fenetres par jour (ex: 08:00-12:00 + 14:00-18:00).
2. **Jours feries** par pays (calendrier configurable FR / MA), CUT auto le jour ferie.
3. **Dates speciales** : override ponctuel (ex: "le 24/12 ferme a 16:00").
4. **Notifications** : push/email a chaque CUT/RESTORE auto (depend chantier M).
5. **Timeline UI** : historique des transitions visualise dans la fiche vehicule.

### 3.2 Migration

```prisma
model VehicleSchedule {
  // Existant : mondayEnabled / mondayStart / mondayEnd ...
  // Ajout :
  mondaySlots    Json?   // [{ start: "08:00", end: "12:00" }, { start: "14:00", end: "18:00" }]
  // Idem tuesday...sunday
  countryCode    String  @default("FR")  // pour les jours feries
  customDates    Json?   // [{ date: "2026-12-24", slots: [...] }, { date: "2026-12-25", closed: true }]
}

model ScheduleHistory {
  id          String   @id
  vehicleId   String
  occurredAt  DateTime
  action      String   // 'CUT' | 'RESTORE'
  reason      String   // 'IN_WINDOW' | 'OUT_OF_WINDOW' | 'HOLIDAY' | 'CUSTOM_DATE'
  windowDesc  String?
  createdAt   DateTime @default(now())

  @@index([vehicleId, occurredAt(sort: Desc)])
}
```

### 3.3 Logique de calcul

Helper `evaluateSchedule(schedule, now)` retourne `IN_WINDOW | OUT_OF_WINDOW` en tenant compte de :

1. customDates pour `now.toISOString().slice(0, 10)` → priorite max
2. Sinon, verifier si `now` est un jour ferie (lib `date-holidays` pour FR/MA)
3. Sinon, evaluer les plages du jour de semaine (mondaySlots[] etc.)

### 3.4 Notifications

Hook dans `ScheduleCronService.transition()` : a chaque CUT/RESTORE auto, emit un event qui declenche (chantier M) un push + email vers le FLEET_ADMIN.

### 3.5 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| K.A | Migration Prisma (mondaySlots, countryCode, customDates, ScheduleHistory) | 1h |
| K.B | Lib `date-holidays` + helper `isHoliday(date, countryCode)` | 30min |
| K.C | Helper `evaluateSchedule(schedule, now)` 3 niveaux + tests | 3h |
| K.D | Migrer `ScheduleCronService` vers nouvelle logique | 2h |
| K.E | UI editeur multi-plages (input dynamique avec + add slot) | 3h |
| K.F | UI dates speciales (mini-calendrier picker) | 2h |
| K.G | Timeline UI (vehicle-detail tab "Horaires" → sub-tab "Historique") | 2h |
| K.H | Hook notifications (depend chantier M) — squelette | 30min |

**Total : ~14h**

---

## 4. Sprint L — Rapports & export (~13h)

### 4.1 Objectifs

1. **Export PDF** journalier / hebdo / mensuel — synthese KPI + carte trajets + liste alertes
2. **Export CSV** brut positions / trips / commandes (pour Excel)
3. **Email automatique** : rapport hebdo envoye lundi 08:00 au FLEET_ADMIN
4. **Dashboard KPI avance** : consommation estimee, km/jour, temps arret, taux d'occupation

### 4.2 Stack

- **PDF :** [puppeteer](https://pptr.dev/) headless Chromium pour rendre une page Angular en PDF (deja un dashboard existe). Avantage : style coherent.
- **CSV :** generation in-memory via `papaparse` + stream.
- **Email :** Resend (chantier J).
- **Cron :** `@Cron('0 8 * * 1')` lundi 08:00.

### 4.3 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| L.A | `ReportPdfService` (puppeteer) + template `/internal/report/:fleetId/:period` | 4h |
| L.B | Endpoint `GET /api/reports/pdf?period=week&from=...&to=...` | 1h |
| L.C | `ReportCsvService` (papaparse) positions / trips / commandes | 2h |
| L.D | Endpoints CSV `GET /api/reports/csv?type=positions&...` | 1h |
| L.E | Cron hebdo `@Cron('0 8 * * 1')` + email Resend | 2h |
| L.F | UI page rapports : selecteur periode + boutons download PDF/CSV | 1h30 |
| L.G | Dashboard KPI avance (consommation, km/j, taux occupation) | 1h30 |

**Total : ~13h**

---

## 5. Sprint M — Alertes avancees (~15h)

### 5.1 Objectifs

1. **Web Push API** : recevoir les alertes critiques meme onglet ferme.
2. **Email** : alerte par mail (en complement du toast in-app).
3. **WhatsApp** : alerte WhatsApp pour le SUPER_ADMIN ou contacts d'urgence.
4. **Regles personnalisables par vehicule** : ex "ne pas notifier OVERSPEED sur le vehicule de Marc".
5. **Escalade** : si une alerte CRITICAL n'est pas acquittee en 10 min, notifier N+1.

### 5.2 Stack

- **Web Push :** [web-push](https://github.com/web-push-libs/web-push) NestJS + service worker Angular + VAPID keys.
- **Email :** Resend (chantier J).
- **WhatsApp :** Twilio (chantier I) ou API Meta Cloud officielle (free tier).

### 5.3 Migration

```prisma
model NotificationChannel {
  id          String   @id
  userId      String
  channel     String   // 'WEB_PUSH' | 'EMAIL' | 'WHATSAPP'
  endpoint    String?  // push subscription / phone number
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
}

model AlertRule {
  id           String   @id
  fleetId      String
  vehicleId    String?  // null = toute la flotte
  alertType    String   // ex: 'OVERSPEED', '*' = tous
  enabled      Boolean
  channels     Json     // ['WEB_PUSH', 'EMAIL']
  escalateAfterMin Int?
  escalateTo   String?  // userId
}
```

### 5.4 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| M.A | Migration Prisma (NotificationChannel + AlertRule) | 1h |
| M.B | Setup VAPID keys + `WebPushService` + service worker Angular | 3h |
| M.C | UI subscription push (toggle dans /account) | 1h |
| M.D | Hook `AlertsService.create` → dispatch sur channels selon AlertRule | 3h |
| M.E | UI editeur regles d'alerte (table par fleet, par vehicule, par type) | 3h |
| M.F | Cron escalade (poll alertes CRITICAL non-ack > N min, notifier escalateTo) | 2h |
| M.G | Email + WhatsApp templates | 2h |

**Total : ~15h**

---

## 6. Sprint N — Geofences V2 (~8h)

### 6.1 Objectifs

1. **Alertes par vehicule** : aujourd'hui les violations sont globales fleet ; permettre de cibler "alerter seulement si vehicule X sort"
2. **Corridors** : geofence lineaire le long d'un trajet (camion qui doit suivre A6, alerte si devie)
3. **Import GeoJSON** : permettre d'uploader un fichier GeoJSON de zones (clients, depots, interdictions)

### 6.2 Migration

```prisma
model GeofenceVehicle {
  id          String   @id
  geofenceId  String
  vehicleId   String   // null implicite via lien : si pas de ligne, alerte globale
  // alertes appliquees seulement aux vehicules listes
}

// Etend Geofence existante :
model Geofence {
  // ... existant
  type            GeofenceType  // CIRCLE existant + POLYGON existant + CORRIDOR (nouveau)
  corridorPoints  Json?         // pour CORRIDOR : [{lat, lng}, ...] avec width meters
  corridorWidthM  Int?
}
```

### 6.3 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| N.A | Migration Prisma (GeofenceVehicle + corridor fields) | 30min |
| N.B | Helper `isInsideCorridor(point, polyline, widthM)` (distance perpendiculaire) + tests | 2h |
| N.C | Refactor `GeofencesService.checkViolations` pour filtrer par GeofenceVehicle | 1h30 |
| N.D | UI selection vehicules cibles dans editeur geofence | 1h |
| N.E | UI dessin corridor (polyligne sur carte + slider width) | 2h |
| N.F | Endpoint `POST /api/geofences/import-geojson` + UI upload | 1h |

**Total : ~8h**

---

## 7. Sprint O — Tests qualite (~10h)

### 7.1 Objectifs

Coverage minimum + tests d'integration + tests E2E navigateur — filet de securite avant la mise a l'echelle 5+ clients.

### 7.2 Cibles

| Type | Outil | Cible |
| --- | --- | --- |
| Unit | Jest (deja en place) | Statements >= 70%, branches >= 60% |
| Integration | Supertest + DB de test | Tous les endpoints critiques (auth, vehicles, engine-control, sampling, fix-mode, alerts, sms) |
| E2E | Playwright | 5 user-flows : login, creation vehicule, CUT moteur, replay trip, override fix mode |

### 7.3 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| O.A | Setup `apps/api/test/integration/` + Supertest + DB de test isolee | 1h |
| O.B | 8-10 tests d'integration sur les endpoints critiques | 4h |
| O.C | Setup Playwright dans `apps/web` + config | 1h |
| O.D | 5 user-flows E2E principaux | 3h |
| O.E | Rapport coverage + badge dans README | 1h |

**Total : ~10h**

---

## 8. Sequencement

### 8.1 Ordre recommande

```
Sprint I  (SMS + Backup)        —  ~16h  — debloquant
Sprint J  (Onboarding UX)       —  ~10h
Sprint K  (Scheduling V2)       —  ~14h
Sprint M  (Alertes avancees)    —  ~15h  — depend J (email)
Sprint L  (Rapports & export)   —  ~13h  — depend J (email)
Sprint N  (Geofences V2)        —   ~8h
Sprint O  (Tests qualite)       —  ~10h  — final
```

> Note sur l'ordre : on fait **M avant L** car l'infra notification (Web Push, email, WhatsApp) sert aussi a L (email rapport hebdo). Pas de raison technique d'inverser N et O.

### 8.2 Branches Git

Une branche dediee par sprint, mergee sur main apres revue. Pattern : `feat/sprint-i-sms-backup`, `feat/sprint-j-onboarding`, etc.

### 8.3 Total cumule

| Apres sprint | Effort cumule | Etat produit |
| --- | --- | --- |
| H5 (livre) | 0h | V1.5 partiel : tracking adaptatif fonctionnel |
| I | +16h | + provisionnement tracker SMS + backups auto |
| J | +10h | + onboarding nouveau client autonome |
| K | +14h | + scheduling pro (multi-plages, feries) |
| M | +15h | + notifications externes |
| L | +13h | + rapports clients automatises |
| N | +8h | + geofences avancees |
| O | +10h | + filet de securite tests |
| **TOTAL** | **86h** | **V1.5 complet, production-grade** |

---

## 9. Hors scope explicite

| Item | Pourquoi | Quand reconsiderer |
| --- | --- | --- |
| CI/CD GitHub Actions | User prefere deployer a la main | Apres V1.5 stabilisee |
| Landing page Next.js | LP HTML deja deployee et fonctionnelle | Si besoin features dynamiques (form auto, blog) |
| App mobile (Capacitor) | PWA suffira pour V1 | Si demande explicite client |
| Multi-tenant Stripe / self-service | Manuel suffit < 10 clients | Au 5e client payant |
| Performance scaling (TimescaleDB, Redis) | < 100k positions/jour OK avec PG | Au 50e tracker actif |
| RGPD complet (audit trail exhaustif, pen-test) | Niveau actuel suffisant pour B2B France/Maroc | Avant entree dans des secteurs reglementes |

---

## 10. Journal

| Date | Auteur | Changement |
| --- | --- | --- |
| 2026-04-26 | Younesshs | Creation roadmap V1.5 finition apres validation des sprints H1-H5 (tracking adaptatif). Definit 7 sprints (I-O) pour atteindre production-ready. |
