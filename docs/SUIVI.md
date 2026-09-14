# SUIVI — le poste de commande

> **Ce fichier dit ce qu'on fait ensuite, et où on en est. Rien d'autre.**
> Le détail de chaque tâche vit dans [`centre-alerte/ROADMAP-CORRECTIFS.md`](./centre-alerte/ROADMAP-CORRECTIFS.md)
> (tenue chaque nuit par les audits). **On ne recopie pas** : ici l'ordre et l'état, là-bas le pourquoi et la preuve.
>
> **Règle de tenue :** une tâche naît dans `centre-alerte/app/taches.json` (identifiant jamais réutilisé) ; ce fichier et
> la page publiée en sont deux **vues**. Une tâche ne disparaît jamais : elle passe en ☑ avec sa date.
>
> 📺 **La page que le propriétaire consulte** (coches gardées, lisible sur téléphone) :
> <https://claude.ai/code/artifact/860096da-d994-4fa5-ab53-6fda6c3fd817>
>
> ⚠️ **Elle est GÉNÉRÉE** — `node docs/poste-de-commande/generer.mjs --etat <page publiée>` la dérive de
> `centre-alerte/app/taches.json` + `poste-de-commande/contexte.json`. Ce fichier-ci est rendu des mêmes sources ;
> quand ils divergent, **`taches.json` fait foi**.

*Dernière mise à jour : 2026-09-14 (relevé du 14 septembre 2026, 07:05 UTC) · dépôt sur `main`*

---

## 🔴 Coupe-circuit — chantier fiabilité, état au 14/09

La contre-expertise indépendante du 13/09 ([doc 19](./fiabilite-coupe-circuit-2026-09/19-CONTRE-EXPERTISE-INDEPENDANTE-2026-09-13.md),
note 53/100) a rendu un **NO-GO** en l'état : un défaut P0 introduit par la correction (une RESTORE partie par SMS et jamais acquittée
avalait la RESTORE du lendemain), démontré par test. Depuis :

- ☑ **T40** — le P0 est corrigé et **committé** (`d5c19a17`, [doc 20](./fiabilite-coupe-circuit-2026-09/20-CORRECTIF-P0-CLE-RESTORE-2026-09-13.md)) ; 8 tests neufs.
- ☑ **T46** — la branche `codex/tracky-cutoff-reliability-2026-09-12` est **nettoyée du reformatage** et **rebasée sur `main`** (7 commits, zéro conflit) ;
  le relais Texto est réécrit en un commit `2de94d8` sur `origin/main`. Suites : API 259 suites / 4 002 tests, Web 727, partagé 423, Texto 24.
- ☐ **Rien n'est déployé.** La production tourne sur `main` `66d286f5` **sans** les correctifs ; horaires CDEF31 0/30 et MH Cars 0/7 désactivés.
- ⚠️ Avant fusion, retirer du worktree `main` la copie **non suivie** de `docs/fiabilite-coupe-circuit-2026-09/` (12 documents périmés du 12/09 + le doc 19) : la branche apporte les 20 documents à jour.

**L'ordre, et pourquoi :** code d'abord (T41 validité des SMS CUT, T42 reconnexion TCP, T44 sentinelle, T45 preuve quotidienne),
puis le téléphone (T43), la procédure (T47), la recette sur boîtier et les canaris (T54) — et seulement ensuite la réactivation progressive (T38).

