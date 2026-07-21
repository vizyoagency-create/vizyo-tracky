# TÂCHES — Chantier commercial + RGPD (2026-07-21)

> Fichier de travail unique. On avance **step by step** dans l'ordre ci-dessous.
> Généré depuis l'inventaire à jour (`main @ 23733c7`) + benchmark marché du 21/07/2026.
> Statuts : ⬜ à faire · 🔶 en cours · ✅ fait · ⏸️ bloqué (décision) · ❌ abandonné (décision actée)

---

## 🔑 DÉCISIONS — ACTÉES le 21/07/2026 (source : Vizyo_Tracky_Plan_Action_INTERNE.xlsx, feuille « Repositionnement »)

### D1 ✅ — Nouvelle grille : modèle TOUT INCLUS (bascule stratégique)
Matériel, SIM, pose et garantie **compris dans l'abonnement** (on arrête de facturer boîtier 149 € + pose 79 €).
Prix **HT / véhicule / AN** :

| Plan | **Sérénité** (tout inclus, 36 mois) | **Liberté** (sans engagement, 12 mois, matériel restitué) |
|---|---|---|
| **Tracky Lite** (géoloc simple, sans coupe-circuit) | **149 €/an** (12,42 €/mois) | 199 €/an (16,58 €/mois) |
| **Tracky Pro** (+ coupure programmée, IA, antivol, audit) | **199 €/an** (16,58 €/mois) | 259 €/an (21,58 €/mois) |
| **Tracky Signature** (premium tout compris) | **269 €/an** (22,42 €/mois) | 349 €/an (29,08 €/mois) |

Options : tarification annuelle conservée à la carte (Assistant IA 179 €/an, etc.), **incluses selon le palier**
(Signature = tout compris). ⚠️ Le détail exact du mapping option↔palier est « à reprendre » (tâche S4 du xlsx)
→ mapping provisoire proposé par Claude, à valider : Pro inclut conducteurs QR + vie privée + agenda + scores ;
Signature inclut en plus Live 20 s + Agent IA + micro + rétention 3 ans + veilleur/surveillance.

### D2 ✅ — Purge des positions : **NE PAS ARMER** (décision Youness)
La purge reste en DRY-RUN. La tâche 4.2 reste ⏸️ jusqu'à nouvel ordre.

### D3 ✅ — PIN : ❌ CLOS. Remplacé par QR + compte conducteur (fait, en prod, LP nettoyée).

### D4 ✅ — GO abonnements par client dans l'app
Objectif : chaque flotte a son **plan** (Lite/Pro/Signature) + sa **formule** + ses **options**, visibles et
modifiables depuis l'espace admin (vue d'ensemble, modification, **cas spéciaux/comp**). Les options
s'activent selon le plan. → Phase 5 réécrite en conséquence.

### D5 ✅ — GO chiffres dynamiques
Endpoint public qui lit le **nombre total de véhicules suivis** en base ; la LP (et tous les affichages de
chiffres) se met à jour automatiquement. → nouvelle tâche 3.0.

---

## PHASE 1 — LP : vérité produit (rapide, AVANT toute com')

- ✅ **1.1 « 15 s » → « 20 s » partout** (réel : plancher matériel Coban 20 s, défaut 30 s).
  Fichiers : `lp/src/data/pricing.mjs` (label Live), `lp/design/{index,fonctionnalites,tarifs,secteur-public}.html`,
  `lp/build.mjs` (metas), `lp/public/assets/vt.js` (récap devis) → rebuild `node build.mjs`.
  Done = 0 occurrence « 15 s » trompeuse dans `lp/public`.
- ✅ **1.2 Matrice des rôles : 4 → réalité produit** (`lp/design/index.html` ~l.266).
  Colonnes réelles côté client : Admin flotte · Gestionnaire · Lecteur · **Veilleur de nuit** · **Conducteur**
  (le super-admin = Vizyo, hors matrice). Ajouter les capacités nouvelles : « Déverrouiller par QR (proximité) »,
  « Mode vie privée ». Badge « 6 capacités · 4 rôles » → mis à jour.
- ⏸️ **1.3 Chiffres déclaratifs** → dépend **D5**.

## PHASE 2 — LP : vendre TOUT le produit (features absentes de la LP)

Features implémentées et **non vendues** aujourd'hui (inventaire 21/07) :
1. Comptes conducteurs + déverrouillage QR + contrôle de proximité
2. **Mode vie privée RGPD « usage mixte »** (cadre de temps de travail, privé auto hors travail, non-collecte) — différenciateur CNIL majeur
3. Veilleur de nuit (rôle sécurité dédié)
4. Détection GPS perdu + zones mortes apprises (souterrains)
5. Surveillance programmée (plages de veille + alertes)
6. Scores de conduite
7. Analyse de trajets + carburant (calibration « méthode du plein »)
8. Agent IA d'agenda (préparation nocturne) + optimiseur de placement
9. Lieux clés (stations, parkings validés + enrichissement OSM + analyse IA)
10. Maintenance préventive (rappels échéances)
11. Réservations de véhicules (anti-conflit) + lien public de RDV d'installation
12. Rapports automatiques hebdo par e-mail + exports PDF/Excel/CSV
13. Gestion SIM intégrée
14. Sécurité compte : 2FA, vérification nouveaux appareils, journal des connexions
15. Journal d'audit complet (« qui fait quoi quand ») + centre d'alerte
16. PWA installable + notifications push
17. Coupure planifiée par horaires (multi-plages, jours fériés, dates spéciales)

