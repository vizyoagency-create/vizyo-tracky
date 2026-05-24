# État du projet : LP Tracky × Vizyo Leads

> Document de référence à jour au **18 mai 2026**.
> Sert de point de départ propre pour la suite. Tout ce qui n'est pas ici n'est pas décidé.

---

## 1. Où on en est aujourd'hui

### Ce qui tourne déjà en prod
- **LP Vizyo Tracky** (HTML statique) sur `https://tracky.vizyoagency.com`
- **API Vizyo Leads** (NestJS) sur `https://api.leads.vizyoagency.com`
- **App Vizyo Tracky** (SaaS GPS) sur `https://app-tracky.vizyoagency.com`

### Ce qu'on vient de mettre en place mais pas encore poussé
- `vizyo-tracky-final.html` : version v2 du HTML LP avec tracking + formulaire d'audit
  - ⚠️ À mettre à jour : remplacer `api-leads.vizyoagency.com` par `api.leads.vizyoagency.com` (1 ligne dans le JS du form) avant déploiement
- Compte **GA4** créé → `G-0223KY00QV`
- Conteneur **GTM** créé → `GTM-K8TDD9CH` (aucun tag configuré dedans pour l'instant)
- Projet **Axeptio** créé et bandeau publié
  - clientId : `6a0af01db8f1266f1d16cf69`
  - cookiesVersion : `953aa8ec-5da4-4587-a820-5ab5d8b7aaea`
  - 3 étapes : Écran de bienvenue / Statistiques et audience / Annonces personnalisées
  - Consent Mode V2 activé

### Ce qui n'existe pas du tout encore
- Endpoint public sur l'API Vizyo Leads pour recevoir les leads de la LP
- Notification email automatique à `contact@vizyoagency.com`
- Filtre / tag "source = landing-tracky" dans le CRM frontend
- Isolation tenant testée pour les leads Tracky
- Google Search Console / sitemap
- Module Cadence (planifié, pas implémenté — **hors scope de cette mission**)

---

## 2. Le périmètre qu'on vise (MVP minimal)

Un lead soumis depuis la LP Tracky doit aboutir dans le CRM Vizyo Leads en étant :

- ✅ Visible uniquement pour le **super admin** (`admin@vizyoagency.com`)
- ✅ Invisible pour les autres clients de Vizyo Leads (isolation tenant)
- ✅ Tagué clairement comme venant de `landing-tracky`
- ✅ Confirmé par un **email automatique** à `contact@vizyoagency.com`

C'est tout. Pas de scoring sophistiqué. Pas de Cadence. Pas de séquence automatique.

---

## 3. Décisions arrêtées (fixées, on ne revient pas dessus)

| Sujet | Décision |
|-------|----------|
| Domaine API en prod | `api.leads.vizyoagency.com` |
| Routing | Controller dédié `POST /v1/leads/public`, pas de setGlobalPrefix global |
| Captcha | Aucun. Honeypot + throttler 5 req/min/IP + check User-Agent basique |
| Doublons | UPSERT par tuple `(email, source, tenantId)`. Si match → update `utm`, `lastSubmittedAt`, `submissionCount++`. Sinon → insert |
| Notification équipe | Email à `contact@vizyoagency.com` pour **tous** les leads (pas de filtre par score) |
| Cadence | **Non**. Émettre l'event `lead.created` pour préparer le futur, mais zéro listener Cadence |
| Scoring | **Non**. Aucun champ `score`. À ajouter plus tard si besoin |
| metaLeadId | Généré côté backend, format `tracky-lp-{timestamp}-{nanoid8}` |
| Tenant isolation | **CRITIQUE**. Leads Tracky rattachés au tenant Vizyo Agency. Visibles uniquement par `SUPER_ADMIN`. Les autres tenants ne doivent jamais les voir |

---

## 4. Architecture cible (vue simplifiée)

```
[Visiteur LP HTML]
        │
        │  POST JSON
        ▼
[Endpoint POST /v1/leads/public]
        │
        ├─ CORS: tracky.vizyoagency.com only
        ├─ Throttler: 5 req/min/IP
        ├─ Honeypot (champ "website")
        ├─ User-Agent check basique
        ▼
[DTO validation (class-validator)]
        │
        ▼
[PublicIntakeService]
        │
        ├─ tenantId = "vizyo-agency" (forcé)
        ├─ source = "landing-tracky" (forcé)
        ├─ UPSERT(email + source + tenantId)
        ▼
[Prisma → DB] Lead créé / updaté
        │
        ▼
[EventEmitter] 'lead.created' { leadId, ... }
        │
        ▼
[Listener "lead-notification.listener"]
        │
        └─ Envoyer email récap à contact@vizyoagency.com
                                 │
                                 ▼
[CRM Angular]
   Super admin (admin@vizyoagency.com) → voit les leads Tracky
   Autres tenants                       → ne les voient pas
```

---

## 5. Les 3 chantiers à mener — ordre conseillé

### Chantier A — Backend Vizyo Leads (le plus structurant)
Faire monter Claude Code en Phase 2 → Phase 3 → exécution :
- Migration Prisma (ajouter champs `source`, `utm`, `fleetSize`, `sector`, `submissionCount`, `lastSubmittedAt` au modèle `Lead`)
- Module `PublicIntakeModule` (controller + DTO + service + tests e2e)
- Update CORS pour autoriser `https://tracky.vizyoagency.com`
- Listener `lead.created` qui envoie l'email à `contact@vizyoagency.com`
- Renforcement du filtre tenant sur la query `leads.findAll` côté backend

### Chantier B — Frontend CRM Vizyo Leads
- Filtre "Source = Landing Tracky" dans la vue liste
- Affichage des champs Tracky-spécifiques (`fleetSize`, `sector`, `utm`) dans la fiche lead
- Badge de couleur pour identifier rapidement la source

### Chantier C — Déploiement LP + Tracking + Référencement
- Mettre à jour le domaine API dans le HTML (`api-leads` → `api.leads`)
- Déployer la LP v2 sur le VPS
- Configurer les 4 tags GTM (GA4 Config + 3 events)
- Setup Google Search Console + sitemap.xml minimal

> **Chantier C peut être fait en parallèle de A** : la LP fonctionne sans l'endpoint (le form affichera une erreur temporaire jusqu'à ce que A soit livré, mais le reste du tracking tourne).

