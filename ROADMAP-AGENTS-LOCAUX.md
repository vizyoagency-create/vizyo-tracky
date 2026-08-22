# Roadmap — bascule des traitements IA vers des agents locaux

> **Fichier de suivi temporaire.** À supprimer quand tout est livré.
> Créé le 19/08/2026. Dernière mise à jour : 22/08/2026.

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

### 3. Colonne `executor` + affichage « absorbé par l'abonnement local » — ✅ FAIT

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

**UI faite et VÉRIFIÉE à 375 px le 19/08** : encart « Absorbé par l'abonnement local » dans Coûts
IA (exercé avec des lignes locales injectées puis supprimées — les deux branches passent : montant
chiffré depuis les tokens, et action sans référence API nommée comme non estimable), et deux
étiquettes sur la page Crons — « poste local » sur 1 tâche, « IA facturée » sur 4.

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

### ✅ Agent « récit de trajet » — EN SERVICE depuis le 20/08

`outils/agent-recit-trajet.cjs` + `.cmd`, tâche planifiée **VizyoTracky-RecitTrajet** (03:15,
compte YOUNESS). Module PUR partagé : `apps/api/src/trip-analysis/trip-narrative.shared.ts` — le
service de l'API a été refactoré pour l'utiliser, il n'existe donc qu'une implémentation.

**Périmètre arrêté : le COURANT seulement** (48 h), pas l'historique. Décision du 20/08.

Trois pièges mesurés, à ne pas réintroduire :
- la CLI ne se lance pas par `execFileSync('claude')` sous Windows — viser `claude.exe` ;
- **un appel par trajet n'est pas tenable** : chaque invocation renvoie tout le contexte de la CLI.
  Grouper (5 par appel) n'est pas une optimisation, c'est la condition pour tenir dans une nuit ;
- la fenêtre porte sur `trips."startedAt"`, PAS sur `trip_analyses."updatedAt"` — l'analyse
  rattrape son retard, donc les vieilles lignes ont une date fraîche : 4 761 candidats au lieu
  de 234 ;
- l'agent doit écrire `"updatedAt" = now()` LUI-MÊME. L'annotation Prisma est appliquée par le
  client, pas par la base : sans ça la supervision affichait un agent à l'arrêt pendant qu'il
  travaillait.

**Coût du choix, assumé** : par unité de travail, l'agent local consomme ~3 à 4 fois plus de
modèle que l'API ne coûterait. L'économie vient de ce que l'abonnement est déjà payé.

### 🔶 Agent « qualité GPS / zones mortes » — EN SERVICE, écran à vérifier

Module PUR livré : `apps/api/src/gps-dead-zones/gps-diagnostic.shared.ts`, 11 tests.

Le manque comblé : les zones de perte sont apprises PAR VÉHICULE, donc personne ne pouvait
répondre à « est-ce le LIEU ou le BOÎTIER ? ». Il faut croiser les véhicules entre eux.

Sur les vraies données (18 zones, 10 véhicules) : **1 boîtier, 3 lieux, 5 indéterminés**. Le
boîtier signalé est KSR370 — le même que celui repéré indépendamment par ses 599 trajets non
recalculés et son boîtier muet depuis 5 jours.

**Destination décidée le 20/08 :**

| Nature | Où |
|---|---|
| Boîtier défaillant | **centre d'alerte** — action datée, canal déjà surveillé |
| Zone morte (lieu) | **table dédiée + écran** — qualification durable |
| Indéterminé | nulle part : on ne remonte pas ce sur quoi on n'a pas conclu |

**État au 20/08 16 h :**

| Pièce | État |
|---|---|
| Module pur + 11 tests | ✅ |
| Agent `outils/agent-qualite-gps.cjs` | ✅ tourne, aucun modèle appelé |
| Migration `20260820100000_diagnostics_zones_gps` | ✅ déployée en prod |
| Alerte boîtier (KSR370, `GPS_QUALITE`) | ✅ en prod |
| API `GET/POST /api/gps-diagnostics/zones` + 8 tests | ✅ |
| Écran `/admin/qualite-gps` + carte dans le hub admin | ✅ **vérifié à 375 px le 20/08** |
| Tâche planifiée `VizyoTracky-QualiteGPS` | ✅ 05:00 chaque nuit, lancée une fois pour vérifier |
| Inscription au catalogue des tâches de fond | ✅ `agent-qualite-gps` |
| Traçabilité des passages (`passages_agents_locaux`) | ✅ locale — **migration à déployer en prod** |

