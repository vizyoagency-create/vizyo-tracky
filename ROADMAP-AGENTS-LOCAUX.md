# Roadmap — bascule des traitements IA vers des agents locaux

> **Fichier de suivi temporaire.** À supprimer quand tout est livré.
> Créé le 19/08/2026. Dernière mise à jour : 19/08/2026.

## Pourquoi

Les traitements IA de Tracky tournent sur l'API Anthropic payante. Le poste du propriétaire est
allumé en permanence et dispose d'un abonnement Claude Code : les traitements **par lots et en
différé** peuvent y être exécutés gratuitement. Ce document suit cette bascule.

Ce qui **ne** bascule **pas** : tout ce qui doit répondre en quelques secondes, 24/7, même PC
éteint. C'est le seul cas où l'API payante reste le bon outil.

## Les trois principes (repris de `agent-limites-vitesse`)

1. **La logique métier vit dans un module PUR** importé depuis `apps/api/dist`, consommé par l'app
   ET par l'agent. Jamais de duplication : deux copies divergent et l'agent finit par écrire des
   données que l'app n'aurait jamais produites. L'agent **refuse de démarrer** si le module compilé
   est absent.
2. **On n'écrit QUE ce qui est concluant.** Toute réponse douteuse est une panne : on n'écrit rien
   et on réessaiera.
3. **L'agent figure au catalogue** de `apps/api/src/background-tasks/background-tasks.service.ts`,
   avec son état déduit du **travail réellement écrit en base**, pas d'un signal de démarrage.
   ⚠️ Fuseau : constante `PARIS`, jamais `SERVER_TZ` — le VPS tourne en UTC, le poste en heure de Paris.

**Cadence retenue : 1 passage par 24 h.** Le débit n'est pas le facteur limitant ; la régularité et
la traçabilité le sont. Un agent qui tourne une fois par nuit est plus simple à superviser qu'un
agent qui s'exécute cinq fois par jour, et le poste est dédié à ça.

---

## État mesuré au 19/08/2026

| Fait | Valeur | Source |
|---|---|---|
| Dépense IA juillet | 51,65 $ | `ai_usage_logs` |
| Dépense IA août à ce jour | **0,51 $** | `ai_usage_logs` |
| Récits de trajet écrits | 2 556 | `trip_analyses.narrative` |
| Récits de trajet **consultés** | **5, par 2 utilisateurs**, dernier le 30/07 | `user_activities` |
| Propositions d'agenda en attente | **1 328**, dont 0 validée et 0 rejetée | `agenda_agent_proposals` |
| Analyses sans limite de vitesse connue | **4 440 / 6 962 (64 %)** | `trip_analyses.limitsKnown` |
| Trajets encore bruts (non recalculés) | 2 158 sur 50 jours | `trips.segmentationSource` |
| Flottes avec IA active | 1 sur 5 (`cdef31`) | `fleets.aiEnabled` |

Deux interrupteurs indépendants gouvernent la dépense : `fleets.aiEnabled` (par société, opt-in) et
`trip_automation_settings.narrateEnabled` (global). **Rebasculer `narrateEnabled` à `true` coûte
~386 $/an** — ce n'est pas un réglage anodin.

---

## Chantiers, dans l'ordre

### 1. Recalcul des trajets par tranches bornées — ✅ FAIT (déployé 19/08 11:13 UTC)

Commit `8a90ac21`. Le cron horaire ne terminait plus : un vieux trajet brut déclenchait un recompute
sur 50 jours, bloquait les passages suivants via le verrou `running`, et se faisait tuer au
redémarrage sans rien persister.

- `RECOMPUTE_SLICE_MS` (48 h) borne l'amplitude d'un recalcul ; la reprise est sans état.
- `RUN_BUDGET_MS` (20 min) : un passage ne peut plus déborder sur le suivant.
- Tranche sans position → on ne supprime rien, on compte et on remonte au centre d'alerte.

**Reste à observer** : que les tranches « 7-30 j » (854) et « 30-50 j » (1 207) baissent
effectivement. Contrôles programmés le 19/08 à 13:52 et le 20/08 à 08:14.

### 2. Retirer le bouton « Recalculer » de la page Rapports — ⏸ EN ATTENTE

Bloqué **volontairement** tant que le point 1 n'a pas fait ses preuves dans les chiffres. Le bouton
est aujourd'hui le seul moyen de rattraper un véhicule à la main ; le retirer avant d'avoir vérifié
que l'automatisation converge reviendrait à retirer le filet avant d'avoir vérifié le trapèze.

