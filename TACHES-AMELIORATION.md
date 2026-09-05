# Tâches d'amélioration — registre accumulateur

> **Créé le 2026-08-23** par l'audit complet multi-agents (9 domaines, 107 constats, les 12
> constats nouveaux critiques/importants contre-expertisés un par un sur le code).
> **Ce fichier est l'accumulateur** que l'agent d'audit global (chantier AM-033) maintiendra ;
> d'ici là, il se tient à la main.
>
> **Règles du fichier — à ne pas défaire :**
> 1. **Une tâche ne disparaît jamais.** Elle passe `à faire` → `fait` (date + commit) ou
>    `écarté` (décision datée du propriétaire). Un point qui disparaît doit avoir été tranché.
> 2. **Clé stable `AM-NNN`.** Une re-détection met à jour « vu le », elle ne crée pas de doublon.
> 3. **L'agent ajoute, l'humain tranche.** L'agent n'a pas le droit de passer une tâche à
>    `écarté` ; seul un humain le fait.
> 4. **Pas de recopie des registres existants.** Les décisions déjà tracées vivent dans
>    `DECISIONS-A-TRANCHER-2026-08-23.md` (n° 1-26) et `ETAT-RESTE-A-FAIRE-2026-08-22.md` —
>    ici, seulement des pointeurs (§ Pointeurs). Recopier = faire diverger.
>
> Format d'une entrée : gravité `[critique|important|moyen|mineur]` · horizon
> `[immédiat|trimestre|année]` · un constat sourcé fichier:ligne · un geste concret.

---

## Corrections au registre (l'audit a trouvé le registre en retard sur le code)

- **Le backup existe.** `deploy/vps/backup-db.sh` + timer systemd tournent chaque nuit depuis
  juillet, vérifiés par `backup_runs` + le chien de garde `backup-health`. L'item n° 11 de
  l'ETAT (« jamais mis en place ») décrit l'état d'avril. **Le vrai manque est la copie
  hors-site** (AM-001) et la procédure de restauration jamais exercée.
- **L'enforcement des permissions a largement rattrapé le registre** : PERMISSIONS_AUDIT § 8
  affirme des manques que le code a en partie comblés (ex. `vehicle-groups.controller.ts:37-44`).
  À re-vérifier permission par permission avant de lancer le chantier n° 12 tel quel.
- **README.md:7 annonce Prisma 7** ; le dépôt installe Prisma 6.19.3 partout. Corrigé par AM-015.
- **BullMQ est annoncé dans la stack** (README) mais aucun usage n'existe dans `apps/api/src`.

---

## Immédiat — risque actif en production

