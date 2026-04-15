# Roadmap V2 — Vizyo Tracky

> **Statut :** Draft — 2026-04-15
> **Contexte :** V1 validee terrain (2 trackers, CUT/RESTORE physique, scheduling horaire). Cette roadmap liste les evolutions a planifier apres la stabilisation V1 et l'acquisition des premiers clients.

---

## 1. Priorite haute (avant premiers clients payants)

### 1.1 SMS Gateway (Phase 7 — Vague B)

Provisionnement des trackers via SMS (Twilio/MessageBird). Permet d'initialiser un tracker neuf sans acces physique au boitier.

| Tache | Estimation |
| --- | --- |
| Compte Twilio + numero | 1h |
| Module SMS NestJS (send/receive) | 4h |
| Sequence init automatisee (9 SMS) | 3h |
| UI provisionnement tracker | 2h |
| Tests E2E avec SIM reelle | 2h |

### 1.2 CI/CD GitHub Actions

| Tache | Estimation |
| --- | --- |
| Workflow test + build (API + Web + Shared) | 2h |
| Deploy auto sur push main (SSH + docker compose) | 2h |
| Notifications Slack/Discord en cas d'echec | 1h |

### 1.3 Backup automatise PostgreSQL

| Tache | Estimation |
| --- | --- |
| Cron pg_dump quotidien vers S3/Backblaze | 2h |
| Retention 30 jours + alerte si backup rate | 1h |
| Script de restore documente | 1h |

### 1.4 Onboarding UX

| Tache | Estimation |
| --- | --- |
| Wizard premiere connexion (fleet → user → tracker) | 3h |
| Email d'invitation utilisateur | 2h |
| Page "Mon compte" + changement mot de passe | 2h |

---

## 2. Priorite moyenne (premiers mois d'exploitation)

### 2.1 Scheduling horaire V2

| Tache | Estimation |
| --- | --- |
| Multi-plages par jour (ex: 08:00-12:00 + 14:00-18:00) | 3h |
| Jours feries par pays (calendrier configurable) | 4h |
| Dates speciales (plage ponctuelle sur une date) | 3h |
| Notification push/email sur CUT/RESTORE auto | 2h |
| Historique des transitions scheduler (timeline) | 2h |

### 2.2 Rapports et export

| Tache | Estimation |
| --- | --- |
| Export PDF rapport journalier/hebdo/mensuel | 4h |
| Export CSV positions/trips/commandes | 2h |
| Email automatique rapport hebdo au gestionnaire | 3h |
| Dashboard KPI avance (consommation, km/jour, temps arret) | 4h |

### 2.3 Alertes avancees

| Tache | Estimation |
| --- | --- |
| Notifications push navigateur (Web Push API) | 3h |
| Notifications email (SendGrid/Resend) | 2h |
| Notifications WhatsApp (Twilio/API officielle) | 3h |
| Regles d'alerte personnalisables par vehicule | 4h |
| Escalade : si pas d'acquittement en X min → notifier N+1 | 3h |

### 2.4 Geofences V2

| Tache | Estimation |
| --- | --- |
| Geofences polygones (dessin libre sur carte) | 4h |
| Import/export geofences (GeoJSON) | 2h |
| Alertes geofence par vehicule (pas globales) | 2h |
| Corridors (geofence lineaire le long d'un trajet) | 4h |

---

## 3. Priorite basse (scaling 10+ clients)

### 3.1 App mobile

| Tache | Estimation |
| --- | --- |
| Capacitor/Ionic wrapper de l'app Angular | 4h |
| Push notifications mobiles (FCM/APNs) | 4h |
| Mode offline (positions cachees localement) | 6h |
| Publication App Store + Play Store | 4h |

### 3.2 Multi-tenant avance

| Tache | Estimation |
| --- | --- |
| Dashboard super-admin multi-flottes | 4h |
| Facturation par vehicule (Stripe integration) | 6h |
| Self-service onboarding (inscription + paiement) | 8h |
| API publique pour integrations tierces | 6h |

### 3.3 Performance et scaling

| Tache | Estimation |
| --- | --- |
| TimescaleDB pour positions (partitioning temporel) | 4h |
| Cache Redis pour positions live (pas de DB read par tick) | 3h |
| Load balancer TCP pour > 500 trackers simultanes | 4h |
| Monitoring Grafana + Prometheus | 4h |

### 3.4 Securite et conformite

| Tache | Estimation |
| --- | --- |
| Audit trail complet (qui a fait quoi, quand) | 3h |
| RGPD : export/suppression donnees utilisateur | 3h |
| Chiffrement positions au repos | 2h |
| Rotation automatique JWT secrets | 2h |
| Penetration test externe | Externe |

---

## 4. Decisions a prendre

| Sujet | Options | Decision |
| --- | --- | --- |
| SMS provider | Twilio vs MessageBird vs Android Gateway | A evaluer cout/fiabilite |
| App mobile | Capacitor vs React Native vs PWA seule | PWA d'abord, Capacitor si besoin natif |
| Facturation | Stripe vs facture manuelle | Manuelle tant que < 10 clients |
| Hosting | VPS unique vs Kubernetes | VPS jusqu'a 500 trackers |
| Base positions | PostgreSQL vs TimescaleDB | PostgreSQL tant que < 100k positions/jour |

---

## 5. Metriques de succes V2

| Metrique | Cible |
| --- | --- |
| Clients payants | 5+ |
| Vehicules suivis | 50+ |
| Uptime API | > 99.5% |
| Latence CUT (UI → relais) | < 3s (P95) |
| Positions traitees/jour | > 50k |
| Temps d'onboarding nouveau client | < 30 min |