| | # | Quoi | Fiche | Classe |
|:--:|:--:|---|---|---|
| ~ | **T40** | 🔴🔴 P0 — La clé d'unicité RESTORE ne doit plus vivre pour toujours (RESTORE du lendemain avalée) — COMMITTÉ d5c19a17, en attente de fusion | TRK-066 · doc 19 P0-1 | 🔧 à coder `d5c19a17` |
| ~ | **T41** | 🔴🔴 P0 — Donner une validité aux SMS CUT (ttl), une priorité aux RESTORE, un appareil explicite, et annuler le SMS CUT supplanté — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P0-2 | 🔧 à coder `8ab1d08e` |
| ~ | **T42** | 🔴 Relancer une RESTORE non prouvée à la reconnexion TCP du boîtier — et ne plus la rendre terminale après trois SMS — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P1-1 | 🔧 à coder `86c32fa9` |
| ☐ | **T43** | 🔴 AUJOURD'HUI — Configurer le téléphone passerelle S21 (ping 60 s, FIFO, délais, limite, SIM 1, One UI) — avant tout déploiement | TRK-066 · doc 19 P1-2 | 🔵 terrain |
| ~ | **T44** | 🔴 Sentinelle Android : hystérésis, bornes d'environnement, fraîcheur par appareil, délai d'envoi séparé du délai de santé — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P1-2 | 🔧 à coder `86a2fc53` |
| ~ | **T45** | 🔴 Preuve SMS quotidienne réconciliée (T-30 min avant chaque fenêtre) — et le relais pousse ses statuts — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P1-3 | 🔧 à coder `1aa1e0f9` |
| ☑ | **T46** | 🔴 Nettoyer le diff du chantier (reformatage prettier), rebaser sur main, résoudre le conflit — la production est déjà sur 66d286f5 | TRK-066 · doc 19 P1-4 | 🔧 à coder |
| ☐ | **T47** | 🔴 Procédure de déploiement du chantier — ÉCRITE (doc 25), à jouer ensemble : téléphone → relais → Tracky, kill-switch false | TRK-066 · doc 19 P1-5 | 🟡 préparé |
| ~ | **T48** | Course ACK/SMS : ne jamais rétrograder ACKNOWLEDGED en SENT ; dispatcher une CUT PENDING orpheline au lieu de la rendre telle quelle — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-1 · P2-4 | 🔧 à coder `8a8cb2c4` |
| ~ | **T49** | Kill-switch et interlock : une ligne par cause et espacée, pas un CRITICAL par appel — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-2 | 🔧 à coder `93dba465` |
| ~ | **T50** | Glissement de confirmation réellement volontaire : ni un clic en bout de piste, ni la touche End — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-3 | 🔧 à coder `8bb24ca7` |
| ~ | **T51** | Rappeler une RESTORE qui traîne (toutes les 15 min) et ne pas suspendre le clic manuel derrière la file SMS — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-5 · P2-6 | 🔧 à coder `b582fbf6` |
| ~ | **T52** | Santé par appareil (deviceId, simCards) et allowlist non bloquante pour une RESTORE — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-8 · P2-9 | 🔧 à coder `428d1f39` |
| ~ | **T53** | Tests : exercer la table des tentatives, index dans schema.prisma, migration rejouée sur PostgreSQL réel, changement d'heure du 25/10 — COMMITTÉ (partie faisable seul), en attente de fusion | TRK-066 · doc 19 P2-10 | 🔧 à coder `b407481a` |
| ☐ | **T54** | 🔴 Recette réelle : boîtier de banc, puis un canari MH Cars, puis un CDEF31 — un à la fois, présence physique, jamais les 37 | TRK-066 · doc 19 §3 phase 5 | 🔵 terrain |
| ☐ | **T55** | Second téléphone + seconde SIM (autre opérateur) — après T52, jamais sous le même deviceId | TRK-066 · doc 12 · doc 19 P2-8 | 🤝 humain |
| ~ | **T56** | Corriger les promesses des documents du chantier qui dépassent le code — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 §15 | 🧹 dette doc `0677cd05` |
| ☐ | **T57** | Dépendances : lot séparé après stabilisation (maplibre critique, socket.io/ws, axios via twilio, multer) | TRK-066 · doc 19 §14 | 🔧 à coder |
| ☐ | **T58** | La cle de refroidissement de la sentinelle des agents doit porter la CAUSE — et courrier-ia doit lire le premier objet JSON equilibre | TRK-069 | 🔧 à coder |
| ☐ | **T59** | Ne plus remonter au centre d alerte les appels avortes par la fermeture de la page sur le canal anonyme (robots) | TRK-079 | 🔧 à coder |
| ☐ | **T60** | Test fenetre-utile.spec.ts (trajets, sur main) tient à la milliseconde : deux Date.now() distincts — à figer | main · 152883ec | 🔧 à coder |
| ☐ | **T61** | 🔴 Dix SIM de boîtiers sont INJOIGNABLES par SMS depuis le S21 (RESULT_ERROR_GENERIC_FAILURE persistant) — les identifier comme « TCP seul » et faire trancher Free / WhereverSIM | TRK-066 · S21 · doc 10 test B/C | 🤝 humain |

---

## 🟢 Où on en est

| Ce qui tourne | Où ça en est | Note |
|---|---|---|
| Rattrapage du recalage des tracés | 12 441 restants | ≈ 35 jours à 15 par heure |
| Reprise des analyses d’avant le 4 septembre | 25 par passage | s’éteint seule |
| Coupe-circuit automatique — À L’ARRÊT | 0 planning actif sur 37 | réactivation sur ta décision (T38), après T43 → fusion → fenêtre doc 25 → T54 |

| Chiffre | |
|---|---|
| **11** | défauts nés au centre d’alerte sur 24 h (sur 25 lignes : 4 d’un robot, 9 refermées seules dans la journée) |
| **831/831** | trajets clos depuis le correctif du 08/09 suivent la route |
| **12** | gestes qui n’avancent que par toi |
| **92** | fiches suivies dans la roadmap |

---

## 🤝 CE QUI T'ATTEND — rien ne peut avancer sans toi *(12 gestes)*

