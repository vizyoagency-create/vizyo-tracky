# Roadmap V2 — Vizyo Tracky

> **Statut :** Draft — 2026-04-15 — Revise 2026-04-26
> **Contexte :** V1 validee terrain (2 trackers, CUT/RESTORE physique, scheduling horaire). Cette roadmap liste les evolutions a planifier apres la stabilisation V1 et l'acquisition des premiers clients.
>
> **⚠ Mise a jour 2026-04-26 :** les items de **priorite haute (§1)** et **priorite moyenne (§2)** sont consolides dans la nouvelle roadmap [13-roadmap-v1.5-finition.md](docs/13-roadmap-v1.5-finition.md) (sprints I-O, ~86h). Cette roadmap V2 ne couvre desormais que la **priorite basse §3** (scaling > 5 clients payants).
>
> **Decisions actees 2026-04-26 :**
> - **CI/CD GitHub Actions (§1.2)** → ❌ reporte indefiniment (user prefere deployer a la main pendant la phase d'iteration rapide).
> - **Landing page Next.js** → ❌ hors scope (LP HTML statique deja deployee sur tracky.vizyoagency.com).
> - **SMS Gateway (§1.1)** → ✅ planifie Sprint I avec **acces SUPER_ADMIN seulement** (FLEET_ADMIN n'ont pas besoin).

---

## 1. Priorite haute (avant premiers clients payants) — 📦 Migre en V1.5 (cf. roadmap 13)

> **Tous les items de cette section sont desormais traites dans [13-roadmap-v1.5-finition.md](docs/13-roadmap-v1.5-finition.md).**

| Item | Statut V1.5 |
| --- | --- |
| 1.1 SMS Gateway | 📋 Planifie Sprint I (SUPER_ADMIN only) |
| 1.2 CI/CD GitHub Actions | ❌ Hors scope V1.5 (decision user — deploy manuel) |
| 1.3 Backup automatise PostgreSQL | 📋 Planifie Sprint I |
| 1.4 Onboarding UX | 📋 Planifie Sprint J |

---

## 2. Priorite moyenne (premiers mois d'exploitation) — 📦 Migre en V1.5 (cf. roadmap 13)

> **Tous les items de cette section sont desormais traites dans [13-roadmap-v1.5-finition.md](docs/13-roadmap-v1.5-finition.md).**

| Item | Statut V1.5 |
| --- | --- |
| 2.1 Scheduling horaire V2 | 📋 Planifie Sprint K |
| 2.2 Rapports et export | 📋 Planifie Sprint L |
| 2.3 Alertes avancees | 📋 Planifie Sprint M |
| 2.4 Geofences V2 | 📋 Planifie Sprint N (polygones + import/export deja livres V1.4 Sprint F) |

---

## 3. Priorite basse (scaling 10+ clients) — 🎯 Vraie roadmap V2

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