**La tâche.** `VizyoTracky-QualiteGPS`, 05:00 chaque nuit, lanceur `outils/agent-qualite-gps.cmd`.
05:00 et non 03:15 : l'agent de récit occupe déjà cette tranche et peut courir 110 minutes ; deux
agents en même temps sur le même poste ne servent personne. `IgnoreNew` (un passage qui traîne
n'est pas doublé), plafond 2 h, et `StartWhenAvailable` — contrairement à l'agent de récit :
arriver en retard vaut mieux que sauter la nuit, alors que pour les récits le rattrapage se fait
tout seul au passage suivant.

Lancée une fois le 20/08 à 18 h 13 pour vérifier, pas pour supposer : `LastTaskResult = 0`,
`NextRunTime = 21/08 05:00`, et le catalogue annonce le même instant (`nextRunAt` 03:00 UTC =
05:00 Paris) — le fuseau `PARIS` est donc bien appliqué.

**Pourquoi une table de passages, et pas la méthode des deux autres agents.** Les agents de
limites de vitesse et de récit prouvent qu'ils vivent par ce qu'ils ÉCRIVENT. C'était juste pour
eux : ils ont toujours du travail en attente, donc une date qui n'avance plus est vraiment une
panne. **Celui-ci peut légitimement ne rien écrire d'une nuit** — aucune zone partagée, aucun
boîtier dispersé — et c'est le résultat qu'on espère. Copier leur raisonnement aurait affiché
« agent à l'arrêt » précisément les nuits où le parc va bien, et une supervision qui crie au loup
quand tout va bien finit par ne plus être lue.

D'où la séparation stricte, et c'est tout l'intérêt de la table :

| Question | Réponse |
|---|---|
| a-t-il **tourné** ? | `passages_agents_locaux`, une ligne par passage, **même vide** |
| a-t-il **trouvé** ? | ses écritures métier, inchangées |

La ligne n'est écrite qu'à la **fin**, avec son issue : un marqueur posé au démarrage mentirait
exactement comme le faisait `psql` en sortant en 0 sur une erreur SQL. Et son échec n'échoue
jamais le passage : le travail métier est déjà en base, le perdre pour un problème de journal
serait absurde. Vérifié pour de vrai — au premier lancement la table n'existait pas encore en
production, l'agent a fait son travail, consigné l'échec de traçage en une ligne, et rendu 0.

⚠️ **À déployer** : `20260820180000_passages_agents_locaux`. Tant qu'elle n'est pas en production,
l'agent travaille normalement mais la page des tâches de fond affiche « inconnu » pour lui.

☐ Retrofit des deux autres agents locaux sur cette même table — leur méthode actuelle marche,
mais deux façons de répondre à « cet agent tourne-t-il ? » finiront par diverger.

Premier passage réel en production (20/08 13 h 44) : **1 lieu enregistré** — `FW-298-WV` et
`GS-928-NX` perdent le signal au même endroit à Toulouse (43,5979 / 1,4300), 2 fois. Le boîtier
KSR370 n'a PAS été re-signalé : la garde des 7 jours a fait son travail.

Reste : la tâche planifiée, et la vérification de l'écran à 375 px.

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
| UI client (chat) + UI admin (archive, relecture, correction, recontact) | ✅ livrés le 19/08 (`6a83ec61`, lien d'accès corrigé par `07d4f94a`) |
| Notification push quand un humain reprend la main | ✅ livrée le 19/08 (`ac171fae` — ouverture de demande + reprise humaine, via `NotificationDispatchService`) |

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

## Registre des points ouverts

> Tenu à jour à chaque passage. Un point qui disparaît d'ici doit avoir été tranché, pas oublié.

### Décisions en attente

| # | Point | Depuis |
|---|---|---|
| D1 | **Rôle DEPOT et assistance.** Je l'ai écarté (allowlist default-deny, cohérent avec la décision déjà prise pour l'état IA), alors que la consigne était « tous les utilisateurs connectés ». Un décorateur suffit à l'ouvrir. | 19/08 |
| D2 | **Rôle NIGHT_WATCHMAN et assistance.** Même situation : son confinement est une allowlist posée à la demande du client (« aucune donnée pour ce rôle »). Non élargie. | 19/08 |
| ~~D3~~ | ~~**`BgTaskExecution` vs `BgTaskExecutor`**~~ — vérifié le **22/08** : **sans objet dans le code commité**. `BgTaskExecution` n'apparaît nulle part dans l'historique du code (`git log -S BgTaskExecution` ne trouve que l'ajout de cette ligne au registre) ; le DTO ne porte que `BgTaskExecutor` et `BgTaskCoutIa`, deux dimensions volontairement **distinctes** (`packages/shared/src/dto/background-task.dto.ts:35-49`). Le doublon décrit ici a vraisemblablement été purgé avant le commit du 19/08. Rien à retirer. | ~~19/08~~ |
| ~~D5~~ | ~~**Agenda IA — réponse tronquée**~~ — tranché par le propriétaire le 21/08 : **plafond relevé** à 16 000 jetons (et non période réduite). C'est un plafond, pas une réservation : les appels qui tenaient déjà coûtent identique. | ~~21/08~~ |
| D4 | **Traces de l'assistance** : les lots de données du demandeur sont réduits à leur résumé, jamais recopiés. On perd le rejeu à l'identique, on évite une seconde copie de données personnelles. À confirmer ou inverser. | 19/08 |

Contrôle du **22/08** (audit des restes) : **D1, D2 et D4 restent en attente** — aucun
commit ne les tranche. L'état du code correspond à leur description : pour D1, le
commentaire de `assistance.controller.ts:31-35` documente l'écart et « un décorateur
suffit à l'ouvrir » reste vrai. La liste complète des décisions en attente est
consolidée dans `ETAT-RESTE-A-FAIRE-2026-08-22.md`.

### Vérifications dues — rien ne les remplace

| # | À vérifier | Bloqué par | Depuis |
|---|---|---|---|
| ~~V1~~ | ~~**Écran `/admin/qualite-gps` à 375 px**~~ | — | **Fait le 20/08 17 h 45** |
| **V3** | **Deux boîtiers vivants SANS position GPS — à voir sur le terrain.** `GS-014-NY` (IMEI 864035054756169) et `HD-686-QX` : le boîtier communique mais n'accroche aucun satellite. Antenne débranchée, mal placée ou HS. Relevé par `gps-integrity` les 20 et 21/08 — le seul sujet du centre d'alerte qui appelait une action humaine, conservé ici avant le nettoyage du 21/08. | Accès physique aux véhicules | 21/08 |
| ~~V2~~ | ~~**Véhicule HORS SERVICE — la recette sur données réelles**~~ | — | **Fait le 21/08 21 h 20** |
| **V4** | **Chaîne analyse-lieux de bout en bout, sur des faits.** L'automatisation a été **activée le 22/08 vers 8 h** (Paris) via l'écran `/admin/place-automation`, après simulation conforme : **2 candidats** (flotte cdef31), **8 lieux écartés** (société sans IA), 0 inchangé, 0 trop récent, coût estimé 0,04 €, arrêt « Terminé ». Reste à prouver le cycle complet du 23/08 : travail dans `travaux_ia_locaux` après 03:10, livré par le courrier après 06:30, rangé après 07:10 avec `costEur = 0`, `executor = local`, un résumé qui parle des vrais passages — puis l'écran `/places` à 375 px. Requêtes de vérification : `design/C2-ACTIVATION-ANALYSE-LIEUX.md` § 4, geste 3. | Cycle 03:10 → 07:10 du 23/08 | 22/08 |

### Audit des restes et de la documentation — passage du 22/08 au soir

**Fait** : chaque entrée du registre confrontée au code (D3 tranché sans objet ; D1, D2,
D4, V3, V4 confirmés en attente), bandeaux d'état datés posés sur les documents
historiques qui se présentaient comme courants (racine : `SUIVI-REFONTE.md`,
`REFONTE-TRACKY-V2.md`, `REPRISE-A3.md`, `REPRISE-B-PAGES.md`, `TEST_PLAN.md`,
`DEPLOY_AUDIT_V1.10.md`, `PERMISSIONS_AUDIT.md` ; et une douzaine sous `docs/`),
`design/TOKENS.md` complété (règle `--tracky-light` jamais en fond, bornes de lavis
bleu ≤ 12 % / violet ≤ 10 %, jetons `--texte-lime`/`--texte-orange`, garde à 168 couples),
`design/C2-ACTIVATION-ANALYSE-LIEUX.md` daté (gestes 1-2 faits le 22/08, geste 3 dû le
23/08 = V4), et les ~70 marqueurs « à faire » des `.md` classés fait / obsolète / encore dû.

**Résultat consolidé** : **`ETAT-RESTE-A-FAIRE-2026-08-22.md`** à la racine — la synthèse
priorisée de tout ce qui reste (décisions du propriétaire, vérifications datées, recette
humaine, dette assumée, docs à trancher). C'est ce fichier qui fait foi sur « que
reste-t-il ? » à cette date.

### Deux pièges du Planificateur de Windows — relevés le 22/08 au matin

**Une tâche PONCTUELLE avec `DeleteExpiredTaskAfter` peut disparaître AVANT d'avoir tourné.**
La tâche qui devait restaurer les réglages du cron (fenêtre 1 500 h → 26 h) le 22/08 à 21 h
n'existait plus au matin, sans avoir jamais été déclenchée. Rien ne le signalait : une tâche
absente ne produit aucune trace. Les réglages ont donc été restaurés à la main, une fois la
convergence constatée finie. **Leçon : ne jamais confier une action importante à une tâche
ponctuelle auto-supprimable — la vérifier, ou la faire tout de suite.**

**`StartWhenAvailable` n'était pas posé sur `VizyoTracky-RecitTrajet`.** Son créneau de 03:15
a donc été perdu dans la nuit du 21 au 22 (dernier passage le 21, prochain le 23 : le 22 sauté
sans un mot). L'impact réel est faible — sa fenêtre couvre 48 h, donc la nuit suivante rattrape,
et le rattrapage toutes les 2 h couvre de toute façon le même terrain. Corrigé le 22/08.

⚠️ **Ce qu'aucun des deux ne dit tout seul** : un créneau manqué ne laisse AUCUNE trace côté
application. L'écran des traitements montre « dernier passage » — encore faut-il le regarder.
C'est la limite structurelle des agents sur poste, et la raison d'être de l'état déduit du
travail écrit plutôt que d'un signal de démarrage.

**V2 — recette faite le 21/08, sur la production, avec ses témoins.** Ce qui a été exercé :

| Contrôle | Résultat |
|---|---|
| 375 px, débordement horizontal | aucun — carte 343 px, bannière et note comprises |
| Cible tactile du sélecteur | 44 px · contraste 8,28:1 au pire (seuil 4,5) |
| Confirmation **annulée** | le sélecteur revient, **aucun appel réseau** |
| Confirmation acceptée | carte en alerte, bannière datée, note rangée |
| **Remise en service** | tout se retire, et aucune note n'est demandée |
| Carte pour un FLEET_ADMIN | **absente** — et **présente** sur LA MÊME fiche en super-admin |
| API forcée par un FLEET_ADMIN | **403** — son jeton passe en 200 ailleurs, donc c'est bien la garde |
| Motif inventé · véhicule inconnu | **400** · **404** |
| Agenda : véhicule réellement proposé | 34 → **33** une fois immobilisé → **34** après remise en service |

⚠️ **Deux pièges rencontrés, notés pour les prochaines recettes.**
1. **Le premier essai d'exclusion agenda portait sur KSR370 — et ne prouvait RIEN** : il est
   dormant (boîtier muet depuis 7 j), donc déjà écarté pour une autre raison. Il a fallu prendre
   un véhicule *réellement proposé* pour que le test ait un sens. Un témoin, toujours.
2. **La carte ACC ne sert pas de témoin de rôle** : elle exige aussi un boîtier, donc son absence
   peut venir du matériel et non du rôle. La comparaison valable est la même fiche vue par les
   deux rôles.

**Reste à faire par le propriétaire** : un passage à la main. Les interactions ont été déclenchées
par script (le panneau navigateur ne compose pas les frames ici, cf. la limite notée en V1) — la
chaîne complète est exercée, mais pas par un vrai clic.

**V2 — pourquoi cet état existe, et ce qu'il ne fait PAS.** Un véhicule qui ne roule plus reste
sinon dans le périmètre de tous les traitements. Mesure du 21/08 sur KSR370, accidenté : **843
trajets à re-segmenter et 1 309 à analyser, soit 99 % du reste-à-faire de toute la flotte** pour un
seul véhicule immobilisé — les compteurs de convergence ne voulaient plus rien dire, et chaque
passage horaire repayait ce travail sans issue. L'état retire le véhicule du périmètre de l'analyse
des trajets, de la veille accident et du détecteur de perte GPS.

⚠️ **Il ne supprime RIEN et ne fige rien en base.** C'est un interrupteur : une remise en service
fait tout reprendre où ça en était. C'est la condition pour que ce soit utilisable — un état dont
on ne sait pas sortir ne serait jamais posé. Trois motifs distincts (accident, boîtier débranché,
immobilisation) parce qu'ils ne se résolvent pas de la même façon.

**V1 — vérifié dans le navigateur à 375 px, sur données réelles.** Rendu, carte du hub (343 px de
large sur 375, aucun débordement horizontal), chargement, « marquer traité », bascule
« afficher les traités », réouverture, état vide. Un défaut trouvé, que ni le typecheck ni les
tests d'API ne pouvaient voir — cf. ci-dessous.

**Le défaut que seule la vérification pouvait trouver.** Le serveur avait été corrigé pour ne pas
effacer la note à la réouverture, et il la conservait bien : la base le confirmait. Mais l'écran
ne la ré-affichait pas — une zone rouverte troque son bloc de relecture contre un champ de saisie,
et ce champ revenait vide. Du point de vue du relecteur la note était donc perdue ; il en aurait
tapé une autre et écrasé la première sans jamais avoir su qu'elle existait. **Une donnée conservée
mais invisible est une donnée perdue.** Corrigé par `reporterNotes()`, fonction pure testée
séparément (5 tests), qui ne remplace jamais un brouillon en cours de frappe.

⚠️ **Limite de l'outillage, à savoir pour les prochaines vérifications** : dans le panneau
navigateur, les clics de souris n'ont pas abouti (ils sélectionnaient le texte du bouton et
expiraient au bout de 30 s). Les captures d'écran et la lecture de page fonctionnaient. Les
interactions ont donc été déclenchées par `element.click()`, et leur effet confirmé par le trafic
réseau (`POST … /traiter → 201`) puis par une lecture directe en base. La chaîne complète a bien
été exercée — mais pas par un vrai clic.

**Ce qui est mesuré, et non supposé** (20/08, sondes au niveau protocole) :

| Sonde | Résultat |
|---|---|
| Moteur Docker (`docker ps`, `docker version`) | HTTP 500 sur **toutes** les routes |
| TCP vers `127.0.0.1:5436` et `:6381` | **accepté en 1-3 ms** — le proxy de ports répond |
| `PING` Redis | aucune réponse en 6 s |
| `SSLRequest` Postgres (8 octets du protocole) | aucune réponse en 8 s |
| Processus `Docker Desktop`, WSL `docker-desktop` | en cours d'exécution |

Le proxy accepte, le conteneur ne répond jamais : c'est le réseau de Docker Desktop qui est figé,
pas les bases. Un simple test d'ouverture de port aurait conclu « tout va bien » — il fallait
parler le protocole pour voir la panne.

⚠️ **Ce que ce blocage révèle, et qui vaut pour la production.** L'API locale ne démarre pas :
elle reste dans `PrismaService.onModuleInit()`, qui fait `await this.$connect()` — donc **pendant**
`NestFactory.create`, bien avant `app.listen()`. Et comme `main.ts` crée l'application avec
`bufferLogs: true`, les journaux ne sont vidés qu'après la construction : un démarrage bloqué
n'écrit **rien du tout**, pas même la ligne qui dirait où il est bloqué. Symptôme observé :
processus vivant, aucune sortie, port fermé.

En production, une base injoignable au redémarrage donne donc une API muette et sans port ouvert,
impossible à diagnostiquer depuis ses journaux. À arbitrer : délai maximum sur `$connect()` avec
message explicite, ou vidage du tampon de journaux avant l'initialisation des modules.

— Correction : j'avais d'abord écrit ici que le blocage venait de `connectToRedis()`. C'est faux :
`new Redis(url)` ne bloque pas et l'adaptateur a déjà son repli mémoire en `catch`. La lecture du
fichier a corrigé la supposition.

### Réglages modifiés sans décision tracée

Constatés au contrôle du 20/08, non touchés :

| Réglage | Valeur | Conséquence |
|---|---|---|
| `ai_feature_flags."agendaAgent"` | repassé à `true` | la couche IA de l'agenda a refacturé un appel à 00:01 le 20/08 |
| `activity_report_schedule.enabled` | `false` | plus aucun rapport d'activité depuis le 12/08 |
| `lookbackHours` | 1200 → **1500** | fenêtre de rattrapage élargie |
| `maxAnalysesPerRun` | 150 → **5000** | passages de ~50 min, une heure sur deux |
| `RUN_BUDGET_MS` | 20 → **50 min** | cohérent avec la garde anti double-run, également à 50 min |

### Constat du 20/08 — vitesses impossibles acceptées à l'ingestion

L'ingestion marque `valid = true` sur des vitesses **physiquement impossibles**. Relevé sur toute
la flotte, positions valides uniquement :

| plaque | > 200 km/h | > 150 km/h | max | positions |
|---|---|---|---|---|
| **KSR370** | **147** | **1 804** | **255,7** | 102 634 |
| HD-779-MA | 0 | 745 | 179,6 | 152 890 |
| FG-669-DQ | 0 | 86 | 174,3 | 94 769 |
| EP-047-TY | 0 | 7 | 158,1 | 81 177 |
| FM-772-JH | 0 | 3 | 154,0 | 57 005 |

Conséquences : les trajets, les scores de conduite et la détection d'excès de KSR370 sont bâtis
sur des données fausses — et rien ne le signale. Aucun garde-fou de plausibilité n'existe à
l'entrée.

À décider : rejeter, ou marquer `valid = false`, au-delà d'un seuil par type de véhicule. Toucher
l'ingestion demande de la prudence — c'est le chemin le plus critique de l'application.

### ⚠️ SMS ou TCP — la question tranchée par la mesure (20/08)

**Réponse : SMS. Et ce n'est pas une préférence, c'est constaté dans les deux sens.**

| Mesure | Résultat |
|---|---|
| Trames TCP entrantes, 4 jours, 39 boîtiers | **625 155** |
| …contenant un accusé de réception (`ok`) | **0** |
| SMS entrants contenant `fix ok` | **6** |
| Idem `admin ok!` / `adminip ok!` / `GPRS OK!` | 5 / 7 / 9 |

`fix ok` est **exactement** le motif que le guetteur d'accusé attend (`/fix.*ok/i`) et sur lequel
il expire depuis 4 769 commandes. Les boîtiers répondent — mais par SMS, jamais par TCP.

**Et ils n'obéissent pas non plus en TCP.** Sur les 269 commandes de cadence envoyées, en ne
gardant que les cas où le véhicule roulait encore après (sinon l'immobilisation fausse tout) :

| Cadence demandée | n | Intervalle médian avant | après |
|---|---|---|---|
| 20 s | 12 | 26 s | 10 s |
| 30 s | 9 | 11 s | 20 s |
| **300 s** | 9 | 171 s | **12 s** |

La ligne à 300 s est la plus parlante : on demande **un point toutes les 5 minutes**, on en obtient
**un toutes les 12 secondes**. La cadence suit le mouvement du véhicule, pas nos commandes. Le
« 5 min » qu'on croyait obtenir est le repos naturel du boîtier, pas notre effet.

⚠️ Sans le filtre « le véhicule roulait-il après ? », la même mesure disait l'inverse (20 s
demandé → 68 s observé). Le premier chiffre était un artefact : le service demande une cadence
rapide quand il détecte un départ, et le véhicule s'était souvent déjà arrêté. **Une mesure non
contrôlée aurait fait conclure exactement le contraire.**

**Le défaut, en une phrase.** `TrackerCommandsService.dispatch()` envoie TOUT par
`registry.send()`, c'est-à-dire en TCP, et ne lit jamais `template.availableVia` — alors que 19
gabarits du catalogue le déclarent `['sms']`, dont les trois du capteur de choc, avec un
commentaire qui annonce précisément ce qu'on observe.

**⚠️ Ce que j'avais dit du canal SMS, et qui était faux.** J'ai d'abord annoncé « 1 515 échecs,
343 bloqués, zéro confirmé — le SMS aussi est en panne ». En creusant :

- Les **1 470** rejets `Numéro invalide (format E.164 attendu) : 34` sont **déjà corrigés**. Le
  correctif (`common/utils/phone.ts`, `toE164`) date du **19/07**, cite en commentaire le numéro
  exact qui échouait, et le dernier rejet de ce type date du même jour. Il n'y a rien à réparer.
- Les **343 `queued`** ne sont **pas** des échecs. Preuve : `resume123456` envoyé le 19/08 à
  04 h 39 est resté `queued`, et le boîtier a répondu **« Resume engine Succeed » à 08 h 28**. Le
  SMS est bien parti, le boîtier a bien agi. Toute la séquence de mise en service de juin
  (`begin`, `apn`, `admin`, `adminip`, `gprs`, `fix020s`) est également `queued` — et ces boîtiers
  émettent depuis.

Le vrai défaut restant est donc d'**observabilité, pas de livraison** : le statut final n'est
jamais réconcilié, et l'écran d'administration montre tout bloqué en `queued` alors que ça passe.
Distinct, moins grave, et à traiter séparément.

**Et une leçon de méthode.** Deux fois dans la même analyse, la première lecture disait l'inverse
de la vérité : la cadence TCP (avant le filtre « roulait-il ? ») et l'état du canal SMS (avant de
regarder les réponses entrantes). Un chiffre agrégé qui va dans le sens de ce qu'on soupçonne
mérite un contre-test avant d'être cité.

