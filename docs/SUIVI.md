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

*Dernière mise à jour : 2026-09-14 (relevé du 15 septembre 2026, 20h15 Paris) · dépôt sur `main`*

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
| » | **T40** | 🔴🔴 P0 — La clé d'unicité RESTORE ne doit plus vivre pour toujours (RESTORE du lendemain avalée) — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P0-1 | 🔧 à coder `d5c19a17` |
| » | **T41** | 🔴🔴 P0 — Donner une validité aux SMS CUT (ttl), une priorité aux RESTORE, un appareil explicite, et annuler le SMS CUT supplanté — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P0-2 | 🔧 à coder `8ab1d08e` |
| » | **T42** | 🔴 Relancer une RESTORE non prouvée à la reconnexion TCP du boîtier — et ne plus la rendre terminale après trois SMS — FUSIONNÉ sur main le 14/09, à déployer | TRK-066 · doc 19 P1-1 | 🔧 à coder `86c32fa9` |
| ☑ | **T43** | 🔴 Téléphone passerelle S21 configuré le 14/09 (ping 60 s vérifié, FIFO, délais, limite, veille OFF) — restent les variables du relais dans la fenêtre de déploiement | TRK-066 · doc 19 P1-2 | 🔵 terrain |
| » | **T44** | 🔴 Sentinelle Android : hystérésis, bornes d'environnement, fraîcheur par appareil, délai d'envoi séparé du délai de santé — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P1-2 | 🔧 à coder `86a2fc53` |
| » | **T45** | 🔴 Preuve SMS quotidienne réconciliée (T-30 min avant chaque fenêtre) — et le relais pousse ses statuts — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P1-3 | 🔧 à coder `1aa1e0f9` |
| ☑ | **T46** | 🔴 Nettoyer le diff du chantier (reformatage prettier), rebaser sur main, résoudre le conflit — la production est déjà sur 66d286f5 | TRK-066 · doc 19 P1-4 | 🔧 à coder |
| ☑ | **T47** | 🔴 D — La fenêtre de déploiement — JOUÉE le 15/09 au soir : prod = chantier complet (fa9ff1d1 puis 0c9672c9), relais 724bcb8, kill-switch true | TRK-066 · doc 19 P1-5 | 🟡 préparé |
| » | **T48** | Course ACK/SMS : ne jamais rétrograder ACKNOWLEDGED en SENT ; dispatcher une CUT PENDING orpheline au lieu de la rendre telle quelle — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P2-1 · P2-4 | 🔧 à coder `8a8cb2c4` |
| » | **T49** | Kill-switch et interlock : une ligne par cause et espacée, pas un CRITICAL par appel — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P2-2 | 🔧 à coder `93dba465` |
| » | **T50** | Glissement de confirmation réellement volontaire : ni un clic en bout de piste, ni la touche End — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P2-3 | 🔧 à coder `8bb24ca7` |
| » | **T51** | Rappeler une RESTORE qui traîne (toutes les 15 min) et ne pas suspendre le clic manuel derrière la file SMS — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P2-5 · P2-6 | 🔧 à coder `b582fbf6` |
| » | **T52** | Santé par appareil (deviceId, simCards) et allowlist non bloquante pour une RESTORE — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P2-8 · P2-9 | 🔧 à coder `428d1f39` |
| » | **T53** | Tests : exercer la table des tentatives, index dans schema.prisma, migration rejouée sur PostgreSQL réel, changement d'heure du 25/10 — DÉPLOYÉ le 15/09 | TRK-066 · doc 19 P2-10 | 🔧 à coder `b407481a` |
| ☑ | **T54** | 🔴 Recette réelle : boîtier de banc, puis un canari MH Cars, puis un CDEF31 — un à la fois, présence physique, jamais les 37 | TRK-066 · doc 19 §3 phase 5 | 🔵 terrain |
| ☐ | **T55** | 🔴 Téléphone passerelle : le S21 branché EN PERMANENCE et déverrouillé (hors ligne 15:49→19:51 le 15/09), puis un second téléphone + seconde SIM (autre opérateur), jamais sous le même deviceId | TRK-066 · doc 12 · doc 19 P2-8 | 🤝 humain |
| ☑ | **T56** | Corriger les promesses des documents du chantier qui dépassent le code — FUSIONNÉ sur main le 14/09, à déployer | TRK-066 · doc 19 §15 | 🧹 dette doc |
| ☐ | **T57** | Dépendances : lot séparé après stabilisation (maplibre critique, socket.io/ws, axios via twilio, multer) | TRK-066 · doc 19 §14 | 🔧 à coder |
| » | **T58** | La cle de refroidissement de la sentinelle des agents doit porter la CAUSE — et courrier-ia doit lire le premier objet JSON equilibre — sur main, FUSIONNÉ et poussé le 14/09, à déployer | TRK-069 | 🔧 à coder `1539674c` |
| » | **T59** | Ne plus remonter au centre d alerte les appels avortes par la fermeture de la page sur le canal anonyme (robots) — sur main, FUSIONNÉ et poussé le 14/09, à déployer | TRK-079 | 🔧 à coder `314e4193` |
| » | **T60** | Test fenetre-utile.spec.ts (trajets, sur main) tient à la milliseconde : deux Date.now() distincts — à figer — sur main, FUSIONNÉ et poussé le 14/09, à déployer | main · 152883ec | 🔧 à coder `979fdfec` |
| ☐ | **T61** | Deux SIM de boîtiers (HD-584-BF, BP-434-RD) restent INJOIGNABLES par SMS depuis le S21 après remise en état ; les huit autres sont revenues — test depuis un autre opérateur ou ticket WhereverSIM | TRK-066 · S21 · doc 10 test B/C | 🤝 humain |
| » | **T62** | 🔴 Une SIM injoignable par SMS met le véhicule en « TCP seul » : coupe auto seulement boîtier connecté, RESTORE en TCP toutes les 5 min, un SMS-sonde par 6 h — DÉPLOYÉ le 15/09 | TRK-066 · doc 35 | 🔧 à coder `b3ee67e2` |
| ☑ | **T63** | 🔴 C — Prérequis J-1 — FAITS le 15/09 (Device ID, numéro de preuve, v1.43.0, créneau) ; reste : le S21 branché EN PERMANENCE | TRK-066 · doc 25 §2 | 🤝 humain |
| ☐ | **T65** | 🔴 E — Les 24 h de preuve après le déploiement, lues à chaque passage de la routine du centre d'alerte (six verdicts) | TRK-066 · doc 25 §7 · PROCEDURE-AUDIT | 🟢 auto |
| ☐ | **T66** | 🔴 deploy.sh journalise ses REFUS et ses abandons, et la sentinelle « deploiement » les dit — un refus qui ne s ecrit nulle part se lit comme un succes | TRK-077 | 🔧 à coder |
| » | **T67** | 🔴 La sentinelle des RESTORE non prouvées relit l'historique entier après la migration — bornée à 24 h (0c9672c9), DÉPLOYÉ le 15/09 | TRK-066 · T51 | 🔧 à coder `0c9672c9` |