### AM-001 · [critique] Copie hors-site des sauvegardes + restauration exercée une fois
Les 56 dumps de `tracky_prod` (6,7 Go) vivent sur le disque qu'ils protègent
(`deploy/vps/backup-db.sh:72-82` — `RCLONE_REMOTE` jamais posé, confirmé par les collectes
d'audit VPS). Un disque mort emporte la base ET ses copies.
**Geste** : poser `RCLONE_REMOTE` vers un stockage objet indépendant (~1-2 €/mois), puis
écrire et EXÉCUTER une fois la procédure de restauration (base scratch, `gunzip | psql`,
compter 3 tables témoins) et la ranger dans `docs/DEPLOYMENT-VPS.md`.
Statut : **à faire** · vu le 2026-08-23

### AM-002 · [important] Node 20 en fin de vie depuis avril 2026, prod comprise
`.nvmrc:1`, `package.json:5-7`, `deploy/vps/Dockerfile.api:2,21`, `Dockerfile.web:1` — la
prod tourne depuis ~4 mois sans correctifs de sécurité du runtime, serveur TCP compris.
**Geste** : montée Node 22 LTS (maintenu jusqu'en 2027) : bump + `pnpm verify` complet +
déploiement contrôlé. Mécanique ; la dépense est le test.
Statut : **à faire** · vu le 2026-08-23

### AM-003 · [important] Les CRITICAL isolés ne déclenchent jamais l'e-mail d'alerte
La vigie exige > 5 erreurs/heure (`error-rate-watchdog.service.ts:11,83-84`) : les sondes de
silence (backup manqué, tâche planifiée muette, disparitions) émettent UN CRITICAL isolé —
précisément celui qui ne franchit jamais le seuil.
**Geste** : seconde règle indépendante du volume — tout CRITICAL des sources désignées
(backup-health, scheduled-task-heartbeat, recensement-suppressions, dependency:*) alerte dès
la première occurrence, refroidissement existant en garde-fou. ~30 lignes dans `evaluate()`.
Statut : **à faire** · vu le 2026-08-23

### AM-004 · [important] `psql` sans `ON_ERROR_STOP` sur 2 agents sur 4
La leçon n° 4 (payée le 20/08 : « 1 zone enregistrée » sur une table absente) n'est appliquée
qu'à `agent-recit-trajet` et `agent-qualite-gps`. Manquent : `agent-limites-vitesse.cjs:95-103`
et `agent-courrier-ia.cjs:54-62`.
**Geste** : ajouter `-v ON_ERROR_STOP=1` aux deux `psql()` + un essai qui prouve que
`prendreUnTravail()` lève quand la table est inaccessible.
Statut : **à faire** · vu le 2026-08-23

### AM-005 · [important] Courrier IA : aucun plafond de tentatives côté agent
`reposer()` remet toujours en `a-faire` (`agent-courrier-ia.cjs:107-113`) : un travail
empoisonné bloque la tête de file (tri `creeA ASC`) et brûle l'abonnement en boucle à chaque
passage. Le serveur promet `echec` après 3 tentatives (design C1), l'agent ne l'applique pas.
**Geste** : dans `reposer()`, basculer en `echec` quand `tentatives >= 3` ; compteur d'échecs
consécutifs avec arrêt propre (motif existant dans l'agent récit) ; ne pas reprendre un id
déjà reposé dans le même passage.
Statut : **fait** le 2026-09-05 (chantier C3 point 6, lot 1 : `agent-courrier-ia.cjs` ne prend que `tentatives < 3`, exclut les ids reposés du passage, acte `echec` à la 3ᵉ, s'arrête à 4 échecs d'affilée ; `TravauxIaService.reprendrePerimes` acte aussi les `a-faire` au plafond) · vu le 2026-08-23

### AM-006 · [important] Consommateurs locaux : le clamp silencieux persiste des livrables vides
La « validation serveur » promise par C1 ne rejette jamais : `place-analysis.service.ts:454-465`
et `activity-report.service.ts:620-641` clampent une réponse malformée en livrable vide
persisté. Le filet Structured Outputs de l'API n'existe pas sur la voie CLI.
**Geste** : critère de conclusivité par consommateur (résumé non vide + longueur minimale)
qui JETTE — le `catch` route déjà vers `rejeter()`, donc retry puis `echec` marchent sans
autre changement.
Statut : **à faire** · vu le 2026-08-23

### AM-023 · [moyen] Double comptage des analyses de lieux dans les coûts IA
Une ligne `ai_usage_logs` écrite par le courrier (`agent-courrier-ia.cjs:116-124`) + une
seconde par le consommateur (`place-analysis.service.ts:253-268`).
**Geste** : une seule source d'écriture (le consommateur, qui connaît le résultat) ; le
courrier cesse de tracer pour les types que le serveur trace lui-même.
Statut : **fait** le 2026-09-05 (chantier C3 point 3, lot 1 : `tracerCout` supprimé du courrier, qui range les jetons réels dans `resultat` ; les deux consommateurs écrivent la ligne d'usage via `lireResultatLocal` ; les 20 doublons historiques relèvent de la migration de données du lot 2) · vu le 2026-08-23

### AM-032 · [moyen] Une panne serveur au login s'affiche « Identifiants invalides »
`login.component.ts:252-254,289-291` : un 500/timeout est présenté comme une erreur de mot de
passe — l'utilisateur s'acharne au lieu de signaler une panne.
**Geste** : distinguer 401 des autres échecs et afficher « service indisponible, réessayez ».
Statut : **à faire** · vu le 2026-08-23

## Trimestre — à planifier

### AM-007 · [important] Poste éteint 15 jours = zéro alerte
La sonde des tâches surveille les producteurs SERVEUR (qui tournent à vide) ; aucun signal si
les agents du poste s'arrêtent, et l'alerte promise sur le passage en `echec` d'un travail
n'existe pas (`scheduled-task-heartbeat.service.ts:94-140`, `travaux-ia.service.ts:81-84`).
**Geste** : étendre la sonde horaire aux agents du poste via les lectures d'état existantes
(passages, `max(createdAt)`, `provider='local'`), seuils de l'écran (13 h/30 h/36 h) ; faire
émettre une alerte par `reprendrePerimes()`/`rejeter()` au passage en `echec`.
Statut : **à faire** · vu le 2026-08-23

### AM-008 · [important] `/api/internal` exposé publiquement derrière un secret statique
Provision de flotte, kill-switch, création/suppression de comptes joignables d'Internet ;
comparaison non constante (`internal-secret.guard.ts:17`) là où le dépôt utilise
`timingSafeEqual` partout ailleurs.
**Geste** : sortir `/api/internal` du routeur public (routeur Traefik dédié + ipAllowList ou
rejet hors réseau interne) + `timingSafeEqual` + throttle serré + rotation du secret.
Statut : **à faire** · vu le 2026-08-23

### AM-009 · [important] Agents locaux en SSH root + SQL super-utilisateur sur la prod
Les 4 agents font `ssh root@VPS docker exec … psql -U tracky` (superuser) — tout incident de
prompt/parsing a les pleins pouvoirs sur la base.
**Geste** : utilisateur SSH dédié à commande forcée (limitée à `psql -U agent_local`) + rôle
Postgres `agent_local` minimal (SELECT ciblés, INSERT/UPDATE sur les seules tables des
agents). IP dans une variable d'environnement du poste.
Statut : **à faire** · vu le 2026-08-23

### AM-010 · [important] Tampon TCP par socket sans plafond ni contre-pression
`tcp-server.service.ts:81,117,120-128` : sans délimiteur, `buffer` croît sans borne ; le
`setTimeout(300_000)` est un timeout d'inactivité, réarmé à chaque octet. Port 5023 exposé,
pas de limite de connexions.
**Geste** : plafond par socket (4-8 Ko, une trame Coban fait quelques centaines d'octets),
fermeture + journal si dépassé ; limite de connexions ; `pause()/resume()` autour du drain.
Statut : **à faire** · vu le 2026-08-23

### AM-011 · [important] La table `alerts` n'a aucune rétention
~10 000 lignes/mois, aucune purge nulle part (grep exhaustif), et déjà un DELETE sauvage de
41 709 lignes avant le témoin TRK-035.
**Geste** : politique explicite (ex. 12 mois, aligné trajets), purge par lots tracée
RETENTION, entrée au tableau RGPD.
Statut : **à faire** · vu le 2026-08-23

### AM-012 · [important] Purge error_logs 30 j vs « on n'efface jamais le centre d'alerte »
`log-cleanup.service.ts:53-55` supprime à 30 j, `resolvedAt` compris — contradiction
textuelle avec la doctrine du 22/08 (`schema.prisma:2174-2187`).
**Geste** : trancher (exclure les résolues / assumer la purge), puis aligner code, schéma et
`docs/rgpd-retention-donnees.md` sur la même phrase.
Statut : **à faire** · vu le 2026-08-23

### AM-013 · [moyen] `api_traffic_logs` : IP sans purge, hors tableau RGPD
IP + user-agent à chaque hit public, aucune rétention, table absente de
`docs/rgpd-retention-donnees.md`.
**Geste** : rétention (ex. 90 j comme user_activities) + entrée RGPD.
Statut : **à faire** · vu le 2026-08-23

### AM-014 · [important] Suppressions véhicule/lieu : orphelins porteurs de localisation
`trip_analyses`, `trip_fuel_stops`, `place_analyses`, `agenda_agent_proposals` n'ont pas de
FK ; `vehicles.service.ts:624-637` et `fleet-places.service.ts:206` ne les nettoient pas.
**Geste** : suppression transactionnelle des satellites (motif de trips-retention) + balayage
nocturne « orphelins » compté et tracé RETENTION.
Statut : **à faire** · vu le 2026-08-23

### AM-015 · [important] Pas de CLAUDE.md ; README factuellement faux
Aucun point d'entrée versionné pour les agents IA ; README : Prisma 7 (faux), structure
incomplète (ni `outils/`, ni `deploy/`, ni `design/`, ni `docs/`) ; `.claude/commands/`
exclus de git.
**Geste** : CLAUDE.md racine (carte des répertoires, documents faisant foi, contrat de build
des agents, conventions) ; README corrigé ; `.gitignore` affiné (`.claude/*` sauf `commands/`).
Statut : **à faire** · vu le 2026-08-23

### AM-016 · [important] Contrats HTTP recopiés à la main dans 31 services Angular
~92 types locaux dupliqués (ex. `GpsDeadZoneDto` défini mot pour mot des deux côtés, sans
lien de compilation) — dérive silencieuse garantie.
**Geste** : règle « tout type qui traverse HTTP vit dans `packages/shared` » (au CLAUDE.md) +
migration opportuniste à chaque endpoint touché, en commençant par zones mortes, missions,
véhicules.
Statut : **à faire** · vu le 2026-08-23

### AM-017 · [important] Réglages : seul le dernier auteur est tracé, jamais l'avant/après
Les singletons (TripAutomationSettings, ActivityReportSchedule, PlaceAutomationSettings,
AiFeatureFlags, AiBudget…) perdent l'ancienne valeur — c'est la cause STRUCTURELLE des
« réglages modifiés sans décision tracée » du registre.
**Geste** : helper commun « journaliser un changement de réglage » → `system_activity_logs`
(catégorie SETTINGS, diff champ par champ + auteur), appelé par chaque setter.
L'infrastructure existe ; il ne manque que l'appel.
Statut : **à faire** · vu le 2026-08-23

### AM-018 · [important] Les cinq gardes de design ne sont câblées dans aucune commande
`pnpm verify` ne les exécute pas (`package.json:19-25`) : « bloquants » de nom seulement,
pure discipline.
**Geste** : les ajouter à `verify` (< 5 s au total), `verif:couleurs-kit` restant hors chaîne
tant que la décision n° 19 (viseur caméra) n'est pas tranchée.
Statut : **à faire** · vu le 2026-08-23

### AM-019 · [important] Suite de tests non déterministe — prérequis de toute CI
« Le vert absolu n'existe pas ici » (`docs/VERIFIER-AVANT-DE-DEPLOYER.md:48-65`) : tolérer le
rouge apprend — aux humains comme aux agents — à l'ignorer.
**Geste** : chasser les timers qui fuient (`--detectOpenHandles`, fake timers restaurés en
`afterEach` — motif de `tcp-server.service.spec.ts:53-56`) ; objectif mesurable : 10 runs
consécutifs verts, puis retirer la consigne de tolérance du runbook.
Statut : **à faire** · vu le 2026-08-23

### AM-020 · [important] Les 8 specs E2E Playwright dorment derrière des variables jamais posées
La recette reste 100 % manuelle alors que le mécanisme de session JWT locale est documenté et
pratiqué.
**Geste** : script qui pose les `E2E_*` et lance login + recette-responsive contre une base
seedée, planifié la nuit sur le poste comme les autres agents — la recette manuelle devient
une mesure récurrente.
Statut : **à faire** · vu le 2026-08-23

### AM-022 · [moyen] Traces IA locales : plafond contourné, verdicts `rejete` jamais tracés
L'INSERT SQL direct de l'agent récit (`agent-recit-trajet.cjs:288-292`) contourne le plafond
de 200/action et la troncature ; les rejets locaux — le lot qui a de la valeur — ne laissent
aucune trace à rejouer.
**Geste** : tracer aussi les rejets côté agents (verdict `rejete` + note), et faire passer
l'élagage par une requête que l'agent exécute lui-même après INSERT.
Statut : **à faire** · vu le 2026-08-23

### AM-025 · [moyen] Compteurs « restants » des récits : la fausse panne est garantie
Les compteurs incluent l'inéligible (`background-tasks.service.ts:671-696`) : « arriéré
résorbé » est inatteignable, la supervision criera au loup en fin de rattrapage.
**Geste** : compter sur le périmètre réellement éligible (fenêtre 48 h, flottes IA).
Statut : **à faire** · vu le 2026-08-23

### AM-026 · [moyen] Coupe-moteur : contournable par `raw`, fraîcheur non vérifiée à l'arrêt
Le gabarit `raw` (super-admin) ne reconnaît pas un motif de coupure
(`coban.catalog.ts:459`) ; la branche « à l'arrêt » lit la dernière position persistée sans
contrôle de fraîcheur (`engine-control.service.ts:311-320`).
**Geste** : refuser (ou tracer explicitement) un `raw` qui matche une commande moteur ;
appliquer le contrôle de fraîcheur aux deux branches. À trancher avec le propriétaire.
Statut : **à faire** · vu le 2026-08-23

### AM-027 · [important] Le serveur TCP peut ne jamais s'ouvrir, ou mourir, sans une ligne au centre d'alerte
`tcp-server.service.ts:51-53` ; le `/health` ne le couvre pas.
**Geste** : alerte CRITICAL à l'échec d'ouverture + sonde qui vérifie que le port écoute ;
exposer l'état dans `/health`.
Statut : **à faire** · vu le 2026-08-23

### AM-028 · [moyen] Colonnes PostGIS fantômes hors de `schema.prisma`
`positions.location` et `geofences.geometry` existent en base, pas dans le schéma, et ne
sont utilisées par aucun code — piège pour toute génération future de migration.
**Geste** : trancher (les documenter comme gérées à la main dans le schéma en commentaire, ou
les supprimer) — ne rien laisser d'implicite.
Statut : **à faire** · vu le 2026-08-23

### AM-029 · [moyen] `.env.prod.example` a dérivé de la réalité
Reconstruire le VPS depuis le dépôt produirait une configuration incomplète.
**Geste** : réaligner l'exemple (noms seuls, jamais les valeurs) + inventaire des secrets
dans `docs/` : nom, où il vit, qui le partage, comment le faire tourner, dernière rotation.
Statut : **à faire** · vu le 2026-08-23

### AM-030 · [moyen] Rotation des journaux conteneur non déclarée
Le stdout Pino est perdu à chaque recréation et sans borne entre-temps
(`docker-compose.prod.yml:89-159`).
**Geste** : `logging: { driver: json-file, options: max-size/max-file }` sur chaque service.
Statut : **à faire** · vu le 2026-08-23

### AM-033 · [important] Construire l'agent d'audit global (design C3)
LE chantier demandé par le propriétaire : chaque nuit une collecte déterministe des signaux
de toutes les sources de traçabilité ; chaque semaine une synthèse IA (via
`travaux_ia_locaux`, courrier inchangé) qui corrèle, priorise, et ALIMENTE CE FICHIER.
Détail complet : rapport d'audit du 23/08 (§ « L'agent d'audit global »).
Prérequis de visibilité : AM-003, AM-004, AM-007, AM-017, et le retrofit
`passages_agents_locaux` des agents limites-vitesse et récit (déjà tracé, ETAT § 4).
Statut : **à faire** · vu le 2026-08-23

## Année — dette de fond

### AM-024 · [important] Fichiers géants au cœur du produit
Mesuré le 23/08 (et en croissance) : `map.component.ts` 6 440 lignes (~2 480 de template
inline), `vehicle-detail` 3 173, `reports` 2 427, `agenda` 2 050, `email.service.ts` 1 884.
**Geste** : plan de découpe opportuniste — à chaque chantier qui touche un de ces fichiers,
en extraire un morceau cohérent (le template inline de map d'abord). Jamais de big-bang.
Statut : **à faire** · vu le 2026-08-23

### AM-031 · [moyen] La rétention vendue par abonnement n'est lue par aucun job
`retentionKey` ('90j' à '3ans') existe au catalogue mais la purge réelle est globale (60 j
positions, 12 mois trajets) quelle que soit l'offre.
**Geste** : trancher — brancher la purge sur l'offre, ou retirer la promesse du catalogue.
Statut : **à faire** · vu le 2026-08-23

### AM-034 · [moyen] Couplage fragile à la CLI Claude Code
Chemin absolu du binaire figé en deux exemplaires, détection d'authentification par regex
sur des messages non contractuels (`agent-courrier-ia.cjs:36-38,161-171`).
**Geste** : centraliser le chemin + la détection dans un petit module partagé des agents ;
un smoke-test hebdomadaire « la CLI répond-elle ? » tracé dans les passages.
Statut : **fait** le 2026-09-05 (chantier C3 point 3, lot 1 : `outils/cli-claude.cjs` — chemin unique, `verifierAbonnement()` via `claude auth status` à CHAQUE passage du courrier et des récits (refus journalisé en échec explicite), erreurs tirées de la sortie CLI, `node --test outils/cli-claude.test.cjs`) · vu le 2026-08-23

### AM-035 · [moyen] Étendre le témoin des disparitions au-delà de error_logs/alerts
`ai_usage_logs`, `passages_agents_locaux`, `trips`… peuvent être vidées hors application
sans qu'aucune trace ne nomme l'auteur (`recensement-suppressions.service.ts:215-226`).
**Geste** : étendre les déclencheurs aux tables de traçabilité (en veillant aux purges
légitimes, cf. décision n° 10 rôle dédié).
Statut : **à faire** · vu le 2026-08-23

---

## Pointeurs — déjà tracé ailleurs, ne pas recopier

- **Décisions n° 1-26** : `DECISIONS-A-TRANCHER-2026-08-23.md` (l'audit du 23/08 confirme en
  particulier l'urgence des n° 7 — API muette, 8-9 — clé SMS/.bak, 10 — DELETE/TRUNCATE,
  26 — CI ; et recommande de re-vérifier le n° 12 avant chantier, cf. § Corrections).
- **Vérifications dues** (V3, V4, terrain, recette manuelle) : `ETAT-RESTE-A-FAIRE-2026-08-22.md` § 1 et 3.
- **Chantiers agents** (retrofit passages, triage agenda, rapport d'activité, coaching) :
  `ETAT-RESTE-A-FAIRE-2026-08-22.md` § 4 + `ROADMAP-AGENTS-LOCAUX.md`.
- **Dette assumée** (lint API, budgets CSS, O4, O5) : `ETAT-RESTE-A-FAIRE-2026-08-22.md` § 5.

## Journal des passages de l'agent (à remplir par AM-033)

| Date | Nouvelles | Mises à jour | Passées `fait` | Résumé |
|---|---|---|---|---|
| 2026-08-23 | 35 (semis initial, audit humain+multi-agents) | — | — | Création du fichier |
