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

⚠️ **Correctif du correctif, le même jour (commit `5ec1804c`, PAS ENCORE DÉPLOYÉ).** Le budget
n'était vérifié qu'à l'entrée de chaque VÉHICULE. Le temps ne part pas là : il part dans la boucle
sur leurs TRAJETS (OpenStreetMap pour les limites, OSRM pour le calage sur route). Mesure après
déploiement : passage démarré à 11:45 UTC, toujours en cours à 12:20 — **35 minutes pour un plafond
annoncé à 20**. L'échéance est désormais lue dans la boucle des trajets, et un passage écourté le
dit dans le journal d'activité.

Leçon à garder : les deux versions passaient le typecheck et les tests. Seule la mesure en
production a montré que la borne était au mauvais endroit.

**Reste à observer** : que les tranches « 7-30 j » (854) et « 30-50 j » (1 190) baissent
effectivement. Il reste par ailleurs **4 845 trajets sans analyse** dans la fenêtre de 50 jours —
c'est ce retard-là qui fait durer les passages.

### 2. Retirer le bouton « Recalculer » de la page Rapports — ⏸ EN ATTENTE

Bloqué **volontairement** tant que le point 1 n'a pas fait ses preuves dans les chiffres. Le bouton
est aujourd'hui le seul moyen de rattraper un véhicule à la main ; le retirer avant d'avoir vérifié
que l'automatisation converge reviendrait à retirer le filet avant d'avoir vérifié le trapèze.

Emplacement : `apps/web/src/app/features/reports/reports.component.ts` (bouton admin `onRecompute`,
~ligne 285). L'endpoint `POST /api/trips/recompute` reste, il sert à l'automatisation.
→ **Contrôle navigateur à 375 px obligatoire** avant de considérer ce point terminé.

### 3. Colonne `executor` + affichage « absorbé par l'abonnement local » — 🔶 SERVEUR FAIT, UI À FAIRE

**Fait** : migration `20260819140000_qui_execute_l_appel_ia`, champ `executor` sur `AiUsageEntry`,
`absorbed` calculé dans `summary()`, `executor` exposé sur les lignes du journal, et couple
`executor` / `coutIa` sur les tâches de fond. Typecheck + 15 tests verts.

Deux points de conception à ne pas défaire :
- un appel local écrit `costUsd = 0`. Y inscrire le tarif théorique remplirait le budget mensuel
  avec de l'argent que personne n'a payé, et `monthBudgetExhausted()` finirait par couper l'IA
  payante à cause du travail gratuit ;
- `executor` et `coutIa` sont **deux dimensions indépendantes**. L'agent de limites de vitesse
  tourne en local ET ne coûte rien — parce qu'il interroge OpenStreetMap, pas parce qu'un
  abonnement l'absorbe. Les confondre afficherait une économie qui n'a jamais existé.

**UI faite** : encart « Absorbé par l'abonnement local » dans Coûts IA (masqué tant qu'aucun
appel local n'existe — il apparaîtra au premier passage d'un agent), et deux étiquettes sur la page
Crons : « poste local » (où ça tourne) et « IA absorbée » / « IA facturée » (qui paie).

⚠️ **Non vérifié à 375 px** — Docker Desktop n'était pas lancé, donc pas de pile locale. Typecheck
et 5 gardes passent, mais aucun écran n'a été regardé dans un navigateur.

### 4. Table de conservation des couples (entrée, sortie) IA — ✅ FAIT

`ai_agent_traces` + `AiTraceService` (@Global). Migration `20260819170000_traces_agents_ia`.
10 tests sur le service, 82 sur les suites touchées.

**Rétention tranchée : plafond de 200 PAR ACTION**, pas de purge par ancienneté. Une purge à N mois
effacerait intégralement les traces d'une action rare — précisément celle dont on a le moins
d'exemples et le plus besoin.

Trois points à ne pas défaire :
- le **verdict** (`concluant` / `rejete`) est le champ qui a de la valeur : il sépare les cas à
  rejouer du bruit. Une escalade de l'assistance compte comme `rejete` ;
- un payload trop gros est **marqué tronqué**, jamais coupé en silence ;
- pour l'assistance, les **lots de données du demandeur ne sont PAS recopiés** — seulement leur
  résumé d'audit. On perd le rejeu à l'identique, on évite une seconde copie de données
  personnelles hors de leurs règles de rétention.

⚠️ Vérifiable seulement en production : en local aucune clé IA n'est configurée, donc aucun appel
n'a lieu, donc aucune trace n'est écrite (comportement correct, verrouillé par un test).

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

### ☐ Assistance IA en direct — priorité 3 · **VIA L'API PAYANTE**

> **Virage assumé du 19/08.** La conception « différée + brouillon validé » est ABANDONNÉE.
> L'assistance répond en direct, via l'API Anthropic. C'est le seul poste de ce document qui
> dépense volontairement de l'argent, et c'est un choix produit : une réponse dans la seconde
> n'a rien à voir avec une réponse le lendemain.

**Contraintes non négociables**
- Réponses **courtes** et en français.
- **Lecture seule** : l'agent n'exécute aucune action, ne modifie rien.
- **Ne sort jamais du périmètre de l'app** : une question hors-sujet est recadrée, pas traitée.
- **Ne divulgue aucun secret** : ni chemin de fichier, ni nom de classe, ni variable
  d'environnement, ni détail d'infrastructure, ni donnée d'une autre société.
- **Tout est archivé** dans l'espace admin : relecture, correction, recontact.

**Base de départ : `d:/www/livrasante/apps/api/src/app/support/`** (~1 290 lignes, à reprendre et
améliorer — voir ci-dessous).