---

## 🟢 Où on en est

| Ce qui tourne | Où ça en est | Note |
|---|---|---|
| Rattrapage du recalage des tracés | 12 186 restants (6 139 dans la fenêtre de 60 j) | ≈ 34 jours à 15 par heure — 435 traces depuis le 13/09 |
| Reprise des analyses d’avant le 4 septembre | 25 par passage | s’éteint seule |
| Coupe-circuit automatique — LE CHANTIER EST EN PRODUCTION depuis ce soir 19:35 | 30 plannings actifs sur 37 — sur le chantier, kill-switch true | ce soir : preuve SMS à la main, coupes 22:00 sous interlock ; demain 07:00 : reprises relancées |

| Chiffre | |
|---|---|
| **3** | défauts nés au centre d'alerte sur 24 h (sur 11 lignes ; 13 CRITICAL d'agents refermées seules, 4 CRITICAL restent) |
| **1092/1092** | trajets clos depuis le correctif du 08/09 suivent la route |
| **8** | gestes qui n’avancent que par toi |
| **98** | fiches suivies dans la roadmap |

---

## 🤝 CE QUI T'ATTEND — rien ne peut avancer sans toi *(8 gestes)*

| | # | Quoi | Fiche | Classe |
|:--:|:--:|---|---|---|
| ☐ | **T7** | 🔴🔴 Ouvrir la fenetre de maintenance du role non-superutilisateur | TRK-035 | 🤝 humain |
| ☐ | **T38** | 🔴🔴 Remettre en service les plannings du coupe-circuit — 🚀 15/09 19:35 : chantier EN PRODUCTION (kill-switch true) ; CDEF31 armé par le client, MH Cars à armer après une nuit propre | TRK-066 | 🤝 humain |
| ☐ | **T9** | 🔴 Boîtiers muets, antennes et déclarations — UNE fiche terrain : lever la déclaration des trois HM-… qui roulent alertes coupées ; déclarer ou dépanner GLA•KC•31, FG-669-DQ, FS-253-HR, FS-808-CE, FZ-862-VY, DZ-034-CA, HD-292-SH, KSR•370 ; porter les 6 IMEI muets à l'exploitant ou les sortir du parc (statut, pas DELETE) | — | 🔵 terrain |
| ☐ | **T55** | 🔴 Téléphone passerelle : le S21 branché EN PERMANENCE et déverrouillé (hors ligne 15:49→19:51 le 15/09), puis un second téléphone + seconde SIM (autre opérateur), jamais sous le même deviceId | TRK-066 · doc 12 · doc 19 P2-8 | 🤝 humain |
| ☐ | **T1** | Recharger au moins UN des deux comptes IA | TRK-071 | 🤝 humain |
| ☐ | **T35** | Ouvrir un second abonnement reserve aux agents du poste — quand tu le decideras (D7) | TRK-071 | 🤝 humain |
| ☐ | **T39** | Rouvrir les notifications aux clients (PUSH_ROLLOUT=ALL) quand les tests seront finis | TRK-065 | 🤝 humain |
| ☐ | **T61** | Deux SIM de boîtiers (HD-584-BF, BP-434-RD) restent INJOIGNABLES par SMS depuis le S21 après remise en état ; les huit autres sont revenues — test depuis un autre opérateur ou ticket WhereverSIM | TRK-066 · S21 · doc 10 test B/C | 🤝 humain |