| | # | Quoi | Fiche | Classe |
|:--:|:--:|---|---|---|
| ☐ | **T7** | 🔴🔴 Ouvrir la fenetre de maintenance du role non-superutilisateur | TRK-035 | 🤝 humain |
| ☐ | **T38** | 🔴🔴 Remettre en service les plannings du coupe-circuit — 37 coupes depuis le 11/09, apres le chantier fiabilite | TRK-066 | 🤝 humain |
| ☐ | **T9** | 🔴 Declarer ou depanner GLA•KC•31 et FG-669-DQ — et LEVER la declaration des trois revenus | — | 🔵 terrain |
| ☐ | **T43** | 🔴 AUJOURD'HUI — Configurer le téléphone passerelle S21 (ping 60 s, FIFO, délais, limite, SIM 1, One UI) — avant tout déploiement | TRK-066 · doc 19 P1-2 | 🔵 terrain |
| ☐ | **T47** | 🔴 Procédure de déploiement du chantier — ÉCRITE (doc 25), à jouer ensemble : téléphone → relais → Tracky, kill-switch false | TRK-066 · doc 19 P1-5 | 🟡 préparé |
| ☐ | **T54** | 🔴 Recette réelle : boîtier de banc, puis un canari MH Cars, puis un CDEF31 — un à la fois, présence physique, jamais les 37 | TRK-066 · doc 19 §3 phase 5 | 🔵 terrain |
| ☐ | **T61** | 🔴 Dix SIM de boîtiers sont INJOIGNABLES par SMS depuis le S21 (RESULT_ERROR_GENERIC_FAILURE persistant) — les identifier comme « TCP seul » et faire trancher Free / WhereverSIM | TRK-066 · S21 · doc 10 test B/C | 🤝 humain |
| ☐ | **T1** | Recharger au moins UN des deux comptes IA | TRK-071 | 🤝 humain |
| ☐ | **T35** | Ouvrir un second abonnement reserve aux agents du poste — quand tu le decideras (D7) | TRK-071 | 🤝 humain |
| ☐ | **T39** | Rouvrir les notifications aux clients (PUSH_ROLLOUT=ALL) quand les tests seront finis | TRK-065 | 🤝 humain |
| ☐ | **T55** | Second téléphone + seconde SIM (autre opérateur) — après T52, jamais sous le même deviceId | TRK-066 · doc 12 · doc 19 P2-8 | 🤝 humain |
| ☐ | **T8** | Controler les antennes de trois vehicules | TRK-001 · TRK-027 | 🔵 terrain |

---

## 🔧 CE QUE JE PEUX CODER — le plus grave d'abord *(16)*

| | # | Quoi | Fiche | Classe |
|:--:|:--:|---|---|---|
| ~ | **T40** | 🔴🔴 P0 — La clé d'unicité RESTORE ne doit plus vivre pour toujours (RESTORE du lendemain avalée) — COMMITTÉ d5c19a17, en attente de fusion | TRK-066 · doc 19 P0-1 | 🔧 à coder `d5c19a17` |
| ~ | **T41** | 🔴🔴 P0 — Donner une validité aux SMS CUT (ttl), une priorité aux RESTORE, un appareil explicite, et annuler le SMS CUT supplanté — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P0-2 | 🔧 à coder `8ab1d08e` |
| ~ | **T42** | 🔴 Relancer une RESTORE non prouvée à la reconnexion TCP du boîtier — et ne plus la rendre terminale après trois SMS — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P1-1 | 🔧 à coder `86c32fa9` |
| ~ | **T44** | 🔴 Sentinelle Android : hystérésis, bornes d'environnement, fraîcheur par appareil, délai d'envoi séparé du délai de santé — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P1-2 | 🔧 à coder `86a2fc53` |
| ~ | **T45** | 🔴 Preuve SMS quotidienne réconciliée (T-30 min avant chaque fenêtre) — et le relais pousse ses statuts — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P1-3 | 🔧 à coder `1aa1e0f9` |
| ~ | **T48** | Course ACK/SMS : ne jamais rétrograder ACKNOWLEDGED en SENT ; dispatcher une CUT PENDING orpheline au lieu de la rendre telle quelle — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-1 · P2-4 | 🔧 à coder `8a8cb2c4` |
| ~ | **T49** | Kill-switch et interlock : une ligne par cause et espacée, pas un CRITICAL par appel — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-2 | 🔧 à coder `93dba465` |
| ~ | **T50** | Glissement de confirmation réellement volontaire : ni un clic en bout de piste, ni la touche End — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-3 | 🔧 à coder `8bb24ca7` |
| ~ | **T51** | Rappeler une RESTORE qui traîne (toutes les 15 min) et ne pas suspendre le clic manuel derrière la file SMS — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-5 · P2-6 | 🔧 à coder `b582fbf6` |
| ~ | **T52** | Santé par appareil (deviceId, simCards) et allowlist non bloquante pour une RESTORE — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 P2-8 · P2-9 | 🔧 à coder `428d1f39` |
| ~ | **T53** | Tests : exercer la table des tentatives, index dans schema.prisma, migration rejouée sur PostgreSQL réel, changement d'heure du 25/10 — COMMITTÉ (partie faisable seul), en attente de fusion | TRK-066 · doc 19 P2-10 | 🔧 à coder `b407481a` |
| ☐ | **T58** | La cle de refroidissement de la sentinelle des agents doit porter la CAUSE — et courrier-ia doit lire le premier objet JSON equilibre | TRK-069 | 🔧 à coder |
| ~ | **T56** | Corriger les promesses des documents du chantier qui dépassent le code — COMMITTÉ, en attente de fusion | TRK-066 · doc 19 §15 | 🧹 dette doc `0677cd05` |
| ☐ | **T57** | Dépendances : lot séparé après stabilisation (maplibre critique, socket.io/ws, axios via twilio, multer) | TRK-066 · doc 19 §14 | 🔧 à coder |
| ☐ | **T59** | Ne plus remonter au centre d alerte les appels avortes par la fermeture de la page sur le canal anonyme (robots) | TRK-079 | 🔧 à coder |
| ☐ | **T60** | Test fenetre-utile.spec.ts (trajets, sur main) tient à la milliseconde : deux Date.now() distincts — à figer | main · 152883ec | 🔧 à coder |