**Le SMS met des heures.** 04 h 39 → 08 h 28 sur l'exemple ci-dessus. C'est acceptable pour armer
un capteur une fois ; c'est inutilisable pour du temps réel. Le guetteur d'accusé de 15 secondes
n'a donc pas lieu d'être sur ce canal — il ne fabriquerait que de faux échecs.

**Conséquence sur les alertes accident.** Rien n'était réparable côté détection : aucune alerte
ACCIDENT ni COLLISION n'a jamais existé, non parce que la correspondance manque — elle est
correcte dans `alert-mapping.ts` — mais parce que **le capteur de choc n'a jamais été armé sur
aucun boîtier**, et qu'il ne pouvait pas l'être : 17 tentatives, toutes envoyées sur le canal que
ces boîtiers n'écoutent pas.

**Rien n'a été envoyé.** Cette section est une analyse, pas une intervention.

### Détection d'accident par télémétrie — les seuils, mesurés sur 30 jours de production

Règle retenue (décision du 20/08) : **chute de vitesse ET boîtier qui se tait**. Les deux
signaux pris isolément ont été mesurés avant d'être combinés :

| Règle candidate | Déclenchements / 30 j | Verdict |
|---|---|---|
| Chute ≥ 50 km/h → 0 | **612** sur 34 boîtiers (~20/jour) | inutilisable seule — tous suivis d'une reprise de route |
| … + immobilité 15 min | **0** | aucun faux positif, mais sensibilité non démontrée |
| Boîtier muet > 2 h alors qu'il roulait ≥ 20 km/h | **3** | rare, et c'est la signature d'un boîtier arraché ou détruit |