- ✅ **2.1 `fonctionnalites.html`** : refonte en sections par domaine, TOUTES les features ci-dessus.
- ✅ **2.2 `index.html`** : grille features enrichie + bloc « Conducteurs & RGPD » (différenciateurs).
- ✅ **2.3 `securite.html`** : enrichir (2FA, audit, vie privée conducteur, consentement, hébergement UE).
- ✅ **2.4 `tarifs.html`** : rattacher les features aux plans (qui a quoi).
- ✅ **2.5 Vérifier héritage pages villes** (générées par `build.mjs`) + rebuild + relecture complète.

## PHASE 3 — Pricing dynamique (source unique, gérable depuis l'app)

Architecture : **DB = source de vérité**, LP statique = fallback SEO + hydratation runtime.
- ⬜ **3.1 Backend** : modèle `PricingSettings` (singleton JSON, même forme que `pricing.mjs`) + migration.
  `GET /public/pricing` (public, cache 5 min, CORS LP) + `PUT /admin/pricing` (owner/super-admin, gate
  `billing_manage`, **audité** SystemActivity, erreurs → centre d'alerte). Seed = grille validée D1.
- ⬜ **3.2 App admin** : page « Tarifs & offres » (édition plans/options/install/offre de lancement,
  aperçu, historique des modifications).
- ⬜ **3.3 LP** : `vt.js` hydrate au chargement depuis `GET /public/pricing` (fallback = valeurs bakées) :
  `tarifs.html` (cartes + tableau), simulateur devis, teasers index, mentions prix pages villes.
  Marquage DOM `data-price="lite.annual"` etc. pour l'hydratation générique.
- ⬜ **3.4 `pricing.mjs`** : devient le fallback ; script `node build.mjs --sync-pricing` (fetch API → réécrit
  le fallback avant build) pour garder le HTML statique aligné.
- ⏸️ **3.5 Appliquer la grille D1** (une fois validée) via l'admin + resync LP.

## PHASE 4 — RGPD : les manques confirmés par l'audit

- ⬜ **4.1 Purge des trajets > 12 mois** : cron dédié (pattern `data-retention.service`), DRY-RUN par défaut,
  `TRIPS_RETENTION_MONTHS` (défaut 12), trace RETENTION + vue `/admin/background-tasks`. Tests.
- ⏸️ **4.2 Purge des positions par flotte** (dépend **D2**) : la rétention devient **par flotte** selon
  l'option payée (90 j inclus / 1 / 2 / 3 ans) → champ `Fleet.retentionDays` + le cron l'applique ;
  armement prod = décision explicite.
- ⬜ **4.3 Export RGPD conducteur (art. 15)** : `GET /drivers/:id/gdpr-export` (admin, audité) → JSON/ZIP :
  profil Driver, User lié, trajets, événements vie privée, accès/permissions, événements QR. UI : bouton
  fiche conducteur.
- ⬜ **4.4 Effacement / anonymisation conducteur (art. 17)** : `POST /drivers/:id/anonymize` (confirmation
  forte, audité) : écrase PII (nom→« Conducteur supprimé », tél/email/permis/notes→null), délie le User
  (désactivé), conserve l'intégrité `Trip.driverId`. Distinct de l'archivage actuel. Tests.
- ⬜ **4.5 Registre du temps de travail (5 ans, SANS positions)** : design d'abord (doc courte) —
  table `WorkTimeEntry` (conducteur, date, plages travaillées agrégées depuis trajets + cadre), rétention
  propre 5 ans, export CSV. Gros morceau → dernier de la phase.

## PHASE 5 — Monétisation dans l'app (dépend D4)

- ⏸️ **5.1** `Fleet.plan` (LITE/PRO/FLEET) + affichage dans Réglages + attribution super-admin.
- ⏸️ **5.2** Gating doux : features hors plan → écran « disponible en Pro » (mapping features↔plans de 2.4).
- ⏸️ **5.3** Stripe complet par véhicule (au-delà de l'option IA) — bloqué clés Stripe prod + D1.

## PHASE 6 — Hérités / hygiène

- ⬜ **6.1 Doc de référence commerciale** : 1 ligne par module (58) pour la présentation commerciale.
- ⬜ **6.2 Relecture finale LP ↔ code** après phases 1–3 (zéro écart).
- ❌ **6.3 PIN conducteur** — clos si D3 confirmé.

---

## Ordre d'exécution retenu
**1.1 → 1.2 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 3.1 → 3.2 → 3.3 → 3.4 → 4.1 → 4.3 → 4.4 → [D1: 3.5] → [D2: 4.2] → 4.5 → 6.1 → 6.2 → [D4: phase 5]**
Logique : d'abord la vérité (1), puis vendre ce qui existe (2), puis l'outillage pricing (3) qui permet
d'appliquer D1 sans redéploiement, puis la conformité produit (4) qui sécurise le discours commercial,
enfin la monétisation in-app (5).

## Notes de coordination
- Repo partagé avec l'autre agent (branche `feat/communications-hub`) : chaque étape = commit atomique sur
  `main`, deploys séquentiels api→web, LP rebuildée via `node build.mjs`.
- Toute erreur nouvelle → try/catch + centre d'alerte (règle posée le 21/07).