---

## 👁️ CE QU'ON GUETTE — rien à faire, la mesure tombe toute seule *(15)*

| | # | Quoi | Quand |
|:--:|:--:|---|---|
| ☐ | **T3** | Trancher les quatre questions du coupe-circuit — ou les tenir pour tranchees par le chantier fiabilite (D8) | bloqué |
| ☐ | **T14** | Provoquer ou requalifier : boitier debranche ne fait pas taire les alarmes | test daté |
| ☐ | **T18** | Guetter « SMS non remis au relais » — motif technique CONSERVE | occasion |
| ☐ | **T21** | Accuse de remise de la passerelle SMS | bloqué |
| » | **T10** | Le niveau de l'escalade doit suivre la CAUSE, pas la gravite | occasion |
| » | **T13** | Recalage cartographique : flux neuf repare, mesure a redefinir, historique a rattraper | occasion |
| ☐ | **T19** | REQUALIFIER — l'occasion ne viendra pas seule | test daté |
| ☐ | **T20** | Confier a un humain : le badge ambre du mode fix | test daté |
| » | **T27** | La carte survit a une perte de contexte WebGL | occasion |
| » | **T28** | Redefinir la mesure du recalage : a la cloture, sur une fenetre fermee | occasion |
| » | **T29** | Relire la garde du deploiement au moment ou elle va tuer, pas au moment ou l on decide | occasion |
| » | **T30** | Dedupliquer l alerte d exces de vitesse sur l EXCES, pas sur l identifiant de trajet | occasion |
| » | **T34** | Le poste sait qu il est au plafond : les agents s arretent seuls, un courriel part, un bouton relance tout — decision D5 | occasion |
| » | **T36** | Les agents du poste meurent d un Ctrl-C qui ne leur est pas destine — fenetre cachee, CLI isolee, limite corrigee | occasion |
| ☐ | **T15** | Guetter : « Un point de mesure systeme n'a pas pu etre enregistre » | occasion |

---

## 🖥️ CÔTÉ VPS — *27 constats, presque tous des gestes d'infrastructure*

*Le détail est en [Partie II de la roadmap](./centre-alerte/ROADMAP-CORRECTIFS.md).*