---

## 🔧 CE QUE JE PEUX CODER — le plus grave d'abord *(3)*

| | # | Quoi | Fiche | Classe |
|:--:|:--:|---|---|---|
| ☐ | **T65** | 🔴 E — Les 24 h de preuve après le déploiement, lues à chaque passage de la routine du centre d'alerte (six verdicts) | TRK-066 · doc 25 §7 · PROCEDURE-AUDIT | 🟢 auto |
| ☐ | **T66** | 🔴 deploy.sh journalise ses REFUS et ses abandons, et la sentinelle « deploiement » les dit — un refus qui ne s ecrit nulle part se lit comme un succes | TRK-077 | 🔧 à coder |
| ☐ | **T57** | Dépendances : lot séparé après stabilisation (maplibre critique, socket.io/ws, axios via twilio, multer) | TRK-066 · doc 19 §14 | 🔧 à coder |

---

## 👁️ CE QU'ON GUETTE — rien à faire, la mesure tombe toute seule *(23)*

| | # | Quoi | Quand |
|:--:|:--:|---|---|
| » | **T40** | P0 — La clé d'unicité RESTORE ne doit plus vivre pour toujours (RESTORE du lendemain avalée) — DÉPLOYÉ le 15/09 | occasion |
| » | **T41** | P0 — Donner une validité aux SMS CUT (ttl), une priorité aux RESTORE, un appareil explicite, et annuler le SMS CUT supplanté — DÉPLOYÉ le 15/09 | occasion |
| » | **T10** | Le niveau de l'escalade doit suivre la CAUSE, pas la gravite | occasion |
| » | **T13** | Recalage cartographique : flux neuf repare, mesure a redefinir, historique a rattraper | occasion |
| » | **T28** | Redefinir la mesure du recalage : a la cloture, sur une fenetre fermee | occasion |
| » | **T29** | Relire la garde du deploiement au moment ou elle va tuer, pas au moment ou l on decide | occasion |
| » | **T30** | Dedupliquer l alerte d exces de vitesse sur l EXCES, pas sur l identifiant de trajet | occasion |
| » | **T34** | Le poste sait qu il est au plafond : les agents s arretent seuls, un courriel part, un bouton relance tout — decision D5 | occasion |
| » | **T36** | Les agents du poste meurent d un Ctrl-C qui ne leur est pas destine — fenetre cachee, CLI isolee, limite corrigee | occasion |
| » | **T42** | Relancer une RESTORE non prouvée à la reconnexion TCP du boîtier — et ne plus la rendre terminale après trois SMS — FUSIONNÉ sur main le 14/09, à déployer | occasion |
| » | **T44** | Sentinelle Android : hystérésis, bornes d'environnement, fraîcheur par appareil, délai d'envoi séparé du délai de santé — DÉPLOYÉ le 15/09 | occasion |
| » | **T45** | Preuve SMS quotidienne réconciliée (T-30 min avant chaque fenêtre) — et le relais pousse ses statuts — DÉPLOYÉ le 15/09 | occasion |
| » | **T62** | Une SIM injoignable par SMS met le véhicule en « TCP seul » : coupe auto seulement boîtier connecté, RESTORE en TCP toutes les 5 min, un SMS-sonde par 6 h — DÉPLOYÉ le 15/09 | occasion |
| » | **T67** | La sentinelle des RESTORE non prouvées relit l'historique entier après la migration — bornée à 24 h (0c9672c9), DÉPLOYÉ le 15/09 | occasion |
| » | **T48** | Course ACK/SMS : ne jamais rétrograder ACKNOWLEDGED en SENT ; dispatcher une CUT PENDING orpheline au lieu de la rendre telle quelle — DÉPLOYÉ le 15/09 | occasion |
| » | **T49** | Kill-switch et interlock : une ligne par cause et espacée, pas un CRITICAL par appel — DÉPLOYÉ le 15/09 | occasion |
| » | **T50** | Glissement de confirmation réellement volontaire : ni un clic en bout de piste, ni la touche End — DÉPLOYÉ le 15/09 | occasion |
| » | **T51** | Rappeler une RESTORE qui traîne (toutes les 15 min) et ne pas suspendre le clic manuel derrière la file SMS — DÉPLOYÉ le 15/09 | occasion |
| » | **T52** | Santé par appareil (deviceId, simCards) et allowlist non bloquante pour une RESTORE — DÉPLOYÉ le 15/09 | occasion |
| » | **T53** | Tests : exercer la table des tentatives, index dans schema.prisma, migration rejouée sur PostgreSQL réel, changement d'heure du 25/10 — DÉPLOYÉ le 15/09 | occasion |
| » | **T58** | La cle de refroidissement de la sentinelle des agents doit porter la CAUSE — et courrier-ia doit lire le premier objet JSON equilibre — sur main, FUSIONNÉ et poussé le 14/09, à déployer | occasion |
| » | **T59** | Ne plus remonter au centre d alerte les appels avortes par la fermeture de la page sur le canal anonyme (robots) — sur main, FUSIONNÉ et poussé le 14/09, à déployer | occasion |
| » | **T60** | Test fenetre-utile.spec.ts (trajets, sur main) tient à la milliseconde : deux Date.now() distincts — à figer — sur main, FUSIONNÉ et poussé le 14/09, à déployer | occasion |

