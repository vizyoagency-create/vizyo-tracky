# C3 — Chantier IA du 5 septembre 2026 : coûts justes, agents du poste surveillés, agenda par la file

Décisions du propriétaire (2026-09-05), après la carte des coûts IA du 2026-09-04 :

> « 1, 3 et 6, tu peux les faire sans moi. Pour 2, fais en sorte que ça ne contourne pas, proprement.
> Pour 4, que la page « Coûts IA » soit vraiment correcte. Pour 5, faire apparaître les échecs avec
> l'estimation du coût IA (simple) et conserver les erreurs dans le centre d'alerte. L'agent de 2 h :
> passer le jugement de l'agent d'agenda par la file du poste, coût API automatique → 0. On garde
> uniquement assistance et optimiseur sur l'API, car ce sont des actions instantanées. PS : une
> alerte si les agents IA locaux ne lancent pas un prompt — je veux tout voir : PC éteint la nuit,
> le matin tous les agents en échec. »

Ce document fixe ce qui est décidé, ce qui est supposé (à défaut de pouvoir demander), et où
chaque décision vit dans le code. La cartographie complète (6 lecteurs, 2026-09-05) est dans le
scratchpad de session ; l'essentiel est repris ici.

## État de production relevé le 2026-09-05

| Fait | Valeur |
|---|---|
| Routeur IA (`ai_provider_settings`) | aucune ligne → mode `claude` ; `OPENAI_API_KEY` présente et **valide** (GET /v1/models = 200) ; `ANTHROPIC_API_KEY` refusée (400 « credit balance is too low ») depuis le 03/09 |
| Drapeaux `ai_feature_flags` | tripAnalysis OFF, activityReport OFF, agendaAgent ON, capacity/placement/bookingParse/placeAnalysis ON |
| Agent d'agenda | cdef31 seule, 02:00 Paris, quotidien, autonomie `auto_high_confidence`, seuil 80 ; 12 appels API sur 30 j (0,75 $) ; en mode dégradé depuis le 04/09 |
| Propositions d'agenda | 1 954 `pending` dont **1 615 périmées** ; 289 `auto_applied` ; jamais aucune expiration |
| Grille tarifaire | Sonnet 5 comptée 3/15 $ (réel **2/10 $**, cache 2,50 / 0,20 — page officielle relevée le 05/09) ; 26 lignes API Sonnet 5 = 0,891 $ stockés contre 0,594 $ recalculés |
| `ai_usage_logs` | jamais de ligne `ok=false` ; 20 lignes locales `place_analysis` en doublon (courrier + serveur) ; agents du poste : 0 jeton, coût 0 en dur, modèles `sonnet` / `claude-code-poste` inconnus de la grille |
| File `travaux_ia_locaux` | 5 travaux `analyse-lieu` en `echec` depuis le 27/08 (76 à 1 330 tentatives) ; leurs lieux ont été ré-analysés avec succès les 01 et 02/09 |
| Agents du poste | 5 tâches Windows (session interactive, `StartWhenAvailable`, pas de réveil) ; passages journalisés dans `passages_agents_locaux` ; « rien à faire » consigné comme ÉCHEC par récit et limites ; aucune alerte serveur quand un agent manque |
| `.env` racine | porte les vraies clés Anthropic et OpenAI ; git-ignoré ; ni docker-compose ni `apps/api/.env` ne les référencent ; `claude auth status` = abonnement `claude.ai` / `max` (le `.env` n'atteint pas la CLI aujourd'hui) |
| Taux USD→€ | `AI_USD_TO_EUR` absent partout → 0,92 en dur ; marché ≈ 0,86 le 05/09 |

## Point 1 — Le routeur bascule sur GPT quand Anthropic refuse

- `AiRouter.completeJson` essaie les fournisseurs CONFIGURÉS dans l'ordre [préféré, mode réglé, claude, gpt].
  Sur `AiServiceError` de sorte `no_key`, `invalid_key`, `quota`, `overloaded`, `provider_unfunded`
  (refus du fournisseur, rien de facturé), il passe au suivant. Jamais sur `refusal`, `truncated`,
  `parse`, `empty`, `http` : ce sont des défauts de la requête, un second moteur les repaierait.
- **Aucun repli quand `preferProvider` est imposé** (« Comparer », mode mixte des récits) : un résultat
  GPT ne doit jamais s'afficher sous l'étiquette Claude.