À reprendre tel quel, la structure est bonne :
- prompt système sectionné : produit / rôle / ce que je PEUX / ce que je NE PEUX PAS / style /
  sécurité / filtrage hors-sujet ;
- **plafond de messages par conversation** + instruction de conclusion quand le quota approche —
  c'est le garde-fou de coût, et il est bien pensé ;
- balise d'escalade vers un humain ;
- **rapport d'incident structuré en fin de conversation** (résumé, gravité, action humaine requise) :
  exactement la matière dont l'espace admin a besoin pour la relecture ;
- 3 réponses suggérées au conseiller humain ;
- réponse en streaming.

À corriger, livrasante s'en tire mal :
| Faiblesse | Correction |
|---|---|
| **Aucune journalisation de coût.** Le service appelle le SDK en direct. | Passer par `AiRouter` + `AiUsageService.record({ action: 'support_chat', executor: 'api' })`. Sinon l'assistance devient le seul poste de dépense invisible — l'inverse du point 3. |
| Modèle figé en dur (`claude-sonnet-4-20250514`) | Défaut configurable (Sonnet 5) + `effort` par appel, comme le reste de Tracky. |
| Rien contre l'**injection de prompt** | Le message utilisateur est une DONNÉE, jamais une instruction. À écrire explicitement, et à tester. |
| « Ne partage pas de données d'autres utilisateurs » posé en une ligne | Section refus explicite et énumérée, plus le scoping serveur — un prompt n'est pas un contrôle d'accès. |
| Plafond par conversation seulement | Ajouter un plafond **par utilisateur et par jour** : sinon on rouvre une conversation à l'infini. |
| Balise d'escalade fragile (le client peut l'écrire lui-même) | La retirer du texte affiché de façon robuste et ne la traiter que comme un signal serveur. |

**Périmètre de lecture — décidé le 19/08 : le plus large.** L'agent analyse la question, identifie
la fonctionnalité concernée, puis consulte l'activité du demandeur, les erreurs subies par son
compte, ses véhicules et ses trajets s'il y a droit. Ouvert à **tous les utilisateurs connectés**.

Architecture retenue, en **deux temps** plutôt qu'une boucle d'outils :

```
1. le modèle lit la question et choisit ce dont il a besoin -> sujets + lots de contexte
2. le SERVEUR va chercher ces lots, scopés sur le demandeur
3. le modèle répond avec les sujets retenus + les lots
```

Même capacité, mais **le modèle ne fournit jamais un identifiant** : il choisit des clés dans deux
listes fermées. S'il pouvait passer un identifiant de véhicule, une phrase bien tournée — ou un
texte piégé recopié depuis une alerte — suffirait à lui faire réclamer le véhicule d'une autre
société. Ici le paramètre n'existe pas. Bonus : coût borné à 2 appels par question, au lieu d'une
boucle dont on ignore la longueur.

**Avancement**

| Pièce | État |
|---|---|
| Tables `assistance_conversations` / `assistance_messages` + migration | ✅ |
| Couche de cloisonnement des lectures (5 lots, gardes de l'API) — 15 tests | ✅ |
| Base de connaissances (20 sujets) + 14 tests anti-divulgation | ✅ |
| Service IA en 2 temps + prompts système — 14 tests | ✅ |
| Coût journalisé sous `support_chat` / `executor: api` | ✅ |
| Plafonds par conversation et par utilisateur/jour | ✅ |
| Contrôleur + persistance + archive admin — 18 tests | ✅ |
| Bouton « rappel urgent » (côté serveur, alerte CRITICAL) | ✅ |
| UI client (chat) + UI admin (archive, relecture, correction, recontact) | ☐ |
| Notification push quand un humain reprend la main | ☐ |

⚠️ **La base de connaissances est un engagement d'entretien.** Une fonctionnalité livrée sans y
passer est une fonctionnalité sur laquelle l'agent répondra à côté, ou inventera. À traiter comme
la documentation d'une API publique, pas comme un fichier annexe.

### ~~Agent « assistance différée » (helper)~~ — ABANDONNÉ le 19/08

Conception initiale : questions posées le jour, réponses rédigées la nuit par un agent local, avec
validation humaine avant envoi. Remplacée par l'assistance EN DIRECT ci-dessus.

Ce qui survient de cette conception et reste à intégrer au direct :
- le bouton **« demander un rappel urgent »**, qui court-circuite l'IA et notifie le propriétaire et
  tous les super-admins. Une assistance en direct ne dispense pas d'une porte de sortie humaine ;
- la **notification push** quand un conseiller humain reprend la main après l'IA ;
- l'archivage intégral en espace admin — devenu une exigence explicite du direct.

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

### ⚠️ Le direct ne rentre pas dans le modèle local — et c'est assumé

Répondre en quelques secondes, 24/7, PC éteint compris : un agent local ne sait pas le faire. C'est
pourquoi l'assistance en direct passe par l'API payante. C'est le SEUL poste de ce document qui
dépense volontairement, et il doit donc être le plus surveillé : plafond par conversation, plafond
par utilisateur et par jour, et coût journalisé sous l'action `support_chat`.

Corollaire à ne pas perdre de vue : cet agent ne pourra pas lire le code source pour répondre, là où
la version nocturne locale l'aurait pu. Sa connaissance de l'app doit donc être ÉCRITE quelque part
et tenue à jour — c'est un travail de fond, pas un effet de bord du prompt.

---

## Questions ouvertes

- **Rétention** des traces IA (point 4) : plafond par action, ou purge à N mois ?
- **`lookbackHours`** reste à 1200 (50 jours). Avec les tranches bornées c'est tenable — c'est cette
  valeur qui définit jusqu'où on rattrape.
- **`narrateEnabled`** reste à `false`. Il ne sera rebasculé que si l'agent local prend le relais,
  jamais pour repasser par l'API.