Les 3 cas du dernier signal : HD-779-MA (muet 6,3 h après 87 km/h), KSR370 (19,2 h après
61 km/h, le 28/07), GS-014-NY (2,5 h après 21 km/h).

⚠️ **Ce que je ne peux pas promettre** : aucun accident connu n'est présent dans la fenêtre de
données conservée, donc **aucune de ces règles n'a pu être validée sur un vrai accident**. On
mesure le taux de fausses alertes, pas le taux de détection. C'est exactement pourquoi la
restriction aux super-admins est la bonne façon de démarrer.

### KSR370 et FL-787-KV — ce que les données disent, et ce qu'elles ne disent pas

**Le « 150 km/h → 0 » de KSR370 est du bruit du boîtier, pas un freinage.** Mesuré sur 70 811
points : l'écart moyen entre la vitesse annoncée et celle déduite des coordonnées est de
8,3 km/h, et **1,7 % des points s'en écartent de plus de 40 km/h**, jusqu'à 256 km/h annoncés.
Sur le trajet du 12/08 à 23 h qui affiche 152 km/h, la séquence relevée est :

> 12 → 56 → **142** → 32 → 29 → 35 → **153** → 32 km/h

à 20 secondes d'intervalle, pour des positions qui bougent de 400 mètres. Aucun véhicule ne fait
ça. À titre de comparaison, FL-787-KV a un écart moyen de 0,4 km/h.