- Quarantaine en mémoire par fournisseur : `provider_unfunded` / `invalid_key` 15 min, `quota` /
  `overloaded` 60 s. Un fournisseur en quarantaine est sauté sans appel réseau ; à l'expiration on le
  retente une fois. Si tous sont en quarantaine, on tente quand même le premier.
- Quand le repli réussit : UNE ligne au centre d'alerte (source `AI_ROUTER`, niveau de l'erreur,
  contexte de → vers, sorte, motif fournisseur), refroidissement 6 h par (fournisseur, sorte).
  Quand tout échoue : l'erreur du fournisseur PRIMAIRE est relancée (les appelants et le filtre HTTP
  l'archivent déjà).
- Le client OpenAI teste « compte à sec » AVANT la branche 429 → `quota` (sinon un compte OpenAI à
  sec serait un échec passager invisible).
- L'état des quarantaines est exposé à la page « Coûts IA » (carte Moteur).

## Point 2 — « Lancer maintenant » n'existe plus quand l'interrupteur est coupé

Exception commune `AutomationDisabledException` (HTTP 409, message français explicite, jamais
archivée au centre d'alerte : un 4xx est un refus, pas une panne). Quatre chemins :

| Bouton | Interrupteur | API | Web |
|---|---|---|---|
| Agenda « Lancer l'analyse » | `agenda_agent_settings.enabled` | refus 409 avant toute détection ; route `POST /agenda/agent/run` exige `reservations_manage` comme ses voisines | bouton grisé sur la valeur ENREGISTRÉE, phrase « L'agent est désactivé : activez-le et enregistrez » |
| Trajets « Lancer maintenant » | `trip_automation_settings.enabled` | refus 409 ; un run concurrent renvoie `alreadyRunning: true` au lieu de « 0 analysé » | bouton grisé, libellé corrigé, toast « déjà en cours » |
| Lieux « Lancer maintenant » | `place_automation_settings.enabled` | refus 409 ; « Simuler » (gratuit, sans effet) reste permis | textes corrigés : le passage n'appelle plus l'IA, il confie les analyses au poste |
| Rapport hebdo « Envoyer maintenant » | `fleet_report_schedules.enabled` | refus 409 ; le refus est journalisé (`weekly_report_send_now` FAILURE) | bouton grisé avec motif |

Supposition assumée : agent d'agenda ON + IA maître OFF = passage déterministe (comportement
existant, voulu). Le rapport d'activité « Générer » reste sur le drapeau global (OFF par décision) :
le bouton se grise avec le motif au lieu de produire un 403.

## Point 3 — Plus de « coût 0 » en dur, et rien ne peut basculer sur l'API sans se voir

- Module partagé `outils/cli-claude.cjs` : chemin du binaire, `verifierAbonnement()` (`claude auth
  status` doit répondre `authMethod = claude.ai` ; aucune variable `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX` dans l'environnement), `appeler()` qui lance
  la CLI avec un environnement NETTOYÉ de ces variables et rend jetons réels, identifiant réel du
  modèle, coût équivalent API (`total_cost_usd`) et durée. Un agent qui n'est pas sur l'abonnement
  **refuse de tourner** et journalise un passage en échec explicite.
- Les jetons réels sont écrits dans `ai_usage_logs` (executor `local`, `costUsd` 0 : c'est ce qui est
  facturé). Le coût équivalent est calculé par la grille à partir des jetons — il inclut le contexte
  propre de Claude Code (≈ 28 k jetons de cache par appel), ce que l'encart « absorbé » dit.
- Une seule écriture par travail de la file : le SERVEUR (consommateur) écrit la ligne d'usage à partir
  des jetons rendus dans `resultat` ; le courrier n'écrit plus rien dans `ai_usage_logs`. L'agent de
  récits (voie directe) garde son écriture, avec les vrais jetons.
- Les clés Anthropic/OpenAI quittent le `.env` racine (répertoire de travail des agents) pour
  `apps/api/.env`, que l'API charge aussi. `.env.example` documente les variables IA ;
  `ANTHROPIC_MODEL` et `AI_USD_TO_EUR` sont déclarées au schéma d'environnement.
- Un passage « rien à faire » est un SUCCÈS (récit, rattrapage, limites) : préalable à toute alerte
  sur `succes`.

## Point 4 — Une page « Coûts IA » juste

- Grille datée et sourcée : Sonnet 5 → 2 / 10 / 2,50 / 0,20 ; ajout de Sonnet 4.6, Opus 4.7/4.6/4.5,
  Fable 5 et 5.1, gpt-4o-mini, famille gpt-5 ; alias des modèles écrits par le poste (`sonnet`,
  `claude-code-poste`, identifiants datés). Repli = le tarif le plus cher (Fable 5.1) et une ligne
  DEGRADATION au centre d'alerte la première fois qu'un modèle inconnu est rencontré (jamais
  sous-estimer un coût inconnu, et le dire).
- L'historique est recalculé par migration de données (jamais à la main) : `costUsd` des lignes API
  Sonnet 5 refait à partir des jetons stockés ; les 20 doublons locaux du courrier supprimés. Les
  copies figées sans jetons (`activity_reports.costUsd`, `assistance_messages.costUsd`,
  `place_analyses.costEur`) restent telles quelles, avec une note à l'écran.
- Taux USD→€ en base (`ai_budget.usdToEurRate`, défaut 0,86 relevé le 05/09), modifiable depuis la
  page, affiché à côté de chaque montant en euros. Plus de 0,92 invisible.
- La page montre le modèle et l'exécutant dans le journal, compte les jetons de cache dans le KPI,
  calcule « coût par appel » sur les seuls appels facturés, connaît `support_chat` et `place_analysis`,
  filtre par toutes les actions, pilote aussi `placeAnalysis`, nomme le moteur par défaut réel, et
  l'encart « absorbé » se fonde sur les jetons réels quand ils existent (référence API restreinte aux
  90 derniers jours sinon).