---

## 🖥️ CÔTÉ VPS — *15 constats, presque tous des gestes d'infrastructure*

*Le détail est en [Partie II de la roadmap](./centre-alerte/ROADMAP-CORRECTIFS.md).*

| | # | Quoi |
|:--:|:--:|---|
| ☐ | **V3** | Un seul ticket hebergeur pour les deux ecritures root |
| ☐ | **V4** | Planifier un redemarrage vers 23 h 30 |
| ☐ | **V5** | Arbitrer le budget de collecte |
| ☐ | **V7** | Poser les limites memoire sur 30 conteneurs |
| ☐ | **V8** | Separer les projets compose deploy |
| ☐ | **V12** | Restreindre la cle CI github-actions-vizyo-auth |
| ☐ | **V13** | ExecStart par bash, et OnFailure sur tracky-backup |
| ☐ | **V14** | Fixer l'heure du rafraichissement apt (et non reduire son alea) |
| ☐ | **V15** | Epingler Traefik par digest |
| ☐ | **V17** | Ménage du VPS — cinq gestes préparés, une seule session : renommer les deux dossiers de sauvegarde abandonnés (éteint deux 🟠 faux par jour), purger 1,4 Go de copies sans rétention, retirer /opt/vizyo-leads, trancher les 4,5 Go d'outillage dans /root, épingler alpine par empreinte |
| ☐ | **V23** | Afficher l'ecart en jours sur /admin → Audit VPS |
| ☐ | **V29** | Un seul rotateur pour les journaux de conteneur — retirer la stanza logrotate a copytruncate |
| ☐ | **V30** | Reconnaitre le coffre Vaultwarden, les comptes vaultbk / conductorbk / dispocarbk, l adresse 179.198.198.199 et le role de depositaire de DEUX applications |
| ☐ | **V31** | Reparer le copieur hors-site de Vizyo Verify : ne plus s arreter sur un manifeste orphelin (cote poste), purger par paire (cote VPS) |
| ☐ | **V6** | Donner un second depositaire a la copie hors-site |

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