**Cela ne dit PAS que le véhicule n'est pas accidenté** — tu as la vérité terrain, moi seulement
des relevés. Cela dit qu'on ne peut pas s'appuyer sur ce signal-là pour le prouver, ni pour
déclencher une alerte.

**Son dernier trajet se termine normalement** : 8 km/h → 0 à 00 h 27 le 13/08, puis immobile, puis
le boîtier se tait 26 h plus tard (14/08 02 h 05) et ne parle plus depuis. Ce n'est pas une
signature de choc dans les positions conservées.

**L'accident du FL est irrécupérable.** La plus vieille position en base date du **21/06** : tout
ce qui est antérieur est purgé. FL-787-KV n'a que 3 alertes, toutes d'août. Les 37 VIBRATION et
3 SOS du 28/04 sont sur **EP-047-TY et FV-941-LZ**, en rafale tout un après-midi — cela ressemble
à une journée d'installation, pas à un accident.

### Analyse des `wire_logs` (20/08) — ce qu'ils contiennent vraiment

⚠️ **Rétention courte** : `wire_logs` ne remonte qu'au **17/08** (601 914 trames, 39 boîtiers).
L'accident du FL-787-KV « il y a quelques mois » n'y est plus — il faudra le reconstituer depuis
`alerts` et `positions`, qui vont plus loin.