## Point 5 — Les échecs apparaissent, et restent au centre d'alerte

- `ai_usage_logs` gagne `errorKind`, `errorDetail`, `provider`, `estimatedCostUsd`. Le routeur — seul
  point de passage — enregistre CHAQUE échec (`ok=false`) : coût réel s'il y a eu facturation (usage
  renvoyé par le fournisseur, transporté par `AiServiceError`), sinon `costUsd 0` et une estimation
  SIMPLE : jetons d'entrée ≈ longueur(system + données)/4 × prix d'entrée du modèle tenté, sortie 0.
  L'estimation n'entre jamais dans le plafond mensuel (qui reste de l'argent réel).
- Chaque appelant passe `trace: { action, userId, fleetId }` au routeur ; les cinq appelants qui
  archivaient sans niveau transmettent désormais `niveau` et `detail`. Le rapport d'activité manuel
  remonte enfin son échec au centre.
- Les échecs passagers (429, 529, délai, réseau, plafond mensuel) restent hors des lignes ERROR mais
  produisent une ligne DEGRADATION avec refroidissement 1 h par (fournisseur, sorte) : visibles, pas
  bruyants. Un travail de la file passé en `echec` produit une ligne `ok=false` et une alerte.
- La page affiche un KPI « Échecs » (nombre, coût estimé marqué ≈), un badge par ligne, un filtre.

## Point 6 — La file ne s'acharne plus, et un échec définitif se voit

- Courrier : ne prend que `tentatives < 3`, ne reprend jamais dans le même passage un travail qu'il
  vient de reposer, s'arrête après 4 échecs consécutifs, conserve la sortie d'erreur de la CLI (pas la
  ligne de commande), passe lui-même le travail en `echec` à la 3ᵉ tentative.
- Serveur : `reprendrePerimes` acte aussi en `echec` les `a-faire` à 3 tentatives sans écraser le motif ;
  tout passage en `echec` écrit UNE ligne au centre d'alerte (source `travaux-ia`, refroidissement par
  travail) ; une purge quotidienne efface les `echec` de plus de 7 jours (les 5 travaux morts du 27/08
  disparaissent ainsi, sans geste manuel).

## Point 7 — Le jugement de l'agent d'agenda passe par la file du poste

- La détection déterministe reste au serveur (02:00). Les propositions sont créées AUSSITÔT avec la
  phrase mécanique (= mode dégradé actuel) : visibles, réservables, et les réservations fermes de
  l'autonomie haute partent comme aujourd'hui. Puis UN travail `jugement-agenda` est enfilé par
  société et par nuit (idempotent), avec la liste des propositions créées par motif.