Emplacement : `apps/web/src/app/features/reports/reports.component.ts` (bouton admin `onRecompute`,
~ligne 285). L'endpoint `POST /api/trips/recompute` reste, il sert à l'automatisation.
→ **Contrôle navigateur à 375 px obligatoire** avant de considérer ce point terminé.

### 3. Colonne `executor` sur `ai_usage_logs` + affichage « absorbé par l'abonnement local » — ☐ À FAIRE

Validé côté contrat d'API. Sans ça, un agent local travaille **sans laisser de trace** dans les
écrans de coûts — l'inverse de ce qu'on veut.

- Migration Prisma : `executor` (`api` | `local`), défaut `api`, non nullable.
- Les agents locaux écrivent leurs passages avec `costUsd = 0` et `executor = 'local'`.
- Page **Coûts IA** (`admin-ai-usage.component.ts`) : distinguer visuellement les deux, et afficher
  ce que l'abonnement local a **absorbé** (le coût qu'aurait eu le même travail via l'API).
- Page **Crons** (`background-tasks.service.ts`) : chaque agent local y figure avec son état déduit
  du travail écrit.

⚠️ Le champ ajouté au DTO doit être **optionnel** côté lecture pour ne pas casser un client déployé.

### 4. Table de conservation des couples (entrée, sortie) IA — ☐ À FAIRE

Aujourd'hui on conserve le **résultat** (`activity_reports.content`, `trip_analyses.narrative`) mais
**pas le payload envoyé au modèle**. Or c'est le couple qui permet d'améliorer un agent.

Table dédiée (nom proposé : `ai_agent_traces`) : action, executor, modèle, payload d'entrée, réponse
brute, durée, verdict (concluant / rejeté), horodatage. Aucune table existante touchée.

À décider : la rétention. Ces lignes grossissent vite — un plafond par action, ou une purge à N mois.

### 5. Agents — voir le catalogue ci-dessous

---

## Catalogue des agents

Légende : ✅ en service · ☐ à faire · ⏸ bloqué

### ✅ Limites de vitesse OSM (`outils/agent-limites-vitesse.cjs`)

Le modèle de référence. Gratuit (Overpass), 5 créneaux quotidiens, tâche planifiée
`VizyoTracky-LimitesVitesse`. **Toujours du travail** : 4 440 analyses sur 6 962 (64 %) n'ont pas
de limite connue, donc aucun excès n'y est affirmable.

### ☐ Agent « récit de trajet » — priorité 1

| | |
|---|---|
| Remplace | `trip_analysis` via l'API (45,89 $ en juillet, ~386 $/an si rallumé) |
| Produit | `narrative` + `advice` + Trust Score sur `trip_analyses` |
| Volume | 89 trajets/j (cdef31 seule) à 170/j (3 flottes) |
| Cadence | **1 passage nocturne**, lots de ~20 trajets par invocation |
| Module pur à extraire | `compactPayload()` + `renderTripNarrativeSystem()` + assainissement, depuis `trip-analysis-llm.service.ts` (privé, lié à Prisma) |