Inventaire des codes d'alarme sur 4 jours :

| code | trames | boîtiers | ce que c'est |
|---|---|---|---|
| `tracker` | 535 760 | 39 | position normale |
| `status` | 2 961 | 39 | état périodique |
| `acc off` / `acc on` | 723 / 709 | 27 | contact |
| **`ac alarm`** | **354** | **2** | alimentation perdue |
| `kt` / `jt` | 267 / 261 | 36 | contact, codes courts |
| `upgraderesult` | 39 | 35 | **non reconnu par l'analyseur** |
| `speed` | 24 | 1 | excès |
| `low battery` | 2 | 1 | |
| **`jk`** | **2** | **1** | **non reconnu** |

**Aucun code d'accident ou de choc n'apparaît nulle part.** Ni `accident alarm`, ni `collision`,
ni `sensor alarm`. Les boîtiers n'en émettent pas — ce qui explique qu'aucune alerte accident
n'ait jamais été levée.

### Ce que `jk` n'est PAS

Code Coban non reconnu, remonté en « Alarme inconnue ». **2 occurrences**, sur 2 boîtiers.

Le cas du 19/08 est documenté trame par trame : deux `jk` **identiques à 41 ms d'intervalle**
(retransmission), puis le boîtier se déconnecte, puis se reconnecte 30 minutes plus tard — et
entre les deux le véhicule a parcouru **29 km**. Sur ce cas, `jk` précède une coupure réseau, pas
un choc.