- Le courrier du poste (06:30 / 14:30) le traite comme les autres ; le cron horaire de l'agenda
  CONSOMME le verdict : `keep=false` → propositions encore `pending` du motif passées en `dismissed`
  avec la raison de l'IA (une réservation ferme n'est jamais annulée après coup — c'est à l'humain) ;
  `keep=true` → raisonnement remplacé ; le passage est marqué `aiUsed`. Chaque proposition porte
  désormais `aiVerdictAt` / `aiKeep`.
- Le clic « Lancer l'analyse » suit le MÊME chemin (détection, propositions, travail enfilé) : plus
  aucun appel API automatique ou au clic pour l'agenda. L'écran le dit : « propositions préparées,
  avis de l'IA au prochain passage du poste ».
- Expiration : une proposition `pending` dont le créneau est passé devient `expired` (cron horaire) ;
  la liste ne montre plus les 200 plus anciennes.
- Le catalogue des tâches passe l'agent d'agenda en coût « absorbé » et remplace la note du 21/08
  (« reste sur l'API ») par la décision du 05/09.
- Seuls **assistance** et **optimiseur** restent sur l'API. Supposition assumée : la saisie vocale de
  réservation (`bookingParse`, 1 appel en 60 j, instantané, lien public) reste aussi sur l'API, faute
  de pouvoir attendre un passage nocturne ; à couper depuis la page si le propriétaire le souhaite.
- **Un chemin automatique subsiste, et il est éteint** : le cron des trajets (HH:45) narre par l'API
  quand `trip_automation_settings.narrateEnabled` ET l'option IA de la société sont vrais. Relevé
  le 5 septembre : `narrateEnabled = false` depuis fin juillet, et les 11 620 récits des 30 derniers
  jours viennent tous du poste. Le rallumer coûterait ~386 $/an ; il reste en place pour la voie
  MANUELLE (« Analyser » sur un trajet). L'écran d'automatisation doit continuer de le dire.

## PS — Sentinelle des agents du poste

- Service serveur horaire : pour chaque agent du catalogue, compare le DERNIER passage à ce qui était
  ATTENDU (dernier déclenchement planifié en heure de Paris + 2 h de grâce, pour laisser
  `StartWhenAvailable` rattraper un démarrage tardif). Passage manqué → CRITICAL ; dernier passage en
  échec → CRITICAL avec le motif ; agent jamais vu → CRITICAL ; rattrapage sans objet → rien.
- Une ligne par agent et par épisode (refroidissement 24 h), donc « le matin, tous les agents en
  échec » ; quand l'agent repasse avec succès, la ligne est archivée automatiquement (note « agent
  repassé le … ») et l'épisode est oublié, pour crier sans délai la prochaine fois.
- Le centre d'alerte affiche une section « Agents du poste » alimentée par ces lignes ouvertes, et le
  hub pulse dessus ; les super-admins reçoivent une notification.

## À faire par le propriétaire — heure d'hiver et Planificateur Windows

Relevé sur le poste le 5 septembre (`Get-ScheduledTask`, champ `StartBoundary`) : **quatre des cinq
tâches sont enregistrées avec un décalage UTC** (`+02:00`) au lieu d'une heure locale —
`VizyoTracky-QualiteGPS` (05:00), `VizyoTracky-CourrierIA` (06:30 et 14:30),
`VizyoTracky-LimitesVitesse` (5 créneaux), `VizyoTracky-RattrapageRecits` (02:00, répété) ; seule
`VizyoTracky-RecitTrajet` est en heure locale (`2026-08-20T03:15:00`, sans décalage).

**Conséquence au 25 octobre** : ces quatre tâches se déclencheront une heure PLUS TÔT en heure de
Paris, alors que le catalogue — et donc la sentinelle — les attend à l'heure locale déclarée. La
sentinelle jugerait le passage « manqué » chaque jour, sur des agents qui ont pourtant tourné.

Le correctif est une action sur le poste, pas du code : ré-enregistrer les déclencheurs de ces trois
tâches quotidiennes sans décalage (décocher « Synchroniser entre fuseaux horaires »), comme
`VizyoTracky-RecitTrajet`. À vérifier le 26 octobre : `demarreA` du passage doit valoir l'heure
locale déclarée.

## Ordre de livraison

Lot 1 (sans changement de schéma) : points 1, 6, 3, 2 → tests, revue contradictoire, déploiement,
vérification en production. Lot 2 (avec migrations) : points 4, 5, 7, PS → même parcours.