| | # | Quoi |
|:--:|:--:|---|
| ☐ | **V28** | Tuer le client Docker bloque depuis 04h34 UTC le 13/09 — 5e occurrence de VPS-016 |
| ☐ | **V1** | Porter les 6 IMEI muets a l'exploitant |
| ☐ | **V2** | Sortir du parc les 6 boitiers muets depuis plus de 7 jours |
| ☐ | **V3** | Un seul ticket hebergeur pour les deux ecritures root |
| ☐ | **V4** | Planifier un redemarrage vers 23 h 30 |
| ☐ | **V5** | Arbitrer le budget de collecte |
| ☐ | **V7** | Poser les limites memoire sur 30 conteneurs |
| ☐ | **V8** | Separer les projets compose deploy |
| ☐ | **V12** | Restreindre la cle CI github-actions-vizyo-auth |
| ☐ | **V13** | ExecStart par bash, et OnFailure sur tracky-backup |
| ☐ | **V14** | Fixer l'heure du rafraichissement apt (et non reduire son alea) |
| ☐ | **V15** | Epingler Traefik par digest |
| ☐ | **V23** | Afficher l'ecart en jours sur /admin → Audit VPS |
| ☐ | **V29** | Un seul rotateur pour les journaux de conteneur — retirer la stanza logrotate a copytruncate |
| ☐ | **V30** | Reconnaitre le coffre Vaultwarden, les comptes vaultbk / conductorbk et l adresse 179.198.198.199 |
| ☐ | **V6** | Donner un second depositaire a la copie hors-site |
| ☐ | **V9** | Trancher les 4,5 Go d'outillage de developpement dans /root |
| ☐ | **V16** | Epingler alpine par empreinte |
| ☐ | **V17** | Purger 1,4 Go de copies sans retention |
| ☐ | **V18** | Multiplexage SSH cote POSTE |
| ☐ | **V20** | Etiqueter les images de repli au build |
| ☐ | **V21** | Trancher quel mecanisme gouverne le cache de build |
| ☐ | **V22** | Echantillonner wchan 3 fois et publier la repartition |
| ☐ | **V26** | Ranger les deux dossiers de sauvegarde abandonnes |
| ☐ | **V27** | Trancher si la base de DEMONSTRATION doit etre sauvegardee |
| ☐ | **V10** | Retirer /opt/vizyo-leads |
| ☐ | **V19** | random_page_cost sur 6 bases |

---

## ✅ Décisions prises

| | Sujet | Choix | Suite |
|:--:|---|---|---|
| **D1** · 13/09 | Le script qui refuse de déployer pendant un passage | Le rendre incontournable | Fait le jour même : T29 et T33 — la garde relue juste avant la recréation, et un déploiement hors script signalé au centre d’alerte 109 s plus tard. |
| **D2** · 13/09 | Le rythme du rattrapage des tracés | Garder 15 par heure | Rien à changer : quinze par heure, le compteur en haut de page descend seul. |
| **D3** · 13/09 | Un compte API en secours — et pour quoi | Non : tout attend la remise à zéro | Aucun repli API ne sera codé. T1 n’est plus bloquante : elle ne concerne plus que l’assistance et l’optimiseur. |
| **D4** · 13/09 | Un récit pour quels trajets | Tous les trajets (comme aujourd’hui) | Fait : 0 trajet sans récit sur toute la rétention le 13/09 à 17 h 28 UTC (555 récits écrits dans la journée) — T37 close. Et T36 a corrigé ce qui tuait les passages du rattrapage. |
| **D5** · 13/09 | Le poste doit-il savoir qu’il est au plafond | Oui — les agents s’arrêtent d’eux-mêmes jusqu’à l’heure annoncée | Fait : T34 déployée le 13/09 à 17 h 37 UTC et vérifiée sur une pause posée à la main — les agents sortent en une seconde, un courriel est parti à 17 h 50, le bouton « Reprendre maintenant » de /admin l’a levée. Reste à voir au prochain vrai plafond. |
| **D6** · 13/09 | Le modèle des deux audits quotidiens | Opus pour les deux (aujourd’hui) | Inchangé : les deux audits restent en Opus. |
| **D7** · 13/09 | Un abonnement à part pour les agents du poste | Oui, ouvrir un second compte pour les agents | Pas maintenant, par ton choix : T35 le garde dans ce qui t’attend, sans urgence, pour ne pas l’oublier. |
| **D8** · 13/09 | Les quatre questions du coupe-circuit — tranchées par le chantier fiabilité ? | Non — je veux en rediscuter | Clic « je veux en rediscuter » le 13/09 à 23:54 (Paris) sur la page : T3 reste ouverte. Les quatre questions seront reprises avec toi une fois le chantier livré (T40 → T47), avec ce que la contre-expertise a tranché. |
| **D9** · 13/09 | Qui doit recevoir les excès de vitesse | Ne rien changer — trois par jour, c’est vivable | T4 close : seuils et destinataires inchangés (les clients ne reçoivent rien pendant tes tests, T39). Les doublons sont partis avec T30 ; s’il reste trois excès par jour, c’est voulu — la sentinelle « destinataire saturé » pourra le redire, ce ne sera pas un défaut. |
| **D10** · 14/09 | Committer le correctif P0 (clé RESTORE) sur la branche du chantier | Oui — committer maintenant sur la branche du chantier | Fait dans la foulée : commit d5c19a17 sur la branche du chantier, historique nettoyé du reformatage, rebase sur main sans conflit (T46 close), suites vertes. Rien n'est déployé : T41, T42, T44, T45 puis T47 avant toute mise en ligne. |

---

## ✅ FAIT ET PROUVÉ *(22 tâches closes ; les derniers faits marquants)*

*« Prouvé » veut dire mesuré en production — sauf mention contraire.*