Le cas du 13/08 (KSR370) : `jk` à 31,8 km/h, le véhicule a continué à émettre normalement.

Deux échantillons, deux comportements différents. **On ne mappe donc pas `jk` vers ACCIDENT** :
sur cette base, ce serait fabriquer des alertes critiques sur des trajets normaux.

Le mapping `accident alarm` -> ACCIDENT et `collision` -> COLLISION **existe déjà et fonctionne**.
Ce qui manque, c'est que le boîtier émette ces codes — la détection de choc doit être armée par
commande, et la page « Commandes tracker » sait déjà le faire.

### Chantiers restants

- **Point 2** — retirer le bouton « Recalculer » de la page Rapports. Le retard se résorbe
  (2 158 → 1 339 trajets bruts au 20/08) mais n'est pas à zéro : le bouton reste le seul rattrapage
  manuel. À faire quand la tranche 30-50 j sera vidée.
- **Agent qualité GPS** — ✅ terminé : agent, migration, API, écran, tâche planifiée et
  traçabilité des passages (cf. section dédiée). Reste à déployer la migration
  `20260820180000_passages_agents_locaux`, sans quoi la page des tâches de fond affiche
  « inconnu » pour lui.
  ⚠️ Limite assumée : la corrélation se fait PAR SOCIÉTÉ. Une zone morte partagée par deux
  sociétés différentes ne sera pas détectée — mélanger leurs données pour gagner en détection
  n'est pas un arbitrage acceptable.
