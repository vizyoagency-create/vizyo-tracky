# 24 — Intégration Tracky × Maestroo — runbook de déploiement (lot 0)

> Prérequis : [`23-integration-maestroo-phase0-spec.md`](./23-integration-maestroo-phase0-spec.md).
> Le lot 0 est complet et démontré de bout en bout, mais **inerte par défaut**.
>
> **Ce runbook déploie du code éteint.** Rien ne change pour les clients tant que les
> kill-switchs restent à `false`. L'allumage est une étape séparée, explicite, §5.

---

## 0. Avant de commencer — deux réalités à vérifier

1. **Maestroo en production est « prête mais désactivée »** (décision antérieure : ne pas
   activer sans GO). Si l'instance Maestroo n'est pas en service, ce déploiement n'a de
   sens que côté Tracky — le module y restera éteint faute de pair. Vérifier avant.
2. **Le VPS Tracky a 2 vCPU** : builder l'API et le web *séquentiellement*, jamais en
   parallèle (précédent connu de saturation).

---

## 1. Secrets à provisionner

Trois valeurs, **distinctes de celles de dev**. Elles ont été générées le 2026-07-22 et
transmises hors de ce dépôt — elles ne doivent **jamais** être commitées.

| Variable | Où | Contrainte |
|---|---|---|
| `PARTNER_PLATFORM_SECRET` | `.env` prod **Tracky** | 32 octets base64url |
| `TRACKY_PARTNER_PLATFORM_SECRET` | `.env` prod **Maestroo** | ⚠️ **valeur strictement identique** à la précédente |
| `TRACKY_LINK_SECRET_KEY` | `.env` prod **Maestroo** | 32 octets base64 (AES-256-GCM) |

> ⚠️ **Le secret de plateforme doit être identique des deux côtés**, sinon *tout* échoue :
> handshake, webhooks, énoncés de révocation. C'est le point de panne n°1 d'une première
> mise en service.
>
> ⚠️ **Perdre `TRACKY_LINK_SECRET_KEY` rend tous les liens existants inutilisables** (les
> secrets chiffrés deviennent illisibles) — il faut alors refaire chaque handshake. À
> sauvegarder au même titre qu'un mot de passe de base.

Pour en régénérer :

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"  # plateforme
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"     # cle AES
```

---

## 2. ⚠️ Les URL — le piège n°1, et il est SILENCIEUX

**Tracky monte toutes ses routes sous `setGlobalPrefix('api')`**, et Traefik ne retire pas
le préfixe (`PathPrefix('/api')` sans middleware `stripprefix`). Une URL sans `/api` ne
produit pas d'erreur visible : le lien se crée normalement, **et aucune donnée ne circule
jamais**. C'est exactement ce qui est arrivé à la première démo.

| Variable | Valeur | Vérification |
|---|---|---|
| `TRACKY_API_URL` (Maestroo) | `https://<APP_DOMAIN_TRACKY>/api` | doit **finir par `/api`** |
| `PARTNER_MAESTROO_API_URL` (Tracky) | `https://<API_MAESTROO>` **+ le base path réel** | dépend de `API_BASE_PATH` côté Maestroo |

**Ne pas deviner le second** — le déterminer :

```bash
# Doit repondre 200. Tester les deux formes et garder celle qui repond.
curl -s -o /dev/null -w "avec /api  : %{http_code}\n" https://<API_MAESTROO>/api/health
curl -s -o /dev/null -w "sans /api  : %{http_code}\n" https://<API_MAESTROO>/health
```

La base à mettre dans `PARTNER_MAESTROO_API_URL` est celle **sans** `/health`, dans la
forme qui a répondu 200.

---

## 3. Variables complètes

**Tracky** (`.env` prod) :

```bash
PARTNER_MAESTROO_ENABLED=false          # reste false a ce stade
PARTNER_MAESTROO_API_URL=<cf. §2>
PARTNER_PLATFORM_SECRET=<secret partage>
PARTNER_TOKEN_TTL_SECONDS=600
```

**Maestroo** (`.env` prod) :

```bash
TRACKY_INTEGRATION_ENABLED=false        # reste false a ce stade
TRACKY_API_URL=https://<APP_DOMAIN_TRACKY>/api
TRACKY_PARTNER_PLATFORM_SECRET=<le MEME secret>
TRACKY_LINK_SECRET_KEY=<cle AES>
TRACKY_GRACE_HOURS=72
```

---

## 4. Déploiement

### 4.1 — Migrations

Trois migrations à appliquer, toutes purement additives (création de tables et de
colonnes, aucune donnée touchée, aucun `DROP`) :