| Date | Quoi | La preuve |
|---|---|---|
| 14/09 | **Le S21 diagnostiqué de l'intérieur : le bug du 11/09 a DEUX causes, et la seconde n'est pas dans le téléphone (T43, T61)** | Mobile connecté, lecture seule, 08:40–08:58. (1) Le téléphone ne relève les ordres que toutes les 15 min faute de ping : les 10 RESTORE de 07:00 sont partis à `07:07`, et celui de 20:49 à `21:55` parce que le S21 redémarrait (uptime 60 h = dernier redémarrage le 11/09 vers 20:45) — réglages de l'app tous au défaut (ping vide, LIFO, ni délai ni limite), veille des applis inutilisées ON sans protection, téléphone personnel sur batterie. (2) Les 5 échecs de 07:07 et toutes les reprises du jour sont « RESULT_ERROR_GENERIC_FAILURE » vers `les mêmes numéros` : dix SIM de boîtiers n'ont `jamais` reçu un SMS du S21 depuis juin (…621085 : 36 échecs) alors que leurs voisines livrent à 100 % dans la même seconde, que le fournisseur les dit activées, qu'elles sont en session data, en TCP, et qu'elles émettent des SMS. Ni débit, ni veille, ni batterie : la destination. Test décisif à faire (T61) : un SMS neutre vers …621085 depuis un autre opérateur. Vérifié aussi : le S21 se remet ses propres SMS (preuves hebdo), les 4 webhooks sont en place. |
| 14/09 | **Le S21 est relevé avant d'y toucher : aucun réglage, pull toutes les 15 min, quatre webhooks bien en place (T43)** | Lecture seule depuis le conteneur du relais, 06:33 UTC : serveur capcom6 `1.43.0` sain ; un seul appareil, `lastSeen` vieux de `10 min` (le pull de secours, faute de ping) ; `GET /3rdparty/v1/settings` rend `{}` — tout au défaut, comme le diagnostic du 12/09 ; les quatre webhooks `sms:received/sent/delivered/failed` pointent bien sur le relais (le point P4 du doc 25 est vérifié). Les gestes exacts sur le téléphone sont dans la fiche T43 ; la preuve sera `lastSeen` qui avance toutes les 60 s, écran éteint, pendant 30 min. |
| 14/09 | **Les six derniers correctifs faisables seul sont committés : le chantier n'attend plus que toi (T48, T50, T51, T52, T53, T56)** | Tracky `8a8cb2c4` (T48) : une preuve ne se rétrograde jamais en « envoyée », une CUT orpheline est dispatchée. `b582fbf6` (T51) : une RESTORE non prouvée se rappelle toutes les `15 min`, un SMS bloqué une heure est retenté, un clic manuel répond en 20 s. `428d1f39` (T52) : l'allowlist du relais ne bloque plus une remise en route. `8bb24ca7` (T50) : le glissement exige un vrai geste — un clic en bout de piste ou la touche Fin ne coupent plus rien (3 tests rouges sur l'ancien composant). `b407481a` (T53) : le journal des tentatives est enfin exercé, avec les contraintes de la migration rejouées, et le changement d'heure du `25/10` est couvert. `0677cd05` (T56) : chaque promesse des documents 01–18 est datée « tenu / tenu autrement / non implémenté » (doc 32). Suites : API `260 suites / 4 081 tests`, web 732, smoke 5, typecheck vert ; rien n'est déployé. Non vérifié : rejeu des migrations sur PostGIS 16 réel (Docker éteint ici), annulation SMS effective (capcom6 ≥ 1.45.0). |
| 14/09 | **Une coupe retenue par le garde-fou ne remplit plus le centre d'alerte (T49)** | Tracky `93dba465` : le kill-switch écrit `une` ligne par heure (niveau dégradation : état voulu, pas de courriel) avec le compte des refus et les plaques ; l'interlock une ligne CRITICAL par raison et par quart d'heure ; le cron ne compte plus une coupe retenue comme un blocage. Avant : un CRITICAL par appel, trente véhicules, palier 2/5/15/30 min, un courriel par heure. `8 tests` ; rien n'est déployé. |
| 14/09 | **La procédure de déploiement est écrite, et la migration a été jouée sur un vrai PostgreSQL avant de l'être sur le tien (T47)** | Tracky `fde25b96`, relais `0bb4013`. Doc 25 : téléphone → relais → Tracky par `deploy.sh`, sauvegardes des trois bases, migration rejouée sur une copie AVANT la production, 24 h de preuve, rollback par couche, liste Go/No-Go. Démontré en local avec le même Prisma : la migration à l'horodatage « d'avant » s'applique bien après celles déjà déployées. Trouvé au passage : l'image du serveur SMS n'était pas épinglée — `latest` valait `v1.47.4` quand la production tourne en `v1.43.0` ; c'est corrigé. Rien n'est déployé : la procédure attend le téléphone (T43) et ta relecture. |
| 14/09 | **Chaque matin, une preuve que les SMS partent — et le relais dit enfin ce qu'il sait (T45)** | Relais `ae17b34` : `sent` / `delivered` / `failed` / `cancelled` poussés à Tracky sur `/sms/webhook/status`, signés, avec retries. Tracky `1aa1e0f9` : preuve SMS à `04:30` et `06:30`, verdict à +15 min, écho entrant reconnu comme remise ; sans preuve, une ligne qui dit « les coupes du soir seront refusées ». C'est ce qui manquait à l'interlock six jours sur sept. `20 tests` ajoutés, suites vertes ; rien n'est déployé. Non vérifié : l'auto-envoi du S21 vers son propre numéro. |
| 14/09 | **La sentinelle du téléphone ne crie plus à chaque pull — et son verdict porte sur le bon téléphone (T44)** | Relais `784d766` : santé jugée sur `un` appareil (`CAPCOM6_DEVICE_ID`), quatre états ONLINE / STALE / OFFLINE / UNKNOWN, cartes SIM exposées, réglages bornés (999999999 s ne désactive plus rien), délai d'envoi séparé. Tracky `86a2fc53` : `2` contrôles mauvais pour ouvrir un épisode, `3` sains pour le fermer, rappel toutes les 15 min — une alerte au lieu de quatre par heure ; l'écran /admin dit <i>pourquoi</i>. `27 tests` ajoutés ou réécrits, suites vertes ; rien n'est déployé. |
| 14/09 | **Un boîtier qui revient en ligne reçoit sa remise en route — et une remise en route n'est plus jamais abandonnée (T42)** | Tracky `86c32fa9` : le registre de sockets annonce chaque reconnexion ; la dernière RESTORE non prouvée du boîtier (moins de 24 h, sans coupure demandée depuis) repart aussitôt en TCP — même si elle était « en échec » ou « nul ne sait ». Trois SMS refusés ne ferment plus rien : `K` repart en TCP à chaque reconnexion et toutes les `30 min`, sans un SMS de plus. Et une RESTORE ne renvoie `jamais` K après le J du soir. `18 tests` ajoutés, suites vertes ; rien n'est déployé. |
| 14/09 | **Une coupure par SMS a désormais une date de péremption — et une remise en route passe devant tout (T41)** | Relais `2536ea4` : `ttlSeconds` et `priority` transmis au serveur SMS, appareil explicite, accusé de remise toujours demandé, `DELETE /v1/texto/:id` pour retirer un SMS encore en attente. Tracky `8ab1d08e` : un `stop` périme après `15 min` sur le téléphone, un `resume` part en priorité 100, et une RESTORE qui supplante une CUT fait annuler son SMS. Vérifié sur le contrat public : le serveur 1.43.0 de production connaît déjà ttl, priority et deviceId ; l'annulation demande un serveur ≥ 1.45.0 (T47). `16 tests` ajoutés, suites vertes ; rien n'est déployé. |
| 14/09 | **Le P0 du coupe-circuit est committé, la branche du chantier est propre et rebasée sur main** | Commit `d5c19a17` sur la branche du chantier après ta décision D10. Le reformatage prettier qui gonflait le diff (1 315 lignes pour 16 fonctionnelles sur le catalogue) a été retiré en reconstruisant l'historique — contenu vérifié identique par normalisation — puis `git rebase main` : `7 commits, zéro conflit`. Le relais Texto a subi le même nettoyage (un commit `2de94d8` sur `origin/main`, guillemets du dépôt). Suites après rebase : `4 002` tests API, 727 Web, 423 partagé, 24 Texto. Rien n'est déployé : la production reste sur `66d286f5`. |
| 13/09 | **Le chantier fiabilité passé à la contre-expertise : NO-GO, un P0 démontré — et corrigé le soir même** | Revue indépendante des deux branches (doc 19) : suites reproduites (`3 920` tests API, 727 Web, 416 partagé, 24 Texto), diff normalisé (1 315 lignes brutes → `16 fonctionnelles` sur le catalogue), VPS lu sans rien toucher (`lastSeen` du téléphone figé `552 s` au repos, serveur capcom6 1.43.0 dont `/health` ne teste que la base). Le défaut principal — une RESTORE d'hier qui avale celle du lendemain — a été `prouvé par un test contre le service réel`, puis corrigé dans le worktree avec huit tests neufs (doc 20). Rien n'est déployé : la production reste sur `66d286f5`. |
| 13/09 | **Les notifications ne partent plus qu’aux super-admins — et une commande SMS a enfin une fin de vie** | Ta consigne du soir : personne d’autre que toi pendant les tests. Trois comptes clients avaient reçu `88 alertes push en 30 jours` (mh cars 63 excès de vitesse) parce que le périmètre valait « tout le monde » : ramené aux super-admins à 20 h 25 UTC. Même déploiement : les deux commandes SMS du 1er septembre, « envoyées » depuis `298 heures`, sont passées « envoyée, sans réponse » au premier balayage (T5). |
| 13/09 | **Le poste sait qu’il est au plafond : les agents s’arrêtent, un courriel part, un bouton relance** | Pause posée à la main à 17 h 41 UTC : le courrier lancé dans la foulée est sorti en `une seconde` sans toucher aux huit travaux en file ; au contrôle de 17 h 50, `un courriel` (livré) et `une seule ligne` au centre d’alerte ; « Reprendre maintenant » a rendu `levées : 1` et le bandeau a disparu. Décision D5 tenue le jour même. |
| 13/09 | **Les trois jours de plafond ont leurs récits — et le rattrapage ne meurt plus d’un Ctrl-C** | `555 récits` écrits le 13/09, `0 trajet sans récit` sur toute la rétention à 17 h 28 UTC. Le dernier passage (119 récits en 82 min) est le premier lancé sans fenêtre : il a fini par sa propre ligne de fin, quand les quatre passages tués plus tôt dans la journée n’avaient laissé aucune trace. Le courrier a livré ses huit travaux en attente le soir même (18 h 01 UTC) et le `rapport d’activité du 4 → 11/09` — le seul effet du plafond qu’un client pouvait voir — est écrit à 18 h 20. |
| 13/09 | **Le témoin des tâches planifiées sait se taire** | Quatre CRITICAL ouvertes depuis le 6 septembre — 164 heures — se sont archivées seules au contrôle de 13:35, note « Tâche repassée … (résolution automatique) ». Le témoin crie toujours sur une tâche vraiment arrêtée : une ligne écrite après le dernier passage n’est jamais touchée. |
| 13/09 | **Le script de déploiement est incontournable** | Un contournement volontaire — l’API recréée à la main à 12:55 UTC — a produit la ligne « Déploiement hors script » au centre d’alerte `109 s plus tard`, avec le sha, l’heure et l’auteur du dernier déploiement légitime. La garde est relue juste avant la recréation, les repères de repli sont posés seuls. Décision D1 tenue le jour même. |
| 09/09 | **La sentinelle nomme des boîtiers, plus des flottes** | Passage de 06:30 : quatre véhicules nommés avec leur part — FV-941-LZ à 84 %, GA-490-SJ à 64 % — et `silence pour cdef31`, qui recevait un message la veille. Le rejeu de la règle en SQL donne exactement les mêmes. |
| 09/09 | **La ligne au départ attrape un vrai incident** | Un déploiement pendant le passage de 19:45 l’a tué. Marqué `interrupted`, e-mail livré à 19:50, travail rattrapé au passage suivant. Avant le 08/09, il aurait disparu sans une ligne. |
| 08/09 | **L’alerte qui se répétait toutes les heures est éteinte** | Un trajet du 8 juillet, sans positions conservées, criait une fois par heure depuis 27 h. `Zéro ligne depuis`, sur 30 heures. |
| 08/09 | **Le recalage des tracés est réparé pour les trajets neufs** | `224 trajets sur 224` clôturés depuis le correctif suivent la route. Avant : 156 sur 1 217. |
| 08/09 | **Une seule erreur critique suffit à prévenir** | Cinq e-mails livrés en deux jours, un par erreur, refroidissement respecté. Avant, il en fallait cinq dans l’heure. |
| 08/09 | **Les fonds de carte ne dépendent plus de CARTO** | Plus aucune tuile « API KEY REQUIRED » en travers de la carte : zéro URL `cartocdn` dans le paquet servi. |
| 07-08/09 | **Chantier cartes — échelle de vitesse unique, traînées, légendes, repères fixes** | Six tâches et trois défauts de recette, passés par les cinq niveaux jusqu’à la mesure en production. |

---

## 📍 Où vit quoi

L'index complet est dans [`README.md`](./README.md). L'essentiel :

- **`docs/SUIVI.md`** — Le même contenu que cette page, dans le dépôt.
- **`centre-alerte/app/taches.json`** — La source des tâches. Cette page en est une vue.
- **`centre-alerte/ROADMAP-CORRECTIFS.md`** — Le pourquoi de chaque fiche, tenu chaque nuit.
- **`docs/README.md`** — L’index : vivant, servi par l’API, ou archive.
- **`fiabilite-coupe-circuit-2026-09/`** — le chantier coupe-circuit : incident, audit, architecture, plan, runbook, contre-expertise (19) et correctif P0 (20).
- **`centre-alerte/` et `vps-audit/`** — 🔒 **artefacts servis par l'API**, pas de la documentation à lire. Ne rien y déplacer (chemins câblés en six endroits chacun).
- Tout `.md` portant un bandeau **⛔ ARCHIVE** décrit un chantier terminé. Il reste pour l'histoire.