**Améliorations à prévoir** (le budget de tokens n'est plus une contrainte) :
- passer le trajet **entier** plutôt qu'un résumé compact ;
- donner le contexte des trajets précédents du même véhicule (récurrence, habitudes) ;
- croiser avec les géofences traversées et les lieux connus (`fleet_places`) ;
- ne plus plafonner `maxTokens: 1200`.

⚠️ Garder en tête : 5 consultations en tout à ce jour. Générer pour tout le monde n'a de sens que
parce que c'est désormais gratuit — pas parce que c'est lu.

### ☐ Agent « qualité GPS / zones mortes » — priorité 2

Le plus riche analytiquement, et sans aucun risque client (diagnostic interne).

| | |
|---|---|
| Matière première | `gps-integrity`, `gps-dead-zones`, `tracker-fix-mode`, `positions`, `trackers.lastSeenAt` |
| Produit | Un diagnostic par boîtier douteux : nature du défaut, zone géographique concernée, antériorité, et **conclusion actionnable** (boîtier à remplacer / zone réellement sans couverture / défaut d'installation) |
| Cadence | 1 passage nocturne |
| Pourquoi un agent | Le croisement « trous de trame × géographie × historique du boîtier × modèle de tracker » est exactement ce qu'un humain fait mal et lentement, et qu'une règle déterministe fait mal aussi (une zone sans couverture et un boîtier mourant produisent la même trace brute). |

À concevoir : l'agent doit **distinguer** une zone morte (plusieurs véhicules, même endroit) d'un
boîtier défaillant (un véhicule, partout). C'est la conclusion qui a de la valeur, pas le constat.

### ☐ Agent « assistance différée » (helper) — priorité 3

**Le principe : ce n'est PAS de l'assistance live.** Les gens n'aiment pas parler à un robot en
direct. Ici l'agent sert les **questions curieuses** — « pourquoi mon score de conduite a baissé ? »,
« à quoi sert cet écran ? », « pourquoi ce trajet est coupé en deux ? » — avec une réponse écrite,
en français, rédigée pendant la nuit.

**Parcours utilisateur**
1. L'utilisateur ouvre **Assistance**, écrit sa question. L'écran annonce clairement :
   « Vous recevrez une réponse sous 24 h maximum. »
2. Un bouton distinct **« Demander un rappel urgent »** : ne passe **pas** par l'agent, notifie
   immédiatement le propriétaire et tous les super-admins. Un humain rappelle.
3. La nuit, l'agent local lit les questions en attente, **analyse le code du dépôt** si nécessaire,
   et rédige une réponse en français, dans le vocabulaire du client (jamais de chemin de fichier,
   jamais de nom de classe).
4. Notification push à l'utilisateur quand la réponse est disponible.

**Pourquoi cet agent ne peut tourner QUE en local** : il a besoin du dépôt pour répondre. L'API en
production n'a pas le code source sous la main — le VPS n'héberge que le build. C'est le seul agent
de la liste dont l'exécution locale est une nécessité technique, pas une économie.

**Décision prise (19/08) — BROUILLON VALIDÉ, jamais de publication directe.**
L'agent rédige, le super-admin valide d'un clic avant envoi au client. Deux raisons : une réponse
fausse à un client coûte plus cher qu'un délai, et un agent qui lit le code source peut laisser
filer un détail interne (architecture, faiblesse, données d'un autre client). Même schéma que les
propositions d'agenda (`pending` → `applied`), déjà éprouvé dans l'app.

Conséquence à ne pas oublier au moment de l'écran : le délai annoncé au client (« sous 24 h ») court
jusqu'à la **validation humaine**, pas jusqu'à la rédaction de l'agent. Si personne ne valide, la
promesse est rompue — il faut donc une relance vers les super-admins sur les brouillons en attente.

**Infrastructure existante réutilisable** : `notifications/web-push.service.ts` (VAPID déjà en
place), `notification-center`, `notification-preferences`.

**À créer** : table des questions (question, auteur, société, statut, urgence, brouillon, réponse
publiée, horodatages), page Assistance côté client, page de validation côté admin.

### ☐ Agent « triage des propositions d'agenda » — priorité 4

Reprend le `keep` / `reasoning` coupé le 19/08 (kill-switch `ai_feature_flags.agendaAgent = false`),
mais gratuitement. **1 328 propositions attendent un tri que personne ne fera jamais à la main** —
c'est le vrai problème, pas les 17 $/an que coûtait la couche IA.

Cadence : 1 passage nocturne, 30 motifs max. Module pur à extraire : le rendu du prompt et le
schéma depuis `agenda-agent.prompt.ts`.

### ☐ Agent « rapport d'activité » — priorité 5

Économie ridicule (8 $/an en hebdomadaire). **La seule raison de le faire est la qualité** : les
plafonds actuels (`JOURNEY_CAP` 120 lignes, 800 événements bruts, 20 cibles, `maxTokens: 16000`)
existent parce que les tokens coûtent. En local ils sautent : fenêtre d'un mois, parcours complet,
raisonnement long.

Module pur à extraire : `buildPayload()` (11 requêtes Prisma par utilisateur) + `sanitize()` +
`ACTIVITY_REPORT_SYSTEM`. C'est l'extraction la plus lourde des cinq.

### ⏸ Agent « coaching conducteur » (score de conduite) — bloqué

Synthèse hebdomadaire par conducteur à partir des scores déterministes.

**Bloqué par un prérequis dur** : 64 % des analyses ont `limitsKnown = false`. Sans limite de
vitesse connue, aucun excès n'est affirmable et le coaching porterait sur du vide. L'agent limites
de vitesse doit d'abord finir son rattrapage. **Ne pas démarrer celui-ci avant que ce ratio soit
descendu sous ~20 %.**

### ❌ Assistant conversationnel temps réel — écarté

Répondre en quelques secondes, 24/7, PC éteint compris : ne rentre pas dans le modèle local. Si ce
besoin apparaît, c'est l'API payante ou rien. Ne pas le promettre.

---

## Questions ouvertes

- **Rétention** des traces IA (point 4) : plafond par action, ou purge à N mois ?
- **`lookbackHours`** reste à 1200 (50 jours). Avec les tranches bornées c'est tenable — c'est cette
  valeur qui définit jusqu'où on rattrape.
- **`narrateEnabled`** reste à `false`. Il ne sera rebasculé que si l'agent local prend le relais,
  jamais pour repasser par l'API.