- Tracky : `20260722061600_add_partner_links`
- Maestroo : `20260722061530_add_tracky_link_and_mirror`
- Maestroo : `20260722131500_tracky_link_degraded_counters`

```bash
# Sur chaque app, apres deploiement du code
docker compose exec api npx prisma migrate deploy
```

> ⚠️ **Vérifier `prisma migrate status` AVANT.** L'historique de migrations Tracky a une
> dérive connue (5 valeurs d'`AlertType` absentes des migrations, cf. spec §14.4). Si un
> ticket dédié l'a corrigée entre-temps, cette migration passera aussi — ne pas la
> confondre avec celle du lot 0.

### 4.2 — Ordre

1. **Maestroo d'abord**, s'il est en service (c'est le consommateur : sans lui, Tracky
   n'a personne à appeler, et un module éteint ne tente rien).
2. **Tracky ensuite**. Build **séquentiel** `api` puis `web` (2 vCPU).

### 4.3 — Sauvegardes

Modifier le cron de sauvegarde Maestroo pour **exclure la quarantaine** :

```bash
0 3 * * * docker exec maestroo-postgres pg_dump -U maestroo --exclude-table=tracky_mirror maestroo | gzip > /opt/backups/maestroo-$(date +\%Y\%m\%d).sql.gz
```

Sans cette exclusion, restaurer un dump antérieur à une révocation ressusciterait des
données qu'on n'a plus le droit de détenir. L'API repurge au démarrage (second garde-fou),
mais les deux sont nécessaires — cf. spec §5.5.

---

## 5. Vérification — code déployé, toujours éteint

À ce stade, **rien ne doit fonctionner**, et c'est le résultat attendu.

```bash
# 1. Les modules annoncent leur etat au demarrage
docker compose logs api | grep -i "Intégration"
#   Tracky   attendu : « Intégration Maestroo INACTIVE — PARTNER_MAESTROO_ENABLED=false »
#   Maestroo attendu : « Intégration Tracky INACTIVE — TRACKY_INTEGRATION_ENABLED=false »

# 2. Les routes partenaires sont INDISCERNABLES d'une route absente (404, jamais 403)
curl -s -o /dev/null -w "%{http_code}\n" https://<APP_DOMAIN_TRACKY>/api/partner/v1/ping
#   attendu : 404
```

Un `403` ici signifierait que le module est actif — **ne pas continuer** dans ce cas.

---

## 6. Allumage (étape séparée, réversible)

Uniquement quand les deux côtés sont déployés, vérifiés, et que tu décides de connecter
un premier client.

```bash
# 1. Maestroo
TRACKY_INTEGRATION_ENABLED=true   → redemarrer l'API
# 2. Tracky
PARTNER_MAESTROO_ENABLED=true     → redemarrer l'API
# 3. Controle : le log doit dire « active — pair : <url> », et l'URL doit etre celle du §2
```

**Test de bout en bout sur un client pilote**, dans cet ordre :

1. Maestroo → « Intégrations » → *Générer un code*
2. Tracky → « Intégrations » → coller le code → l'écran de consentement doit afficher le
   **bon nom d'organisation et le bon SIRET** (sinon : mauvais pair, arrêter)
3. Autoriser avec les catégories par défaut — `LIVE_POSITION` et `DRIVING_BEHAVIOR`
   doivent arriver **décochées**
4. Maestroo → synchroniser → la donnée apparaît
5. **Tracky → Révoquer** → la donnée doit disparaître côté Maestroo

L'étape 5 est le contrôle qui compte. Si elle échoue, éteindre les deux kill-switchs
immédiatement.

---

## 7. Retour arrière

| Situation | Geste |
|---|---|
| Comportement inattendu après allumage | `*_ENABLED=false` + redémarrage. **Instantané, sans perte** : les liens existants restent en base et repartiront à la réactivation. |
| Besoin de couper un client précis | Tracky → `/admin/partner-links` → *Suspendre* (le client ne peut pas le lever). |
| Rollback du code | Les migrations sont additives : l'ancienne version tourne sans problème avec les nouvelles tables. **Ne pas rollback les migrations.** |

---

## 8. Ce qui reste non couvert

- **Aucun des 3 écrans n'a été vu dans un navigateur** — builds et typechecks verts, mais
  la vérification visuelle reste à faire au premier allumage.
- Le harnais sur vraie base (`apps/api/test/kill-switch.e2e.spec.ts`) ne tourne pas en CI :
  il exige `TEST_DATABASE_URL`. À câbler si on veut la garantie à chaque commit.
- La rotation du secret de plateforme n'a pas de procédure : elle invaliderait tous les
  liens simultanément. À écrire avant d'en avoir besoin.