## ✅ FAIT ET PROUVÉ *(49 tâches closes ; les derniers faits marquants)*

*« Prouvé » veut dire mesuré en production — sauf mention contraire.*

| Date | Quoi | La preuve |
|---|---|---|
| 15/09 | **Le chantier coupe-circuit est EN PRODUCTION : fenêtre jouée de 19:20 à 20:15 (prod fa9ff1d1 puis 0c9672c9, relais 724bcb8, kill-switch true)** | `journal.jsonl` : `fa9ff1d1` à 17:35:05 UTC (226 s) ; migrations `20260912110000` et `20260914150000` appliquées ; artefact vérifié dans le conteneur (T42, T45, T62, kill-switch) ; `/api/health` 200 ; 33 boîtiers reconnectés en TCP ; relais : `selection: configured`, SIM 1. Migration démontrée avant sur `tracky_copie` (0 erreur). Deux écarts vus et traités : le S21 hors ligne depuis 15:49 (sentinelle T44 en CRITICAL à 19:37, ping repris 19:51 après déblocage) ; la sentinelle T51 réveillant ~50 RESTORE FAILED historiques (correctif `0c9672c9` borné à 24 h, 148 tests, redéployé). Le build API est passé de 32 min à 4 min 21 une fois V28 tué. |
| 15/09 | **Les tâches ont été optimisées : 20 fiches closes, 8 fusionnées dans 3 — il reste ce qui protège quelque chose et a un geste** | Closes parce que tranchées par le chantier déployé (T3, T21, T18, T43, T56, T54), non exerçables ou cosmétiques (T15, T19, T20, T14), faites ce soir (V28), déconseillées ou impossibles (V19, V22, V18), sans propriétaire (V20, V21), closes sur le fait (V27). Fusions : boîtiers muets / antennes / déclarations → T9 ; téléphone passerelle → T55 ; ménage du VPS → V17. V4 et V5 débloquées par V28. |
| 15/09 | **Nuit du 14 au 15 sur l'ancien code : 24/24 coupes, 23/24 reprises — GS-928-NX immobilisé 2 h 56 en silence, réparé à la main** | `engine_control_commands` : 24 CUT TCP acquittées 20:00:01–20:00:12 UTC ; 24 RESTORE TCP à 05:00–05:01 UTC, 23 acquittées en ≤ 5 s, GS-928-NX `SENT_UNCONFIRMED` à 05:40 sans relance ni SMS (`sms_logs` vide) ni ligne au centre d'alerte ; positions : boîtier connecté toute la nuit, trois tentatives de démarrage 07:46–07:53 UTC (contact 1–5 s, 0 km/h), RESTORE manuelle du veilleur de nuit à 07:56:39 acquittée en 3 s, départ à 08:01, 39 km/h à 08:09. HM-769-GA jamais coupé (hors champ GPS, report de sécurité). Deux reprises manuelles nocturnes (23:13, 23:14) servies sans re-coupe. |
| 14/09 | **🔴🔴 Les 30 plannings CDEF31 ont été réarmés par le client à 09:03 — sur l'ancien code : sans déploiement, 25 coupes ce soir à 22:00 comme le 11/09** | `vehicle_schedules` : 30/30 CDEF31 `enabled`, ligne de base `IN_WINDOW` posée au tick de 07:03:15 UTC ; `system_activity_logs` : `POST /api/fleet-schedules/bulk` à 07:03:16 UTC par le gestionnaire CDEF31 (deux aperçus juste avant). Production = `9afdf52a` : le kill-switch et l'interlock n'existent que dans le chantier (`01756db7`), jamais déployé. Cinq des trente boîtiers sont muets depuis 13 à 25 jours (dormance : le cron les ignore) ; les 25 autres sont vivants en TCP. Mesuré aussi pour la fenêtre : `NODE_ENV=production` dans le conteneur (kill-switch fail-closed effectif dès le déploiement), `env_file` transmet tout, le numéro de preuve est déjà dans l'allowlist (preuve hebdo remise à 07:00 UTC), un seul appareil enrôlé (Device ID facultatif). |
| 14/09 | **Fusionné : le chantier coupe-circuit est sur main (Tracky #138, relais #9), avec T62 « SIM injoignable = TCP seul » — il ne reste que la fenêtre de déploiement, ensemble** | Fusions en merge commit après `pnpm verify` sur la branche puis sur la branche fusionnée avec `origin/main` : typecheck vert, smoke 5/5, partagé 423, API `262 suites / 4 145 tests`, web 740 ; relais 7/55. T62 (doc 35) répond à la question du jour : on ne sait pas encore <i>où</i> deux SIM sont refusées (Free, le fournisseur ou la carte — un SMS depuis un autre opérateur tranche), mais le système le SAIT désormais : coupe automatique seulement boîtier connecté, remise en route en TCP toutes les 5 min et à chaque reconnexion, un SMS-sonde par 6 h, une ligne par jour. La routine du centre d'alerte lira les 24 h de preuve (six verdicts, T65). Production inchangée : `9afdf52a`. |
| 14/09 | **Plus rien à coder sans toi : T58, T59, T60 committés sur main, la copie périmée retirée, la fiche de fusion écrite** | Sur `main` (local, non poussé) : `22ec4c1f` (T58 — la sentinelle des agents refroidit PAR CAUSE, et courrier-ia lit le premier objet JSON équilibré ; 56 + 7 tests), `25fa2af9` (T59 — un fetch avorté par la fermeture de la page ne remonte plus, le canal anonyme ne remonte que les bugs JS ; 8 tests, suite web 729), `c8fd9be8` (T60 — horloge figée). La branche du chantier fusionne proprement sur `origin/main` (`merge-tree` sans conflit, aucun fichier commun) ; la copie non suivie qui aurait masqué les vrais documents à la fusion est retirée. Doc 34 : les 27 commits Tracky et les 5 du relais, l'ordre de relecture en 2 h. |
| 14/09 | **Le S21 est configuré et le prouve : un ping par minute — et les tests SMS renversent la conclusion du matin (T43, T61)** | Sur le téléphone, avec ton accord : ping `60 s`, FIFO, délais 10/15 s, limite 60/h, Local server OFF, veille des applis OFF ; `lastSeen` avance de 60 s en 60 s depuis 09:23 (lu sur le serveur). Puis 13 SMS de statut `check123456` (facturés sur ta ligne — arrêtés à ta demande) : par le relais, `8 des 10 SIM` que rien n'atteignait depuis des semaines répondent en quelques secondes (…621085, 36 échecs depuis juin : `delivered en 8 s`) ; `2 restent en échec` au départ, HD-584-BF et BP-434-RD, boîtiers pourtant en ligne, SIM activées, IMEI concordants. Le défaut du 11/09 tenait donc surtout à l'état du téléphone (pas de ping, app jamais redémarrée) ; pour ces deux véhicules, il reste un test « autre opérateur », à 1 SMS. |
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