- **Agent triage des propositions d'agenda** — 1 328 propositions jamais triées au 19/08.
- **Agent rapport d'activité** — sans objet tant que la planification est désactivée.
- **Agent coaching conducteur** — bloqué tant que le ratio d'analyses sans limite de vitesse
  connue n'est pas descendu.
- **`narrateEnabled`** reste à `false` et le restera : l'agent local produit les récits. Au 20/08,
  8 973 analyses sur 10 070 n'ont pas de récit — l'analyse déterministe va bien plus vite que la
  narration, et c'est attendu.

### Défauts trouvés par la MESURE, pas par la relecture

Sept, en deux jours. Tous passaient le typecheck et les tests :

1. **Budget borné au mauvais endroit** — vérifié à l'entrée d'un véhicule, alors que le temps part
   dans la boucle sur ses trajets. Observé : 31 min pour un plafond de 20.
2. **Écran sans lien** — l'assistance livrée avec sa route, son garde et ses deux écrans, et rien
   pour y aller. Le dépôt documentait déjà ce piège pour un autre écran.
3. **Horodatage jamais mis à jour** — l'agent écrit en SQL brut, donc l'annotation Prisma ne se
   déclenche pas ; la supervision aurait affiché un agent à l'arrêt pendant qu'il travaillait.
4. **`psql` sort en 0 même quand le SQL échoue** — sans `ON_ERROR_STOP=1`, les deux agents
   comptaient comme écrit ce qui ne l'était pas. Observé le 20/08 : « 1 zone enregistrée » sur une
   table qui n'existait pas encore en production. Un agent qui se félicite d'un travail qu'il n'a
   pas fait est pire qu'un agent en panne — la panne, elle, se voit.

5. **Tri ascendant sur une colonne nullable** — `orderBy: { traiteAt: 'asc' }` se lit très bien
   et fait l'inverse de ce qu'on croit : Postgres range les NULL en DERNIER. L'écran des
   diagnostics GPS aurait ouvert sur l'archive de ce qui est réglé, en enterrant dessous les
   seules lignes qui attendent une décision. Corrigé par `nulls: 'first'`, avec un test qui
   vérifie l'appel exact — un test sur le résultat n'aurait rien vu, le mock ne trie pas.
6. **Une réouverture effaçait la note** — `note: (dto.note ?? '').trim() || null` écrit `null`
   quand l'appelant ne fournit rien. Rouvrir un diagnostic classé par erreur aurait donc détruit,
   sans retour, ce qu'un humain avait constaté sur place. La note n'est plus touchée que si elle
   est explicitement fournie.

7. **Note conservée mais invisible** — le serveur gardait bien la note d'un diagnostic rouvert (la
   base le confirmait, et un test le verrouillait), mais l'écran ne la ré-affichait pas. Le
   relecteur aurait vu un champ vide, tapé autre chose, et écrasé la précédente sans savoir
   qu'elle existait. **Le correctif serveur était juste et insuffisant** : aucun test d'API ne
   pouvait voir ce trou, il fallait ouvrir l'écran, traiter, rouvrir, puis RECHARGER.

C'est ce qui justifie le contrôle du matin, et la règle « pas de conclusion sur lecture de code ».
Sept défauts, et pas un seul trouvé par le typecheck.