---

## 6. Prochaine action — UNE seule

Reprendre la session Claude Code en cours et lui coller **le bloc ci-dessous** pour qu'il génère un `01-design.md` propre, sans aucune trace de Cadence ni scoring. Tout est balisé pour qu'il ne sorte pas du périmètre.

### Bloc à coller dans Claude Code :

```
ARBITRAGES PHASE 2 (= ne pas remettre en question, juste appliquer) :

1. Domaine API prod : api.leads.vizyoagency.com (mettre à jour CORS pour autoriser https://tracky.vizyoagency.com en plus de l'existant)

2. Routing : controller dédié POST /v1/leads/public sur un nouveau PublicIntakeModule. Pas de setGlobalPrefix global. Le contrôleur déclare le préfixe en dur dans @Controller('v1/leads/public').

3. Captcha : AUCUN au démarrage. Sécurité = honeypot (champ "website" déclaré au DTO, accepté si vide, rejeté silencieusement avec status 200 si rempli) + @nestjs/throttler 5 req/min/IP scopé sur cet endpoint uniquement + check User-Agent basique (rejet si UA vide, ou contient 'python-requests'/'curl/'/'wget' au début).

4. Doublons : UPSERT par tuple (email + source + tenantId). Match = update champs utm, lastSubmittedAt (=now), submissionCount++ et merge des nouveaux champs si plus complets. Pas de match = insert.

5. Notification équipe : envoi email à contact@vizyoagency.com pour CHAQUE lead reçu (pas de filtre par score). Listener sur event 'lead.created'. Template simple : sujet "Nouveau lead Tracky — {company} ({fleetSize} véhicules)", body avec récap des champs.

6. Cadence : NON. Pas de moteur Cadence. Juste émettre l'event 'lead.created' via @nestjs/event-emitter pour préparer le futur. ZÉRO listener Cadence. Si la dépendance @nestjs/event-emitter n'est pas installée, l'ajouter.

7. Scoring : NON. Aucun champ score ajouté au modèle Lead. À implémenter plus tard.

8. metaLeadId : générer un identifiant synthétique côté backend au format 'tracky-lp-{timestamp}-{nanoid8}' (dépendance nanoid à utiliser si déjà présente, sinon crypto.randomUUID() avec slice).

9. Tenant isolation (CRITIQUE) : les leads de la LP Tracky doivent être rattachés au tenant "Vizyo Agency" (= le tenant propriétaire du SaaS Vizyo Leads, pas un client externe). Le tenantId est forcé côté service, jamais lu depuis le payload. Ces leads doivent être visibles UNIQUEMENT par les users ayant le rôle SUPER_ADMIN (typiquement admin@vizyoagency.com). Les autres tenants/clients de Vizyo Leads NE DOIVENT JAMAIS pouvoir voir ces leads dans leur CRM. Vérifier que la query findAll des leads applique bien le filtre tenantId selon le user authentifié, et que le SUPER_ADMIN bypasse ce filtre. Identifier comment ce tenant "Vizyo Agency" est représenté en base aujourd'hui (User org, Tenant entity, ou autre) et utiliser le mécanisme existant.

CONTRAINTES STACK (déjà confirmées par l'exploration) :
- NestJS 11, Prisma 7 + adapter-pg
- class-validator pour DTO (pas Zod)
- @Public() decorator existant pour skip auth
- @nestjs/throttler v6 déjà installé
- forbidNonWhitelisted: true global → TOUS les champs du payload LP doivent être déclarés au DTO (notamment utm, pageUrl, referrer, userAgent, website honeypot, consentGiven, consentTimestamp), sinon 400 sur payload légitime
- Lead.metaLeadId requis + unique → générer côté backend (cf. point 8)

LIVRABLES DE LA PHASE 2 :
- docs/integration-tracky-leads/01-design.md
- Sections obligatoires : 
  1) Schéma Prisma diff complet (avant/après, nom de migration explicite)
  2) Structure du PublicIntakeModule (arbre de fichiers, responsabilités)
  3) DTO complet avec décorateurs class-validator
  4) Modification CORS (avant/après, fichier exact)
  5) Configuration throttler scopé sur l'endpoint
  6) Listener email avec template
  7) Modification du filtrage CRM côté backend pour isolation tenant (la partie la plus critique)
  8) Variables d'environnement à ajouter

LIRE D:\www\ERROR_HARD.md avant de proposer le design (prérequis CLAUDE.md pour Prisma/CORS).

ATTENDRE MA VALIDATION avant Phase 3 (02-roadmap.md exécutable étape par étape). Aucun code ne doit être touché en Phase 2.
```

---

## 7. Mémo des IDs déjà collectés (à ne pas perdre)

| Service | Identifiant |
|---------|-------------|
| GA4 Measurement ID | `G-0223KY00QV` |
| GTM Container ID | `GTM-K8TDD9CH` |
| Axeptio Client ID | `6a0af01db8f1266f1d16cf69` |
| Axeptio Cookies Version | `953aa8ec-5da4-4587-a820-5ab5d8b7aaea` |
| Endpoint API cible | `https://api.leads.vizyoagency.com/v1/leads/public` |
| Email notif équipe | `contact@vizyoagency.com` |
| Super admin CRM | `admin@vizyoagency.com` |

---

## 8. Ce qu'on ne fait PAS (volontairement, pour rester focus)

Pour mémoire, ces sujets reviendront plus tard, **dans cet ordre** :

1. Module Cadence (séquences email/SMS post-lead, scoring CHAUD/TIEDE/etc.) → roadmap dédiée, 15 phases déjà cadrées
2. Migration LP HTML → Next.js (pour scaler les pages secteurs/villes et le SEO)
3. SEO IA / GEO (être cité par ChatGPT, Claude, Perplexity, Gemini)
4. Stratégie contenu (blog, calendrier éditorial, pages secteurs)
5. Meta retargeting

Tous ces sujets sont déjà documentés dans la roadmap acquisition (docs 03 à 07).
