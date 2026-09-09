# Roadmap des correctifs — centre d'alerte **et VPS** de production Tracky

> **Refondue le 2026-09-06**, à partir des **20 fiches ouvertes** du
> [référentiel](./REFERENCE-ERREURS.md) et des six derniers audits (01/09 → 06/09). Ce fichier dit
> **quoi faire, dans quel ordre, et ce qui est vérifiable aujourd'hui** — le référentiel, lui, dit
> *pourquoi*. Les deux ne se recopient pas.
>
> 🆕 **Élargie le 2026-09-06 aux constats du VPS de production.** Le fichier porte désormais **deux
> parties** :
> - **[Partie I](#-ce-qui-attend-une-décision-ou-un-geste-humain) — le centre d'alerte** (fiches
>   `TRK-nnn`), source : [`REFERENCE-ERREURS.md`](./REFERENCE-ERREURS.md) ;
> - **[Partie II](#partie-ii--vps-de-production--25-constats-confirmés-et-non-corrigés) — le VPS**
>   (fiches `VPS-nnn`), source : `docs/vps-audit/REFERENCE-CONSTATS.md`.
>
> *Les deux dispositifs sont distincts — l'un lit les erreurs de l'application, l'autre l'état de la
> machine — mais **les tâches, elles, atterrissent sur les mêmes épaules**. C'est la seule raison de
> les réunir ici : un backlog par instrument produit deux files que personne ne priorise l'une
> contre l'autre.*
>
> 📌 **Ce fichier est le SEUL sans date dans son nom, et c'est délibéré : c'est la roadmap
> VIVANTE.** `ROADMAP-CORRECTIFS-2026-08-25.md`, `-2026-09-01.md` et `-2026-09-04.md` sont les
> plans de passes de correction passées — ils décrivent ce qui a été fait ces jours-là et ne se
> mettent plus à jour. *Un dossier qui contient quatre roadmaps doit dire laquelle fait foi, sans
> quoi la plus récemment ouverte gagne — et ce n'est pas un critère.*

---

## 📋 Comment on suit ce fichier — la règle de tenue

> **Décision du propriétaire, 2026-09-06 : ce fichier est le fil directeur des corrections.**
> On ne travaille pas à côté de lui, et **on le coche au fur et à mesure**.

**Chaque tâche porte un identifiant stable** — `T-nn` pour le centre d'alerte, `V-nn` pour le VPS.
L'identifiant ne change jamais et **n'est jamais réutilisé**, même quand la tâche est close : c'est
lui qui permet de dire « T10 est fait » dans un commit, un rapport ou une conversation, six semaines
plus tard.

### Les quatre règles

1. **Une tâche ne DISPARAÎT jamais.** Faite, elle passe à `[x]` **✅ FAIT** et reste en place, avec
   sa date, son commit et sa preuve. *Une liste qui raccourcit ne se relit pas ; elle s'oublie.*
2. **« Fait » veut dire PROUVÉ, pas écrit.** Trois états distincts, et aucun ne remplace le suivant :

   | Marque | Ce que ça veut dire |
   |:--:|---|
   | `[~]` | **Écrit et commité** — pas en ligne. |
   | `[»]` | **Déployé** — en ligne, **mais la preuve n'est pas encore venue**. |
   | `[x]` | **✅ FAIT** — déployé **ET** vérifié sur l'artefact servi ou par la mesure. |

   > 🔑 *C'est la leçon payée quatre fois cette semaine : un correctif commité n'est pas déployé, et
   > un correctif déployé n'est pas prouvé.* Cocher `[x]` sans preuve, c'est fabriquer le
   > « ✅ FAIT » de `docs/vps-audit/ROADMAP.md` — celui qui annonçait VPS-013 clos alors que sa
   > propre section détaillée disait l'inverse.
3. **On coche DANS LE MÊME PASSAGE que la correction**, jamais « plus tard ». Le tableau de bord et
   le journal d'avancement se remplissent avec le commit du correctif, pas après.
4. **Les trois gestes de diffusion valent aussi pour ce fichier** : l'**écrire**, le **copier** sur
   le VPS (`scp -r docs/centre-alerte/. …`, sinon l'écran `/admin/alerts` ne le voit pas), le
   **committer**. *Sauter le troisième ne se voit nulle part.*

⚠️ **Ce qu'il ne faut PAS faire** — retirer une ligne close pour « alléger », déplacer une tâche
d'une section à l'autre sans le dire, ou cocher `[x]` sur la foi d'une fiche plutôt que d'une mesure.
*Si une fiche et l'artefact servi se contredisent, **l'artefact a raison**.*

---

## 🗂️ Tableau de bord — 56 tâches, l'avancement d'un coup d'œil

**Au 2026-09-09 (après les DEUX routines) : 6 faites · 4 déployées, preuve attendue ·
0 commitée · 46 ouvertes.**

> ⚖️ **LE FAIT VPS DU JOUR, 09/09 : DEUX TESTS ÉCRITS D'AVANCE TOMBENT ENTRE LEURS BRANCHES, ET LA
> FAUTE EST DANS LES TESTS.** Tous deux se réfèrent au jeudi 09-03 sur une table dont la rétention
> vaut **3,95 jours** : **le point de référence avait été effacé avant l'échéance** (🆕 VPS-M94).
> *Un test daté à J+3 sur une source qui n'en garde que 4 est indécidable par construction.*
> ✅ **Mais la question de fond, elle, est tranchée — sur la table où elle est décidable** :
> `positions` garde 62 jours et rend **×0,94 mardi contre mardi**, à 30 émetteurs contre 30. **Le
> cycle hebdomadaire tient, il n'y a pas de dérive.** 🔑 *La règle qui en sort vaut pour toutes les
> tâches de ce fichier : avant d'écrire « au passage du JJ/MM, X devra valoir Y », vérifier que la
> rétention de la source de X couvre l'échéance. Sinon **changer de source, pas de date**.*
>
> ✅ **Et `apt` rend enfin une mesure valide (VPS-033, 3ᵉ succès sur 15) — qui sert immédiatement à
> réfuter deux alarmes** : le « 1 correctif de sécurité en attente » est une ligne **ESM** derrière
> un abonnement non souscrit (🆕 VPS-M97), et le `75 → 75` **n'est pas une panne de l'installateur**
> — les 75 sont hors des `Allowed-Origins`, par configuration standard d'Ubuntu, et le journal
> montre 34 paquets installés le 09-02 et 20 le 09-05. *Un total qui ne bouge pas ne prouve rien.*

> ✅ **LE FAIT DU JOUR, 09/09 : T24 PASSE À ✅ FAIT, ET LA PREUVE ÉTAIT ÉCRITE D'AVANCE — AU MOT
> PRÈS.** La consigne du 08/09 exigeait *« 24 lignes, **dont une ou plusieurs MARQUÉES
> INTERROMPUES** — et si le compte monte à 24 sans qu'aucune ne soit marquée, on a maquillé le carnet
> au lieu de le tenir »*. Le **08/09 rend 24 passages sur 24, dont EXACTEMENT 1 `interrupted`** :
> celui de **05:45:00**, tué en vol par le déploiement de 05:45. **Les deux moitiés du test sont
> franchies séparément** — le compte monte à 24, *et* la ligne manquante n'a pas été fabriquée.
> 🔑 *Une consigne qui prévoit d'avance la façon dont on pourrait la satisfaire malhonnêtement est ce
> qui sépare une preuve d'un chiffre qui arrange.*
>
> ✅ **Et T26 passe à `»` DÉPLOYÉ** : le trajet du 8 juillet s'est tu — dernière ligne le 08/09 15:55,
> puis **8 passages horaires sans une seule**, après *une par passage sans exception*. ⚠️ **Sa double
> condition était invérifiable telle qu'elle avait été écrite la veille : elle est REFORMULÉE, pas
> déclarée satisfaite.** *Le correctif ne retire aucun candidat, il les exclut à la sélection — donc
> une lecture voit le vivier, et le vivier GROSSIT (17 → 20, dont 3 → 4 immortels). C'est la fuite
> lente annoncée, à la vitesse annoncée.*
>
> 🔴 **Le seul chiffre qui ment ce jour est celui de T13.** Le recalage rend **0,0 %** d'échec sur
> 24 h contre 85,5 % la veille — **mais le 07/09 lui-même est passé de 85,5 % à 1,2 % pour LES MÊMES
> trajets**, recalés *après* leur clôture par le rattrapage. La fenêtre n'a pas bougé : **le passé a
> bougé.** `trips` n'a pas d'`updatedAt`, donc rien ne distingue « bien fait tout de suite » de
> « rattrapé la nuit suivante ». **La série de dix points ne se prolonge pas**, et **T28 est ouverte**
> pour redéfinir la mesure *avant* que quiconque ne conclue sur T13.
>
> ---
>
> ✅ **LE FAIT DU 08/09 : V11 REMONTE DE `»` À ✅ FAIT, ET LA PREUVE EST VENUE EN QUATRE
> EXEMPLAIRES.** Requalifiée **vers le bas** la veille — *« la règle n° 2 vaut aussi quand elle
> dérange »* —, elle remonte aujourd'hui **sur mesure, pas sur promesse** : `LastTriggerUSec` porte
> **07/09 04 h 30 min 56 / 04 h 40 min 56 / 04 h 50 min 30 UTC**, `ExecMainExitTimestamp` est **non
> vide** sur les trois, et chacun des trois dossiers porte **deux** copies. 🔑 *Le discriminant de
> VPS-M81 s'est retourné : le 06/09 les trois démarrages tombaient à la **même seconde** — un geste ;
> le 07/09 ils tombent à **dix minutes d'intervalle**, chacun à la seconde près sur son propre
> `OnCalendar` — un mécanisme.* Et une quatrième preuve, non demandée : le journal des unités compte
> sa propre rétention, **« 1 conservée » puis « 2 conservées »**. **Le seul constat de gravité 1 du
> VPS est clos**, 46 jours après son ouverture.
>
> 🔑 **Ce que le couple 07/09 → 08/09 démontre, et qui vaut mieux que la tâche elle-même :** la
> requalification de la veille n'a pas retardé le correctif d'une heure — **le mécanisme était déjà
> bon**. Elle a seulement refusé d'appeler « prouvé » ce qui ne l'était pas encore. *Attendre
> 26 heures était le prix de cette preuve, pas un retard.*
>
> 🆕 **Deux tâches neuves ce jour** — **V27** *(VPS-040 · VPS-M91)* : le collecteur réclame une
> sauvegarde de la base de **démonstration**, ce qui coûterait **~13 Go** pour copier une base que
> le serveur **reconstruit lui-même** chaque dimanche. Et **V26 est débloquée** : le test de V11
> étant clos, plus rien n'empêche de ranger les dossiers — dont le **faux orange quotidien est
> désormais mesuré** (trois « PÉRIMÉE » à 93 h pendant que les dossiers vivants portent 21 h).

> 🖥️ **Le même état, en visuel : [`TABLEAU-DE-BORD.html`](./TABLEAU-DE-BORD.html)** — un fichier autonome, regénéré à chaque passage des deux routines quotidiennes, qui se filtre par gravité, par partie et par état. *Il ne remplace pas ce fichier-ci : il en donne l'état, jamais le pourquoi.*

### Partie I — centre d'alerte *(28 tâches)*

| | ID | Fiche | La tâche | État |
|:--:|:--:|---|---|---|
| ☐ | **T1** | TRK-071 | 🔴🔴 Recharger **au moins un** des deux comptes IA | 🤝 HUMAIN |
| ☑ | **T2** | TRK-069 | 🔵 ~~Rallumer le poste~~ — **le poste a repris SEUL le 06/09 à 06:08** | ✅ **FAIT** |
| ☐ | **T3** | TRK-066 | 🔴 Trancher les **trois questions** du coupe-circuit | 🤝 HUMAIN |
| ☐ | **T4** | TRK-072 | Calibrer les notifications d'excès de vitesse | 🤝 HUMAIN |
| ☐ | **T5** | TRK-062 | Autoriser la migration `SENT_UNCONFIRMED` | 🤝 HUMAIN |
| ☐ | **T6** | TRK-065 | Prévenir `tyger.bcn@gmail.com` *(21 notifications perdues)* | 🤝 HUMAIN |
| ☐ | **T7** | TRK-035 | Ouvrir la fenêtre de maintenance *(rôle non-superutilisateur)* | 🤝 HUMAIN |
| ☐ | **T8** | TRK-001 · 027 | 🔵 Contrôler les antennes *(3 véhicules)* | 🤝 HUMAIN |
| ☐ | **T9** | — | 🔵 Déclarer ou dépanner `GLA•KC•31` et `FG-669-DQ` | 🤝 HUMAIN |
| `»` | **T10** | TRK-070 | Le niveau de l'escalade suit la **cause**, pas la gravité | 🗓️ **DÉPLOYÉ** `2112e9ae` |
| `»` | **T11** | TRK-068 | Borner le `fetch` vers Vizyo Auth *(+ le jumeau)* | 🗓️ **DÉPLOYÉ** `c80632ba` |
| ☐ | **T12** | TRK-022 | Déduplication **générique** des alarmes du boîtier | 🔧 À CODER |
| ☐ | **T13** | TRK-016 | Recalage — **flux neuf réparé (0 %)**, mais **la mesure ne mesure plus** et 8 882 trajets d'historique restent | 🔧 CHANTIER |
| ☐ | **T14** | TRK-053 | Provoquer ou requalifier *(échéance **08/09**)* | ⛔ sans occasion |
| ☐ | **T15** | TRK-060 | Guetter : « Un point de mesure système… » | 🗓️ NON EXERCÉ |
| ☐ | **T16** | TRK-064 | **À clore ?** — le sujet a changé, la chaîne est armée | 🗓️ NON EXERCÉ |
| ☐ | **T17** | TRK-065 | Guetter la ligne hebdomadaire *(**~11/09**)* | 🗓️ NON EXERCÉ |
| ☐ | **T18** | TRK-066 | Guetter « SMS non remis au relais » *(+ motif conservé)* | 🗓️ NON EXERCÉ |
| ☐ | **T19** | TRK-032 | **REQUALIFIER** — 16 j d'attente | 🗓️ test daté |
| ☐ | **T20** | TRK-051 | Confier à un humain — 12 j, **30 s** pour qui a l'écran | 🗓️ test daté |
| ☐ | **T21** | TRK-018 | Accusé de remise de la passerelle SMS | ⛔ BLOQUÉ |
| ☐ | **T22** | TRK-014 | Rectifier son `quoiFaire` *(renvoie à TRK-012, clos)* | 🧹 dette doc |
| ☐ | **T23** | — | Créer ou déréférencer `TACHES-AMELIORATION.md` | 🧹 dette doc |
| ☑ | **T24** | TRK-073 | ✅ **La ligne au DÉPART** — *24/24 le 08/09, **dont 1 marquée `interrupted`***, la consigne écrite d'avance est tombée au mot près | ✅ **FAIT ET PROUVÉ** `dae97b03` |
| ☐ | **T25** | TRK-074 | Donner une **résolution automatique** au témoin des tâches — **3ᵉ vérif. négative**, 4 `CRITICAL` de 4 jours | 🔧 À CODER |
| `»` | **T26** | TRK-075 | Le trajet s'est tu — **8 passages sans une ligne** ; ⚠️ double condition **reformulée**, pas satisfaite | 🗓️ **DÉPLOYÉ** `dc35f1a3` |
| `»` | **T27** | TRK-076 | La carte **survit à une perte de contexte WebGL** — **0 ligne sur 48 h**, échéance 15/09 | 🗓️ **DÉPLOYÉ** `09d04e2b` |
| ☐ | **T28** | TRK-016 | 🆕 🔴 **Redéfinir la mesure du recalage** : à la clôture, sur une fenêtre **fermée** — *sans ça, T13 est indécidable* | 🔧 À CODER |

### Partie II — VPS *(28 tâches)*

| | ID | Fiche | La tâche | État |
|:--:|:--:|---|---|---|
| ☑ | **V0** | — | ✅ **Docs VPS versées sur `main`** *(06/09)* | ✅ **FAIT** |
| ☐ | **V1** | VPS-038 | 🔵 Porter les **6 IMEI** muets à l'exploitant | 🔵 PRODUIT |
| ☐ | **V2** | VPS-038 | 🔵 Sortir du parc les 6 boîtiers muets > 7 j | 🔵 PRODUIT |
| ☐ | **V3** | VPS-036 · 027 | 🔵 **Un seul ticket hébergeur** *(2 écritures root)* | 🔵 PRODUIT |
| ☐ | **V4** | VPS-010 | Planifier un redémarrage *(noyau, 6 services)* | 🔴 HUMAIN |
| ☐ | **V5** | VPS-M56 | Arbitrer le budget de collecte *(20 dépassements)* | 🟡 PRÉPARÉ |
| ☐ | **V6** | VPS-037 | Second dépositaire de la copie hors-site | 🟡 PRÉPARÉ |
| ☐ | **V7** | VPS-005 | Limites mémoire — **30 conteneurs sur 33** | 🔴 HUMAIN |
| ☐ | **V8** | VPS-020 | Séparer les projets compose `deploy` | 🔴 HUMAIN |
| ☐ | **V9** | VPS-017 | 4,5 Go d'outillage dans `/root` | 🔴 HUMAIN |
| ☐ | **V10** | VPS-018 | Retirer `/opt/vizyo-leads` | 🔴 HUMAIN |
| ☑ | **V11** | VPS-013 | ✅ **3 bases de prod sauvegardées de façon reproductible** — *les 3 minuteries ont déclenché **seules**, aux 3 horaires attendus* | ✅ **FAIT ET PROUVÉ** *(08/09)* |
| ☐ | **V12** | VPS-012 | Restreindre la clé CI `vizyo-auth` *(10 s)* | 🟡 PRÉPARÉ |
| ☐ | **V13** | VPS-015 | `ExecStart` par `bash` **+ `OnFailure=` sur `tracky-backup`** | 🟢 AUTO |
| ☐ | **V14** | VPS-033 | **Fixer l'heure** du rafraîchissement `apt` *(et non réduire son aléa)* | 🟡 PRÉPARÉ |
| ☐ | **V15** | VPS-034 | Épingler Traefik par digest *(déjà relevé)* | 🔴 HUMAIN |
| ☐ | **V16** | VPS-026 | Épingler `alpine` par empreinte *(déjà relevée)* | 🟡 PRÉPARÉ |
| ☐ | **V17** | VPS-030 | Purger 1,4 Go de copies sans rétention *(périmètre prêt)* | 🟡 PRÉPARÉ |
| ☐ | **V18** | VPS-032 | Multiplexage SSH **côté poste** | 🟢 AUTO |
| ☐ | **V19** | VPS-007 | `random_page_cost` — *déconseillé en l'état* | 🟡 PRÉPARÉ |
| ☐ | **V20** | VPS-M79 | Étiqueter les images de repli au build | ⛔ BLOQUÉ |
| ☐ | **V21** | VPS-029 | Trancher quel mécanisme gouverne le cache de build | ⛔ BLOQUÉ |
| ☐ | **V22** | VPS-M36 | Échantillonner `wchan` 3× et publier la répartition | ⛔ BLOQUÉ |
| ☐ | **V23** | VPS-M73 | Afficher l'écart en jours sur `/admin → Audit VPS` | ⛔ BLOQUÉ |
| ☑ | **V24** | VPS-038 | **Sentinelle « boîtiers muets »** — *2 lignes à 06:30, pas 10 : **exact*** | ✅ **FAIT ET PROUVÉ** |
| ☑ | **V25** | VPS-M59 | **`chargeDeFond.note` s'affiche** + repli explicite — *a survécu au rebuild du 07/09* | ✅ **FAIT ET PROUVÉ** |
| ☐ | **V26** | VPS-013 · M88 | 🔓 **DÉBLOQUÉE** — ranger les **3 dossiers abandonnés** ; le faux orange est désormais **mesuré**, pas prédit | 🟡 PRÉPARÉ |
| ☐ | **V27** | VPS-040 · M91 | 🆕 Trancher si la base de **démo** doit être sauvegardée *(le 🔴 vaut **13 Go**)* | 🔵 PRODUIT |



> ⭐ **Les deux tâches les plus rentables de tout le fichier, si vous n'en faites que deux :**
> **T1** *(recharger un compte IA — rien d'autre ne débloque quoi que ce soit, **145 h au 09/09**)*
> et **T25** *(la résolution automatique du témoin des tâches — 4 `CRITICAL` traînent depuis 4 jours
> pendant que sa jumelle archive seule, et **c'est ce genre d'écran qui finit par faire dire « videz
> tout »**)*.
>
> *T24, qui occupait cette place depuis le 06/09, est **faite et prouvée** le 09/09.* 🔑 **Et elle
> laisse une leçon de méthode plus durable que le correctif :** sa consigne d'acceptation prévoyait
> **d'avance la façon dont on aurait pu la satisfaire malhonnêtement** (« si le compte monte à 24
> sans qu'aucune ne soit marquée, on a maquillé le carnet »). *C'est ce qui sépare une preuve d'un
> chiffre qui arrange* — et c'est reproductible sur n'importe quelle autre tâche de ce fichier.
>
> *T10, qui occupait cette place hier, est **déployée**.* ⚠️ **V11 y était aussi, annoncée « faite
> et prouvée » — elle est redescendue à **déployée** le 07/09 : ses trois minuteries n'avaient
> jamais déclenché seules. Sa vérification du 08/09 est, de fait, la troisième tâche la plus
> rentable du fichier : deux minutes de lecture pour clore ou rouvrir le seul constat de gravité 1
> du VPS.*

> ⚠️ **Six fiches apparaissent deux fois, et c'est voulu** — TRK-065 en **T6** *(prévenir la
> personne)* et **T17** *(guetter la ligne)* ; TRK-066 en **T3** *(trancher la garde)* et **T18**
> *(guetter le message)* ; TRK-062 en **T5** *(autoriser)* et dans les bloquées ; TRK-035 en **T7** ;
> TRK-027 dans **T8** ; VPS-038 en **V1** et **V2**. *Une fiche n'est pas une tâche : elle peut en
> porter deux, qui ne se font ni par les mêmes mains ni au même moment.*

> 👁️ **Les relevés récurrents ne sont PAS dans ce tableau** — ils ne se cochent pas, ils se
> reprennent à chaque passage. Ils vivent dans les deux sections **« À SURVEILLER »**
> ([Partie I](#-à-surveiller--rien-à-coder-une-mesure-à-relever-à-chaque-passage) ·
> [Partie II](#-à-surveiller--rien-à-appliquer-une-mesure-à-relever-à-chaque-passage)).

---

## Récapitulatif des six derniers audits

| Date | Actives | Le fait du jour, en une ligne |
|---|---|---|
| **01/09** | 26 | Six véhicules ont perdu leur alimentation le 31/08 — **et l'écran avait promis le silence sans le tenir** : 7 alertes sur 8 écrites APRÈS la déclaration « boîtier débranché » *(🆕 TRK-052, TRK-053)* |
| **02/09** | 30 | Le parc n'a jamais été aussi bien réglé (44/44 cibles canoniques) — **mais l'écran des commandes raconte l'inverse** : 46 fois sur 46, la « cible atteinte » qui suit un échec porte une AUTRE cible *(🆕 TRK-059, TRK-060)* |
| **03/09** | 35 | **Le compte Anthropic tombe à sec**, et le dispositif classe l'incident en « appel malformé » : ni le niveau, ni l'écran « Coûts IA » ne nomment la seule action utile *(🆕 TRK-061, TRK-062)* |
| **04/09** | 44 | Premier `CRITICAL` en 12 jours : **une plaque à point médian fait répondre 500 à TOUS les exports** de 2 véhicules sur 44, depuis toujours *(🆕 TRK-063 → TRK-066)* |
| **05/09** | 65 | **Déploiement non annoncé de 17:01** : six correctifs d'un coup, deux prouvés le jour même (TRK-061, TRK-059) ; les alertes de vitesse enfin armées sur 2 sociétés sur 5 *(🆕 TRK-067, TRK-068)* |
| **07/09** | **94** | **La tâche tournait, son carnet de bord était vide, et le témoin a crié « à l'arrêt »** — 8 passages sur 24 perdus le 06/09 alors que **sept portent la preuve d'avoir tourné** *(🆕 TRK-073, TRK-074)* |
| **06/09** | **82** | **Les DEUX fournisseurs IA sont à sec en même temps** — le repli `claude → gpt` livré la veille a été exercé 6 min après sa mise en ligne et n'avait nulle part où aller *(🆕 TRK-070, TRK-071, TRK-072)* |
| **08/09** | **118** | **Un seul trajet du 8 juillet produit 15 des 17 défauts neufs** : ses positions viennent de franchir le front de purge, et trois commentaires promettent un silence que leur couche n'a pas le pouvoir d'accorder *(🆕 TRK-075, TRK-076)* |
| **09/09** | **138** | **Une preuve écrite d'avance tombe au mot près** — 24 passages sur 24 dont **1 marqué `interrupted`** *(T24 ✅)*, le trajet du 8 juillet se tait *(T26 `»`)*, et **le seul chiffre qui ment est celui du recalage : le passé a été réécrit** *(🆕 T28)* |

**Ce que la série raconte** — les actives passent de 26 à 82 en six jours, et **ce n'est pas une
dégradation de la plateforme** : **48 des 82** sont des `DEGRADATION` (Overpass, dépendance tierce
assumée), et parmi les 34 défauts, **12 lignes sont historiques et déjà closes** (TRK-067, éteinte
le 04/09) et **3 viennent d'un capteur né la veille** (TRK-069). *Un compteur qui monte parce qu'on
vient d'installer des instruments n'est pas le même compteur.*

> 🔑 **Le motif structurant de la semaine, vu quatre fois :** un correctif de message est déployé,
> **et le même défaut ressort par une chaîne voisine** — TRK-060, puis TRK-066, puis TRK-068, puis
> TRK-070. *Aucun appel sortant de ce dépôt n'a de gabarit de message d'échec ; on les corrige un
> par un, à raison d'un par jour.*

---

## L'ordre, et pourquoi c'est celui-là

Trois critères, appliqués dans cet ordre — **pas** la gravité seule :

1. **Est-ce que ça nuit MAINTENANT, en production ?**
2. **Est-ce que ça rend le dispositif AVEUGLE ?** Un instrument qui se tait pour une mauvaise raison
   coûte plus cher que le défaut qu'il devait voir : il transforme chaque passage suivant en fausse
   bonne nouvelle.
3. **Le geste est-il connu et borné ?** À nuisance égale, ce qui se corrige en une passe passe avant
   ce qui demande une décision produit ou une intervention terrain.

### Les cinq états d'une tâche

| État | Ce que ça veut dire |
|---|---|
| 🤝 **HUMAIN** | Décision produit, action terrain, ou geste hors code. Écrit ici, **jamais fait d'office**. |
| 🔧 **À CODER** | Cause racine connue, correctif spécifié, personne ne l'a écrit. |
| 🗓️ **DÉPLOYÉ, NON EXERCÉ** | En production, **mais l'occasion de le prouver n'est pas venue**. Une consigne datée attend. |
| 👁️ **SURVEILLER** | Rien à coder. Une mesure à relever à chaque passage, pour qu'une tendance devienne dicible. |
| ⛔ **BLOQUÉ** | Un prérequis manque : migration, fenêtre de maintenance, donnée non persistée. |

> ⚠️ **Le vocabulaire des statuts du référentiel n'a pas de case « déployé mais non prouvé ».**
> Il n'offre que `CORRECTIF_PROPOSE` (correctif écrit) et `CORRIGE` (livré **ET vérifié**). Quatre
> fiches vivent aujourd'hui entre les deux et restent donc marquées `CORRECTIF_PROPOSE` alors que
> leur code est **en ligne**. *C'est une limite connue du vocabulaire, pas une erreur de cotation —
> et c'est exactement ce que la colonne « état » de ce fichier sert à dire.*

---

# 🤝 CE QUI ATTEND UNE DÉCISION OU UN GESTE HUMAIN

*Rien de tout ceci ne se corrige par du code. C'est la liste la plus courte — et la plus bloquante.*

| | ID | Fiche | L'action, en une phrase | Depuis |
|:--:|:--:|---|---|---|
| ☐ | **T1** | [TRK-071](./REFERENCE-ERREURS.md#trk-071) | 🔴🔴 **Recharger au moins UN des deux comptes IA** — Anthropic **et** OpenAI sont vides | **76 h** |
| ☐ | **T2** | [TRK-069](./REFERENCE-ERREURS.md#trk-069) | 🔵 **Rallumer le poste** et lire le motif d'échec de `agent-recit-trajet` | 05/09 |
| ☐ | **T3** | [TRK-066](./REFERENCE-ERREURS.md#trk-066) | 🔴 **Trancher les trois questions du coupe-circuit** *(détail ci-dessous)* | 04/09 |
| ☐ | **T4** | [TRK-072](./REFERENCE-ERREURS.md#trk-072) | **Calibrer les notifications d'excès de vitesse** — 14/jour/super-admin, pour un produit calibré sur 2 à 3 | 06/09 |
| ☐ | **T5** | [TRK-062](./REFERENCE-ERREURS.md#trk-062) | **Autoriser la migration** `SENT_UNCONFIRMED` pour les commandes de boîtier | 03/09 |
| ☐ | **T6** | [TRK-065](./REFERENCE-ERREURS.md#trk-065) | **Prévenir `tyger.bcn@gmail.com`** — 21 notifications perdues faute d'appareil abonné | 04/09 |
| ☐ | **T7** | [TRK-035](./REFERENCE-ERREURS.md#trk-035) | **Ouvrir une fenêtre de maintenance** pour créer le rôle applicatif non-superutilisateur | 20/08 |
| ☐ | **T8** | [TRK-001](./REFERENCE-ERREURS.md#trk-001) · [TRK-027](./REFERENCE-ERREURS.md#trk-027) | 🔵 **Contrôler les antennes** de `FS-253-HR`, `FZ-862-VY`, `KSR•370` | 03/08 |
| ☐ | **T9** | *(hors fiche)* | 🔵 **Déclarer ou dépanner** `GLA•KC•31` (74 h) et `FG-669-DQ` (57 h), muets et **non déclarés** | 03/09 |

### Les trois questions du coupe-circuit (TRK-066) — à trancher, pas à deviner

Le 04/09 à 03:00, une commande moteur a échoué sur ses **DEUX** voies et **un véhicule est resté
mobile**. Le message est corrigé et déployé ; **la garde ne l'est pas, et ne doit pas l'être sans
vous** :

- **(a)** 10 s d'attente suffisent-elles sur un **dernier recours** ?
- **(b)** Faut-il un réessai, et comment le rendre **idempotent** ? *(rejouer une coupure moteur
  n'est pas anodin)*
- **(c)** Une immobilisation **demandée qui n'a pas eu lieu** mérite-t-elle `CRITICAL` plutôt
  qu'`ERROR` ?

---

# 🔧 À CODER — cause connue, correctif spécifié, personne ne l'a écrit

## P0 — nuit à la production maintenant

### `~` T10 · TRK-070 · gravité 2 · ✅ **COMMITÉ le 2026-09-06** (`2112e9ae`) — *pas encore déployé*

**Ce qui se passe** — Un compte IA à sec produit **deux** lignes à 14 ms d'intervalle : la première
en `DEGRADATION` (correctif C3 point 5 / TRK-061), la seconde en **`ERROR`** — qui la **recompte
comme un défaut**. `signalerReprise` décide son niveau sur la **gravité de la conversation**, jamais
sur la **cause** de l'escalade.

**Le geste** — Passer à `signalerReprise` un `kind` optionnel issu de `classerEchecIa` ; quand il est
renseigné, aligner le niveau sur celui de l'incident d'origine. Garder `ERROR` pour une escalade
décidée **sur le contenu** de la conversation. Traiter **tous** les chemins de `sansIaReponse` qui
suivent un `tracerErreur` — *leçon de TRK-004*.

**Pourquoi en premier** — Le geste est **borné à quelques lignes** et il referme le motif récurrent
de la semaine. Le journal système (`assistance_escalade`) doit continuer d'écrire dans les deux cas.

⚠️ **Double condition :** au prochain échec IA, **UNE** seule ligne `ASSISTANCE`, en `DEGRADATION`.
*Si les deux disparaissent, on a supprimé la trace de l'escalade au lieu de la classer.*

### `~` T11 · TRK-068 · gravité 2 · ✅ **COMMITÉ le 2026-09-06** (`c80632ba`) — *pas encore déployé*

**Ce qui se passe** — `auth-client.service.ts`, méthode `request()` : l'appel à Vizyo Auth est un
`fetch` **sans `try/catch` ni délai d'expiration**. Le rejet de transport remonte nu, NestJS en fait
un **500** là où une dépendance injoignable est un **503**, et le tout sort en `CRITICAL`.

**Le geste** — Envelopper le `fetch` : `AbortSignal.timeout()`, capture du rejet, puis
`ServiceUnavailableException` dont le message nomme **Vizyo Auth**, l'opération tentée et la
conséquence pour l'utilisateur, **motif technique conservé en fin de phrase**. Niveau `DEGRADATION`.
**Traiter le jumeau `verifyLoginCode()`**, qui appelle `fetch` en direct avec le même angle mort.

⚠️ **1 occurrence, 2 jours.** Fait mesuré, pas une tendance — mais le geste est connu et borné.

### ☐ T12 · TRK-022 · gravité 2 · 🔧 À CODER *(à clore)*

**Ce qui se passe** — Aucune déduplication **générique** des alarmes du boîtier. Le volet 1 est
**répondu** (1 317 → 1-2 par jour, plancher net à 6,16 h), mais la déduplication n'est posée **que
sur le chemin de la survitesse** — qui n'est qu'un cas parmi d'autres.

**Le geste** — Remonter la déduplication dans la fonction qui crée une alerte à partir d'une trame,
**par véhicule ET par type ET par fenêtre**. Le modèle existe déjà dix lignes plus loin (perte GPS,
24 h), avec un commentaire qui explique longuement pourquoi.

🔗 **Croisement neuf avec [TRK-072](./REFERENCE-ERREURS.md#trk-072)** : c'est ce chemin générique qui
décidera si la chaîne V5 sature à nouveau ses destinataires.

## P1 — le message ment, ou le compteur dérive

### ☐ T13 · TRK-016 · gravité 2 · 🔧 CHANTIER *(hors passe)*

**Le recalage cartographique échoue sur ~9 trajets sur 10, depuis avril.** Mesure fraîche sous les
lots V1→V9, prise le 06/09 : **87,9 %** (131 trajets sur 149).

Série ouvrée : 90,2 · 88,7 · 91,3 · 87,0 · 89,3 · 91,1 · 91,9 · 89,2 · 83,3 · **87,9**.

⚠️ **Le 83,3 % du 05/09 était une fluctuation, et la réserve écrite ce jour-là vient de
s'auto-vérifier.** Le chantier peut désormais s'ouvrir : le chiffre est frais et stable autour de
**~88 %**. Ce n'est pas une passe d'une heure — c'est un vrai sujet, à planifier.

### ☐ T14 · TRK-053 · gravité 1 · ⛔ déployé, **aucune occasion**

Correctif déployé le **01/09 à 09:17**. **Sans régression** : `alertes_depuis_declaration` = **7**,
identique aux 04, 05 et 06/09 — **3ᵉ point**. Ce qui manque est une **occasion** : les 10 véhicules
déclarés hors service sont muets, et *un correctif qui fait taire des boîtiers déjà silencieux ne
prouve rien*.

👉 **Décision proposée** : le **provoquer** au prochain retour de LLD, ou le **requalifier** le 08/09.

---

# 🗓️ DÉPLOYÉ, NON EXERCÉ — la consigne datée attend son occasion

*Ces quatre correctifs sont **en ligne**, marqueurs vérifiés sur l'**artefact servi** le 05/09.
Aucun n'a encore eu l'occasion de se prouver. **Ne pas les rouvrir ; les guetter.***

| | ID | Fiche | Ce qui le prouvera | Attendu |
|:--:|:--:|---|---|---|
| ☐ | **T15** | [TRK-060](./REFERENCE-ERREURS.md#trk-060) | Une ligne `system-metrics` commençant par « **Un point de mesure système n'a pas pu être enregistré** », et non par la pile de transport brute | au prochain incident DNS |
| ☐ | **T16** | [TRK-064](./REFERENCE-ERREURS.md#trk-064) | *Son sujet a changé* : la chaîne **est armée** sur 2 sociétés sur 5, et le silence de la sentinelle est **légitime** | — 👉 **à clore ?** |
| ☐ | **T17** | [TRK-065](./REFERENCE-ERREURS.md#trk-065) | La ligne hebdomadaire tombe de **42 à ~21**, ne cite plus `system@tracky.local`, et porte `comptesTechniquesEcartes: 1` | **~11/09** |
| ☐ | **T18** | [TRK-066](./REFERENCE-ERREURS.md#trk-066) | La ligne `sms-gateway` commence par « **SMS non remis au relais** », nomme `vizyo-texto`, **et conserve le motif technique en fin de phrase** | au prochain échec du relais |

> ⚠️ **Pour TRK-066, la vérification porte sur ce qui RESTE, pas sur ce qui disparaît.** *Si le motif
> technique s'évapore, on a nettoyé l'écran au lieu de traduire le message.*

---

# 👁️ À SURVEILLER — rien à coder, une mesure à relever à chaque passage

*C'est ce qui rend l'audit cumulatif plutôt que quotidien. **Ne pas sauter ces relevés, même quand
rien ne bouge** — c'est l'absence de mouvement qui fait la preuve.*

| Mesure | Dernière valeur | Série | Ce qu'un changement signifierait |
|---|---|---|---|
| [TRK-035](./REFERENCE-ERREURS.md#trk-035) — écart `ins − del − live` | **13 250** | **10 points** identiques | Une hausse = un `TRUNCATE` (invisible dans `n_tup_del`) |
| `temoin_arme` | **4/4 `actif = O`** | stable depuis le 21/08 | 🔴 **Moins de 4 = tous les comptes du rapport deviennent des planchers, pas des mesures** |
| [TRK-014](./REFERENCE-ERREURS.md#trk-014) — acquittements matériels | **0 sur 437** | **9 points** | Le premier acquittement réel fermerait la fiche |
| Total famille `fix_continuous` | **437** | 514 · 505 · 491 · 475 · 455 · 437 | ⚠️ **Une baisse n'est PAS une amélioration** : compter les ÉMETTEURS d'abord |
| `cadence_resume` sous le minimum | **0 sur 44** | **6 points** | TRK-057 et TRK-008 tiennent |
| [TRK-037](./REFERENCE-ERREURS.md#trk-037) — Overpass | **48 `DEGRADATION` / 0 `ERROR`** | **5 points** | Une `ERROR` = le classement a régressé |
| [TRK-072](./REFERENCE-ERREURS.md#trk-072) — `OVERSPEED`/jour | **6** *(6/6 nées d'un trajet)* | 12 · 6 — **2 points seulement** | 🔴 Un retour à trois chiffres = le déluge de TRK-022 |
| [TRK-062](./REFERENCE-ERREURS.md#trk-062) — âge des 2 commandes SMS | **110,5 h / 113,9 h** | +24 h par jour, exactement | Elles ne se fermeront **jamais** seules |
| `gps_sans_fix` | **0 ligne** | 2 jours | ⚠️ **Ce zéro n'est pas une bonne nouvelle** : les 2 boîtiers muets sont sortis du filtre **par le bas** |

---

# 🗓️ LES TESTS DATÉS EN RETARD — provoquer ou requalifier

> 🔑 **Règle du dispositif : un test en attente depuis plus de 7 jours doit être PROVOQUÉ ou
> REQUALIFIÉ.** Un correctif jamais exercé rend le **même zéro** qu'un correctif qui marche.

| | ID | Fiche | Ce qu'il faut provoquer | En attente | Décision proposée |
|:--:|:--:|---|---|---|---|
| ☐ | **T19** | [TRK-032](./REFERENCE-ERREURS.md#trk-032) | une trame `ac alarm` pendant une coupure programmée | 🔴 **16 j** | **REQUALIFIER** — 7 coupures cette semaine, toutes hors plage. Soit on la fabrique en atelier, soit on ferme la fiche en « non reproductible en exploitation ». |
| ☐ | **T20** | [TRK-051](./REFERENCE-ERREURS.md#trk-051) | mode fix : badge ambre « cible atteinte (mesurée) » | 🔴 **12 j** | **CONFIER À UN HUMAIN** — geste d'interface, impossible à provoquer en lecture seule. **30 s pour qui a l'écran.** |
| ☐ | **T14** | [TRK-053](./REFERENCE-ERREURS.md#trk-053) | une alarme sur un véhicule déclaré hors service | 6 j | Encore dans la fenêtre. **À trancher le 08/09** si aucune occasion. |

---

# ⛔ BLOQUÉ PAR UN PRÉREQUIS

| | ID | Fiche | Ce qui bloque | Le prérequis |
|:--:|:--:|---|---|---|
| ☐ | **T5** | [TRK-062](./REFERENCE-ERREURS.md#trk-062) | `SENT_UNCONFIRMED` n'existe **pas** pour les commandes de boîtier — vérifié **absent de l'artefact servi 3 fois** | Une **migration d'énumération**, donc un accord humain. Spec prête. |
| ☐ | **T8** | [TRK-027](./REFERENCE-ERREURS.md#trk-027) | Le garde-fou juste est **physique** (contact coupé), pas temporel | **L'état du contact n'est PAS persisté sur une trame sans fix.** Il faut d'abord le persister. |
| ☐ | **T7** | [TRK-035](./REFERENCE-ERREURS.md#trk-035) *(voie 1)* | Le rôle applicatif est **superutilisateur ET propriétaire** — un `REVOKE` est sans effet sur lui | Fenêtre de maintenance + répétition : *un droit oublié casse l'ingestion GPS*. |
| ☐ | **T21** | [TRK-018](./REFERENCE-ERREURS.md#trk-018) | Les 4 correctifs sont livrés et **prouvés** (313 → **0** commandes `SENT`, 307 → **0** de plus de 24 h) | Reste : **la passerelle SMS n'expose aucun accusé de remise**. Même sujet que TRK-026 et TRK-062. |

---

# PARTIE II — VPS de production : 25 constats confirmés et non corrigés

> **Source** : les **124 fiches** de `docs/vps-audit/REFERENCE-CONSTATS.md`, dont **25 ouvertes** au
> 2026-09-06. **87 sont `APPLIQUE`** (corrigées et vérifiées) et **12 `ACCEPTE`** — dont 6 réfutées
> par la mesure et 6 assumées par écrit. *Aucune tâche ne se cache dans ces 99 : elles ont été
> relues une par une pour construire cette liste.*
>
> ✅ **Le référentiel VPS est sur `main` depuis le 2026-09-06** — 29 rapports, 631 Ko, 125 fiches.
> Il s'y arrêtait au **17/08** (289 Ko) et ne contenait **aucune** des fiches **VPS-030 à VPS-039**,
> *les deux gravités 1 comprises* : elles ne vivaient que sur `perf/garde-fou-tests-et-workers`.
> *C'était le mode d'échec des « six rapports jamais commités » du 11/08 sous une forme neuve —
> cette fois ils étaient commités, mais sur une branche que personne ne fusionnait.*
> Les fiches sont donc désormais consultables : [`REFERENCE-CONSTATS.md`](../vps-audit/REFERENCE-CONSTATS.md).

## Récapitulatif des huit derniers passages VPS

| Date | Disque | RAM | Collecte | Émetteurs | Le fait du jour, en une ligne |
|---|---:|---:|---:|---:|---|
| **25/08** | 53 % | 33 % | 142 s | — | Passe de correction : TRK-046/048/047 déployés |
| **26/08** | 54 % | 33 % | 137 s | 38 | Dernier passage avant **cinq jours manqués** *(VPS-M73)* |
| **01/09** | 53 % | 35 % | 138 s | 38 | *« La flotte est intacte, 15ᵉ jour sans perte »* — **écrit 18 h APRÈS l'arrêt des six** |
| **02/09** | 54 % | 35 % | 120 s | **32** | **Six boîtiers se sont tus le 31/08 en deux heures**, tous dans la même flotte *(🆕 VPS-038)* |
| **03/09** | 53 % | 38 % | 126 s | 32 | Seuil de réescalade écrit d'avance, échéance au 05/09 |
| **04/09** | 53 % | 33 % | 96 s | 31 | `vizyo-auth` reçoit une vraie unité de sauvegarde — **le créneau exact que le plan recommandait** |
| **05/09** | 53 % | 32 % | 133 s | 30 | **VPS-038 passe en gravité 1** ; trois bases vertes sur un **dump manuel** *(🆕 VPS-M80/M81)* |
| **06/09** | 53 % | 35 % | 116 s | **30** | **Premier passage sans perte nouvelle** ; deux blocs de la même section se contredisaient *(🆕 VPS-M84/M85)* |

**Ce que la série raconte** — **la machine va bien et n'a jamais mal été** : 33/33 conteneurs sur
les huit passages, **0 OOM en 30 jours**, PSI `full` à 0,00, disque **stable à 53 %** avec 46 Go
libres, production en 99 · 102 · 47 · 118 ms. *Le VPS n'est pas le sujet ; ce qui vit dessus l'est.*

> 🔑 **Le motif structurant, vu quatre fois en six jours :** un contrôle rend **vert** sur une
> grandeur qui ne répond pas à la question posée. **VPS-M81** (l'âge d'un fichier ne distingue pas
> un mécanisme d'un geste), **VPS-M80** (un dénominateur calculé par le filtre défaillant),
> **VPS-M84** (deux seuils contradictoires dans la même section), **VPS-M85** (une réfutation menée
> avec la mauvaise grandeur). *Trois de ces quatre verts portaient sur le seul constat de gravité 1
> encore ouvert.*

## Les classes d'exécution VPS — qui a le droit de faire quoi

*Reprises telles quelles de `docs/vps-audit/ROADMAP.md` — **retiré le 06/09** — pour ne pas créer un
troisième vocabulaire. Ce sont désormais les seules classes d'exécution VPS.*

| Classe | Sens | Qui exécute |
|:--:|---|---|
| 🟢 **AUTO** | Additif, réversible, vérifiable immédiatement, **aucun impact production**. | Un agent, seul, **et il prouve le résultat**. |
| 🟡 **PRÉPARÉ** | La commande est écrite et mesurée, **l'application demande un arbitrage**. | Humain, après lecture. |
| 🔴 **HUMAIN** | **Destructif ou interrompt la production.** Jamais exécuté par un agent. | Humain, exclusivement. |
| 🔵 **PRODUIT** | Ce n'est pas une action sur le VPS. | Exploitant / équipe produit. |

> ⚠️ **Un agent qui a le droit de `prune` a le droit de se tromper de `prune`.** VPS-002 a établi
> qu'on perd une machine en coupant un accès avant d'avoir prouvé le suivant ; VPS-009, qu'une
> commande de nettoyage ne distingue pas un cache d'une base de données.

---

## ✅ V0 — FAIT le 2026-09-06 : les docs VPS sont sur `main`

**Vingt jours d'audit — 15 rapports, 10 fiches neuves, les deux gravités 1 — n'existaient pas sur
`main`.** Le montage `/opt/tracky-vps-audit` masquait le problème en production tant qu'il tenait :
l'écran `/admin → Audit VPS` lit le dossier monté, pas le dépôt. *Le jour où le montage aurait
sauté, l'écran aurait affiché une documentation du 17/08 sans rien signaler.*

**Ce qui a été fait** — le seul chemin `docs/vps-audit/` a été versé sur `main`
(`git checkout perf/garde-fou-tests-et-workers -- docs/vps-audit/`), **avec son historique**, et
non recopié à la main. Arborescences vérifiées identiques, rien d'autre n'a été importé.
**La branche `perf/garde-fou-tests-et-workers` est conservée** : elle porte encore 49 commits
uniques, dont du **code** (`scripts/guard-dev-servers.mjs`, le correctif VPS-M59 de
`admin-vps.component.ts`, `package.json`). *Une fusion complète est une décision ; un `checkout` de
chemin n'en est pas une.*

⚠️ **Ce qu'il RESTE à décider sur cette branche** — sa fusion entre en **conflit sur 4 fichiers** :
`admin-vps.component.ts`, `REFERENCE-ERREURS.md`, **`ROADMAP-CORRECTIFS.md`** (add/add) et
`app/wiki.json`. Les trois derniers sont les documents les plus édités du dépôt, et sa version
date du **21/08**. *Fusionner cette branche telle quelle écraserait la roadmap que vous lisez.*

---

## 🤝 CE QUI ATTEND UNE DÉCISION OU UN GESTE HUMAIN — *10 tâches*

*Rien de tout ceci ne se corrige par une commande. C'est la liste la plus bloquante.*

| | ID | Fiche | G | L'action, en une phrase | Classe | Depuis |
|:--:|:--:|---|:-:|---|:--:|---|
| ☐ | **V1** | VPS-038 | **1** | 🔵 **Porter les 6 IMEI de la flotte `2ad69ac1…` à l'exploitant** — muets depuis **5,6 jours**, avec l'heure de leur dernière trame | 🔵 PRODUIT | 31/08 |
| ☐ | **V2** | VPS-038 | **1** | 🔵 **Sortir du parc les 6 boîtiers muets depuis > 7 j**, dont **3 sans aucun véhicule** (7,3 · 66,8 · 92,7 j) — un statut, **pas** un `DELETE` | 🔵 PRODUIT | 04/09 |
| ☐ | **V3** | VPS-036 · VPS-027 | 2 | 🔵 **Un seul ticket hébergeur** couvrant les deux ordres d'écriture root (`kill -KILL` du 28/08, `systemctl mask` du 01/09) : paternité, cadence, **puis la liste de ce que ce canal s'autorise sans préavis** | 🔵 PRODUIT | 28/08 |
| ☐ | **V4** | VPS-010 | 2 | **Planifier un redémarrage** vers 23 h 30 — noyau actif `6.8.0-136`, **trois** installés (`-137`, `-138`, `-139`), 6 services sur une bibliothèque remplacée dont `docker.service` | 🔴 HUMAIN | 04/08 |
| ☐ | **V5** | VPS-M56 | 2 | **Arbitrer le budget de collecte** — dépassé **20 fois**, 116 s pour 90. Trois réponses chiffrées, aucune n'est technique *(détail ci-dessous)* | 🟡 PRÉPARÉ | 04/08 |
| ☐ | **V6** | VPS-037 | 3 | **Donner un second dépositaire à la copie hors-site** — dépositaire unique, **le même poste que la planification de l'audit** | 🟡 PRÉPARÉ | 01/09 |
| ☐ | **V7** | VPS-005 | 2 | **Poser les limites mémoire** sur les 30 conteneurs sur 33 qui n'en ont pas (**0 sur 33** ont une limite CPU) | 🔴 HUMAIN | 04/08 |
| ☐ | **V8** | VPS-020 | 2 | **Séparer les projets compose** `deploy` — 7 conteneurs, **2 applications sans rapport** (4 Maestroo dev + 3 Vizyo Manager **prod**), confirmé ce jour | 🔴 HUMAIN | 08/08 |
| ☐ | **V9** | VPS-017 | 3 | **Trancher pourquoi 4,5 Go d'outillage de développement** vivent dans `/root` d'un serveur qui porte **sept bases de production** | 🔴 HUMAIN | 06/08 |
| ☐ | **V10** | VPS-018 | 4 | **Retirer `/opt/vizyo-leads`** — pile supprimée le 04/08, dépôt distant vérifié, **10,3 % du parcours nocturne** de l'audit | 🔴 HUMAIN | 12/08 |

### Les trois réponses au budget de collecte (V5 / VPS-M56) — à arbitrer, pas à deviner

Vingt dépassements sur vingt et un passages. **Recommandation de l'agent, non appliquée :
recalibrer à 120 s ET borner `/opt` à 25 s.**

- **(a) Alléger** — le seul gisement est `/opt` (36 s). Mais le réduire, c'est **perdre la mesure
  par sous-dossier** qui justifie VPS-018 et qui a chiffré à 10,3 % ce qu'on croyait valoir 25 %.
- **(b) Recalibrer** — assumer que 90 s décrivait la machine du 04/08, qui portait moins de code.
  ⚠️ *Un budget relevé dès qu'il gêne ne borne plus rien.*
- **(c) Ne rien faire** — le dépassement reste un symptôme lisible.

⚠️ **À ne pas faire** : relever le budget **en silence**. Un budget modifié sans que le rapport le
dise transforme un dépassement en conformité sans que rien n'ait changé.

---

## 🔧 À APPLIQUER — geste serveur borné, commande écrite, personne ne l'a lancée — *9 tâches*

### ☑ V11 · VPS-013 · gravité 1 · ✅ **FAIT ET PROUVÉ le 2026-09-06** — *trois unités systemd, exercées et confrontées à la base vivante*

**Ce qui se passe** — **29ᵉ passage.** Trois bases de **production** n'ont aucune sauvegarde
qu'un mécanisme reproduise : `vizyo-manager` (abonnements Stripe, factures, clients),
`texto-postgres` (passerelle SMS : `messages`, `allowlist_entries`) et `capcom6-mysql` (relais SMS).

Le dump du 04/09 à **04:52:04** — *la même seconde pour les trois* — les a fait passer au vert.
**Rien ne le rejouera** : aucun timer, aucun cron, aucun script. `vizyo-manager` : salve
précédente à **142 jours** ; `texto` et `capcom6` : **une seule copie chacun**.

> ✅ **ET SON AUTEUR EST CONNU — c'est l'agent d'audit lui-même, et il l'avait écrit.** Le journal
> d'exécution du 04/09 (tâche T1, dans le `ROADMAP.md` retiré ce jour) porte les trois archives,
> leur taille, leur vérification d'intégrité **et** leur confrontation à la base vivante
> (`allowlist_entries` : 47 en base = 47 dans le dump). Il y écrivait déjà, mot pour mot :
> *« c'est une copie ponctuelle. Aucun timer n'a été posé, donc ces trois bases seront de nouveau
> périmées demain. La fiche reste `A_TRAITER`. »*
>
> 🔑 **Les audits des 05 et 06/09 ont consacré un chapitre entier à chercher qui avait fait ce
> dump — la réponse était dans un fichier de leur propre dossier, avec la mise en garde qui allait
> avec.** *VPS-M81 n'a rien découvert de faux ; il a redécouvert, à grands frais, ce qui était déjà
> écrit.* C'est la raison pour laquelle le contenu de ce journal est versé ici plutôt que supprimé.

**Le geste** — dériver une unité systemd par base, **sur un gabarit qui existe déjà sur la machine
et qui a fait ses preuves** : `vizyo-auth-backup.timer`, posé le 04/09, **s'est déclenché seul deux
fois** (05/09 04:01:41, 06/09 04:04:10, `systemd[1]: Starting` au journal), rétention 30 j active.

```bash
systemctl cat vizyo-auth-backup.timer vizyo-auth-backup.service   # le gabarit a copier
```

**Coût mesuré** : **~17,8 Mo/jour** avant compression, sur **46 Go libres**.

⚠️ **Créneaux PRIS** : 03 h 00 (`tracky-backup`), 03 h 30 (`vizyo-verify-backup`), 04 h 00
(`vizyo-auth-backup`). **04 h 30 est libre.**
⚠️ **Ne PAS remettre un cron** : VPS-003 — deux planificateurs pour la même sauvegarde, deux
`pg_dump` concurrents à 3 h du matin — est né exactement de là.
⚠️ **Sauvegarder `vizyo-manager` AVANT** de toucher au projet compose (V8) : sa base est dans le
projet `deploy`, et `docker compose down --remove-orphans` la supprimerait.

### ☐ V12 · VPS-012 · gravité 2 · 🟡 PRÉPARÉ — *10 secondes*

**Ce qui se passe** — `github-actions-vizyo-auth` a un accès **root complet sans aucune option de
restriction**, et elle sert : **0 → 12 → 16 → 16** connexions sur quatre passages. Elle déploie
l'authentification de **toutes** les applications de la machine.

**Le geste** — poser les mêmes options que sur l'autre clé de CI (`no-port-forwarding`,
`no-agent-forwarding`, `no-X11-forwarding`, `no-user-rc`). **Geste déjà prouvé sans effet de bord
le 04/08.**

```bash
grep -n 'github-actions-vizyo-auth' /root/.ssh/authorized_keys   # relever la ligne AVANT
```

⚠️ **Ne PAS retirer la clé** : `connexions=0` sur une fenêtre de 7 jours ne veut pas dire
« inutilisée », mais « elle n'a pas servi ces sept jours-là ».
⚠️ **Ne PAS poser `command="…"`** : mesuré et écarté le 04/08 — casse les workflows multi-lignes.
⚠️ **Et ne PAS lire la baisse de `vizyo-vps-hostinger` (10 442 → 9 127) comme une accalmie** : c'est
une **fenêtre glissante de 7 jours** qui a laissé sortir une journée de déploiements.

### ☐ V13 · VPS-015 · gravité 2 · 🟢 AUTO — *le symptôme est fermé par accident, la cause est intacte*

**Ce qui se passe** — le déclenchement de la sauvegarde Verify dépend du **bit d'exécution** du
script. Le prochain `scp -r` sans `-p` le retirera, comme le 05/08.

**Le geste** — `ExecStart=/bin/bash /opt/vizyo-verify/deploy/vps/backup.sh`, pour que le bit cesse
d'être une condition de survie de la sauvegarde.

> 🔴 **LE PÉRIMÈTRE A DOUBLÉ LE 04/09, ET LE COLLECTEUR NE LE VOIT TOUJOURS PAS.** La même question,
> posée pour la première fois à `tracky-backup`, rend le même résultat :
>
> ```
> ExecStart=/opt/vizyo-tracky/deploy/vps/backup-db.sh     ← le script EN DIRECT
> OnFailure=                                              ← ABSENT
> ```
>
> **C'est la sauvegarde de `tracky_prod` — 5,7 Go, 41 copies, la base de production principale — et
> son échec n'alerte personne.** Le constat ne visait Vizyo Verify que parce que **personne n'avait
> posé la question à l'autre unité**. **Délai de détection d'un échec : ~23 h par construction, pour
> les DEUX sauvegardes.**
>
> *Piste concrète et gratuite* : le bloc « L'unité qui PRODUIT chaque sauvegarde a-t-elle réussi ? »
> lit déjà chaque unité. Lui faire afficher `OnFailure=` présent/absent coûte **un
> `systemctl show -p OnFailure` par unité** — quatre appels, aucune E/S disque.

### ☐ V14 · VPS-033 · gravité 2 · 🟡 PRÉPARÉ — *5 min*

**Ce qui se passe** — la mesure des correctifs de sécurité est perdue **4 passages sur 5** parce que
sa source est rafraîchie **à une heure tirée au hasard** dans une fenêtre de 12 h. Le 06/09 est la
**première mesure valide depuis onze passages**, et par chance.

```bash
systemctl edit apt-daily.timer   # [Timer] / RandomizedDelaySec=30m
```

⚠️ **Contrepartie réelle** : le délai aléatoire étale la charge sur les miroirs Ubuntu. Le réduire
sur **une** machine est sans effet mesurable ; le généraliser ne le serait pas. **Préférer `30m` à `0`.**

### ☐ V15 · VPS-034 · gravité 2 · 🔴 HUMAIN — *moitié gratuite*

**Ce qui se passe** — `foodsqan-traefik` tient `0.0.0.0:80` et `:443`, sert **25 domaines**, monte
`/run/docker.sock` (« lecture seule » — **ce qui ne restreint rien** : qui atteint la socket pilote
le démon), tourne sur l'étiquette flottante `traefik:latest` et **n'a aucune sonde de santé**.

**✅ Le digest est DÉJÀ relevé — relevé le 04/09, ne pas le re-préparer :**

```
traefik@sha256:82d3d16dde0474a51fef00b28de143d48b67f7a27453224d5e7b5aaefff26a97
```

```bash
docker inspect foodsqan-traefik --format '{{.Image}}'   # verifier qu il n a PAS change
```

⚠️ **L'ORDRE COMPTE** : relever le digest **avant** toute recréation, sinon on épingle la version
qui vient d'arriver au lieu de celle qu'on a validée.
🔑 **Et si ce digest a changé depuis le 04/09 sans qu'on ait rien fait, ce n'est pas un détail :
c'est que l'étiquette flottante a bougé sous la production — la première preuve directe que le
risque décrit par VPS-034 se réalise.**
⚠️ **Ne PAS retirer le montage** : Traefik perdrait la découverte de routes et **les 25 domaines
tomberaient**.
⚠️ **Ne PAS traiter ceci comme une urgence** : aucune intrusion constatée, 23 échecs SSH sur 7 j,
**0 sur `root`**, 0 IP bannie.

### ☐ V16 · VPS-026 · gravité 3 · 🟡 PRÉPARÉ

**Ce qui se passe** — la sauvegarde des **pièces d'identité** de Vizyo Verify télécharge
`alpine:latest` depuis Docker Hub pour s'exécuter, parce que le ménage de 00 h 40 vient de la
supprimer. **18ᵉ prédiction juste** : l'image a été tirée le 05/09 à 03:32, elle avait plus de 24 h
cette nuit, elle sera retéléchargée.

**Le geste** — épingler `alpine` **par empreinte** et la pré-tirer **hors** de la fenêtre de
sauvegarde ; ou vérifier si le `tar` + `gpg` a réellement besoin d'un conteneur.

**✅ L'empreinte ET les lignes à modifier sont DÉJÀ relevées — 04/09 :**

```
alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
→ lignes 163 et 165 de /opt/vizyo-verify/deploy/vps/backup.sh
```

### ☐ V17 · VPS-030 · gravité 3 · 🟡 PRÉPARÉ

**1,70 Go en 13 fichiers**, sous **aucune** rétention (1 679 Mo dans `/root/backups`, 57 Mo dans
`/opt/backups/tracky`). Ce sont des copies **supplémentaires** d'une base qui en a 40 ailleurs.

```bash
ls -1t /root/backups/tracky-avant-graphiques-*.sql.gz | tail -n +2   # liste, n efface rien
```

**✅ Le périmètre exact est DÉJÀ relevé — 04/09 : 10 fichiers, 1,4 Go**, en conservant
`tracky-avant-graphiques-20260819-030105.sql.gz`. *Ne pas re-préparer.*

⚠️ **Ne PAS `rm -rf /root/backups`** : le dossier porte aussi les **seules copies connues** d'un
état de la base Maestroo de développement — et elles pèsent 0,46 Mo.
⚠️ **Ne PAS toucher** à `/opt/backups/tracky/positions-avant-purge60j-*` : 57 Mo, **seule trace**
des lignes purgées le 21/07.

### ☐ V18 · VPS-032 · gravité 3 · 🟢 AUTO — *côté POSTE, pas côté serveur*

**9 143 sessions SSH** sur 7 jours, pic **4 528** en une journée. Multiplexer **côté poste** :

```
Host 72.62.26.240
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

**Risque nul pour le VPS** : aucun paquet, aucune configuration serveur, le seul effet côté serveur
est **moins de travail**. ⚠️ **Contrepartie** : un socket de contrôle vit 10 min sur le poste ; qui a
accès au compte local pendant ce temps réutilise la connexion **sans la clé**.
⚠️ **Ne RIEN borner côté serveur** (`MaxStartups`, `ClientAliveInterval`) : ça transformerait une
inefficacité en **panne intermittente** le jour où on en aura légitimement besoin.

### ☐ V19 · VPS-007 · gravité 4 · 🟡 PRÉPARÉ — *déconseillé en l'état*

`random_page_cost = 4` sur **6 bases sur 7** (seule `tracky-postgres` est à 1.1). ⚠️ **L'enjeu de
performance est nul** — ces bases pèsent 8 à 28 Mo et tiennent en cache à 99,99 % : *le planificateur
ne peut pas se tromper de façon mesurable sur une table qui n'a aucune page à aller chercher.*
**L'enjeu est de méthode**, et il est déjà réglé (le dénominateur est honnête depuis VPS-M80).

---

## 🗓️ À DÉPLOYER — écrit, testé, jamais mis en ligne

*Les deux entrées de cette section ont été **déployées le 2026-09-06 à 05 h 30 UTC**. Conservées avec
leur preuve : c'est ce qui distingue « livré » de « livré ET vérifié ».*

| Quoi | État | Preuve |
|---|---|---|
| ✅ **Sentinelle « boîtiers muets » (VPS-038)** — une ligne par société quand des boîtiers rattachés se taisent > 3 j | **DÉPLOYÉE** (`fb0642f8`). 48 tests verts, mutation du seuil → 1 échec exactement. **Smoke-boot** avant bascule : *« Nest application successfully started »*. | `tracky-api` : `restarts=0`, `healthy`, `/api/health` base connectée, **port 5023 ouvert**. Sentinelle présente dans le conteneur qui tourne. ⏳ **Elle parlera à la passe de 06:30 UTC** — attendu : **2 lignes** (`2ad69ac1…` 8 boîtiers, `88627f81…` 2), **pas 10** |
| ✅ **VPS-M59** — `chargeDeFond.note` s'affiche, **et un repli explicite** sur `/admin/vps` | **DÉPLOYÉ** (`9dce59ec`). `ng build` **NG_EXIT=0**. ⚠️ Le cherry-pick de `e803e5f6` conflictait : **`main` portait déjà la garde** — seuls le rendu de la note, la branche `@else` et le style manquaient, écrits avec les **jetons** de `main` et non les hexadécimaux de la branche | Sur l'**artefact servi** : `fond-note` **0 → 1 fichier**, *« mesure absente du manifeste »* **0 → 1**, témoin impossible **0**. `restarts=0` |

> 🔑 **La mesure qui a validé ces deux lignes avait d'abord été fausse.** Un premier contrôle du
> bundle rendait *« 397 fichiers contiennent la note »* — `grep -rlc` combine deux options
> contradictoires, et 397 était le **nombre total de fichiers du bundle**. *Un contrôle de
> déploiement doit porter un témoin impossible ; sans lui, on ne distingue pas « ça a marché » de
> « mon grep compte autre chose ».*

> 🔴 **VPS-M59 corrige un défaut plus grave que celui qu'il visait, et il faut le dire.** En ouvrant
> le gabarit, le passage du 04/09 a trouvé que **la garde que tout le monde croyait posée n'existait
> pas** : `@if (idx.previsions; as p)` était la seule, et `p.chargeDeFond.…` était lu **sans
> garde**. Un passage d'audit qui n'écrirait pas cette clé ferait retomber **toute la carte
> « Prévisions », tableau du disque compris** — c'est-à-dire **TRK-033 à l'identique**. Le service
> API sert le JSON **brut, sans validation** : *le type TypeScript est une promesse que le
> compilateur n'a aucun moyen de tenir.*
>
> ⚠️ **Et ce correctif a été reporté 11 fois comme « hors de portée de l'agent — code applicatif ».
> Il ne l'était pas.** Le rapport d'audit du 06/09 le listait encore comme angle mort ouvert, **deux
> jours après qu'il eut été écrit et compilé** — parce que personne n'avait lu le journal du 04/09.

---

## 👁️ À SURVEILLER — rien à appliquer, une mesure à relever à chaque passage

| Mesure | Dernière valeur | Série | Ce qu'un changement signifierait |
|---|---|---|---|
| **VPS-038** — émetteurs distincts / 24 h | **30** | 39 · 39 · 38 · 38 · 32 · 32 · 32 · 30 · **30** | 🔴 Redescend en gravité 2 à **32 sur une journée complète**, en `SURVEILLANCE` à **38**. ⚠️ *Un compteur qui arrête de descendre n'est pas un compteur qui remonte* |
| **VPS-038** — registre, par **bande** | 6-24 h : 0 · 1-3 j : 1 · 3-7 j : 7 · > 7 j : 6 | total stable à **14** | ⚠️ **Ne JAMAIS comparer les totaux** (VPS-M78) : le 06/09, le total est identique et **un boîtier a changé de bande** |
| **VPS-011** — invocations de sondes | **65/min** (~93 600/j) | 24 conteneurs sondés **sur 33** | 9 sans aucune sonde, dont `foodsqan-traefik` qui tient 80/443 |
| **VPS-035** — trames/h/boîtier | **102,5** | bande 60–300 | ⚠️ **Un seuil par tête ne voit pas une flotte qui rétrécit** — croiser avec VPS-038 |
| **VPS-005** — conteneurs sans limite mémoire | **30 / 33** | **0 OOM en 30 j**, PSI `full` 0,00 | Pas d'urgence ; le jour où il y aura une OOM, **le choix de la victime ne nous appartiendra pas** |
| Disque | **53 %**, 46 Go libres | stable sur 8 passages | Cache de build 10,1 Go, borné par le ramasse-miettes de BuildKit |

---

## ⛔ VPS — BLOQUÉ PAR UN PRÉREQUIS

| | ID | Fiche | Ce qui bloque | Le prérequis |
|:--:|:--:|---|---|---|
| ☐ | **V20** | **VPS-M79** | Le ménage de 00 h 40 est mesuré **en volume** (6 images retirées en 24 h) mais reste **muet sur l'identité** — le cron fait `> /dev/null 2>&1` | Étiqueter les images de repli **au build** (`label!=repli=1`), donc toucher aux Dockerfile |
| ☐ | **V21** | **VPS-029** | Volet symptôme appliqué (filtre `unused-for=168h` remis le 20/08, **toujours en place** ce jour) ; **deux** mécanismes gouvernent toujours le cache de build | Décider lequel fait foi — `daemon.json` (permanent, autorégulé) ou le cron hebdomadaire |
| ☐ | **V22** | **VPS-M36** | Le `wchan` sert de preuve sur le constat le plus lourd, et le collecteur n'en prend **qu'un échantillon** | Échantillonner 3× à 1 s d'intervalle et publier la **répartition** — coût à chiffrer sur une collecte déjà hors budget |
| ☐ | **V23** | **VPS-M73** | Aucun écran ne dit **depuis combien de jours** le dernier passage remonte — cinq passages manqués (27→31/08) n'ont été vus qu'après coup | Code applicatif : afficher l'écart en jours sur `/admin → Audit VPS`. *La donnée est déjà là.* |

---

## 🧹 Dette de documentation relevée le 06/09

*Deux incohérences trouvées en construisant cette roadmap. Elles ne coûtent rien aujourd'hui, et
feront perdre une heure le jour où quelqu'un les suivra.*

1. **L'action de [TRK-014](./REFERENCE-ERREURS.md#trk-014) renvoie vers un correctif déjà livré.**
   Elle dit *« le correctif de TRK-012 reste en attente d'accord ; c'est lui qu'il faut livrer »* —
   or **TRK-012 est `CORRIGÉ` depuis le 25/08**. Le résidu de TRK-014 est désormais **une mesure**
   (0 acquittement sur 437), pas une tâche à livrer.
   👉 **Rectifier le `quoiFaire` de TRK-014.**
2. **`TACHES-AMELIORATION.md` est référencé mais n'existe pas.** L'en-tête de la roadmap précédente y
   renvoyait pour la dette d'architecture (clés `AM-NNN`) ; le fichier est **absent du dépôt**.
   👉 **Le créer, ou retirer la référence** — *un renvoi vers un fichier fantôme est pire que pas de
   renvoi.*
3. ✅ **`docs/vps-audit/ROADMAP.md` — RETIRÉ le 06/09.** Il datait du 04/09 et son tableau de
   synthèse annonçait **VPS-013 « ✅ FAIT »** (la fiche est `A_TRAITER` au 29ᵉ passage) et
   **VPS-038 en gravité 2** (elle est passée en **gravité 1** le 05/09). **Cette roadmap-ci fait
   désormais foi, seule.**
   👉 **Son contenu non obsolète a été versé ici avant suppression**, et il ne l'était pas qu'un
   peu : le **journal d'exécution du 04/09** (l'auteur du dump que VPS-M81 cherchait), les
   **quatre jeux de valeurs préparées** (digests Traefik et Alpine, périmètre exact des 1,4 Go,
   dépôt distant de `vizyo-leads` vérifié), l'**élargissement de VPS-015 à `tracky-backup`**, et le
   fait que **VPS-M59 est corrigé et compilé depuis le 04/09, mais jamais déployé**.
   ⚠️ **La copie de ce fichier survit sur `perf/garde-fou-tests-et-workers`.** Une fusion future de
   cette branche la ferait revenir. *Le retirer sur `main` ne suffit pas à le faire disparaître —
   c'est à savoir au moment de traiter cette branche.*
4. 🆕 **La Partie II est un instantané DÉRIVÉ, pas une source.** Elle a été construite le 06/09 à
   partir des 124 fiches du référentiel VPS. **Le référentiel dit *pourquoi*, ce fichier dit *quoi
   faire*** — même règle que pour la Partie I. *Si les deux se contredisent un jour, c'est le
   référentiel qui a raison, et c'est cette ligne-ci qui aura échoué.*

---

## Ce que cette refonte a appris

> 🔑 **Un compteur qui monte parce qu'on installe des instruments n'est pas le même compteur.**
> Les actives passent de 26 à 82 en six jours et les `CRITICAL` de 2 à 5 — mais 48 des 82 sont des
> dégradations assumées, 12 sont historiques et closes, et 3 viennent d'un capteur né la veille.
> *Lire un total sans lire sa composition fabrique une alarme sur une amélioration.*

> 🔑 **Le même défaut de message a été corrigé quatre fois, sur quatre chaînes différentes**
> (TRK-060, TRK-066, TRK-068, TRK-070) — un par jour, chacun découvert après coup. **Aucun appel
> sortant de ce dépôt n'a de gabarit de message d'échec.** Le vrai correctif n'est pas le cinquième
> message : c'est un **gabarit commun** que tout appel sortant devrait traverser — *nommer la
> dépendance, l'opération, la conséquence, et garder le motif technique en fin de phrase.*

> 🔑 **Un mécanisme de secours ne vaut que par la ressource qu'il vise.** Le repli `claude → gpt` est
> déployé, correct, testé — et parfaitement inutile parce que le second compte est vide lui aussi.
> *Livrer une redondance sans provisionner sa cible, c'est livrer une ligne de journal.*

## Ce que le rapprochement des deux dispositifs a appris — 06/09

> 🔑 **Les deux instruments souffrent du MÊME défaut, découvert indépendamment.** Côté centre
> d'alerte : *« aucun appel sortant de ce dépôt n'a de gabarit de message d'échec »* — quatre
> correctifs, quatre chaînes, un par jour. Côté VPS : *quatre contrôles rendaient **vert** sur une
> grandeur qui ne répondait pas à la question posée* (VPS-M80, M81, M84, M85). **Dans les deux cas,
> ce n'est pas le défaut qui se répète, c'est l'absence d'un gabarit commun** — de message d'un
> côté, de vérification de l'autre.

> 🔑 **La liste la plus courte est celle qui bloque.** Sur 25 constats VPS ouverts, **9 se
> corrigent par une commande écrite d'avance**, dont le plus rentable — trois unités systemd pour
> trois bases de production sans filet — coûte **20 minutes et 17,8 Mo par jour**. Les **10 autres
> attendent une décision humaine depuis 15 à 33 jours.** *Ce n'est pas un problème de capacité
> technique, et aucune passe de correction ne le résoudra.*

> 🔑 **Un catalogue qui vieillit ment plus vite qu'un référentiel — mais c'est son RÉSUMÉ qui ment,
> pas son détail.** `docs/vps-audit/ROADMAP.md`, retiré ce jour, annonçait **VPS-013 « ✅ FAIT »**
> dans son tableau de synthèse — alors que sa propre section détaillée disait l'inverse, en toutes
> lettres : *« copie ponctuelle, aucun timer, la fiche reste `A_TRAITER` »*. **Le fichier n'était
> pas faux : sa ligne de résumé l'était.** *C'est VPS-M84 sous une autre forme — deux endroits du
> même document répondent à la même question et ne disent pas la même chose, et c'est la version
> rassurante qu'on lit.*

> 🔑 **La note de passation la mieux écrite ne vaut rien si le passage suivant ne l'ouvre pas.**
> `ROADMAP.md` se terminait par une section **« POUR L'AGENT D'AUDIT DE DEMAIN »** qui répondait
> d'avance à quatre questions : qui avait fait le dump du 04/09, que `VPS-M59` était corrigé mais
> non déployé, que `tracky-backup` n'avait pas d'`OnFailure=` non plus, et que quatre tâches
> étaient déjà préparées avec leurs digests. **Les passages du 05 et du 06/09 ne l'ont pas lue.**
> Résultat : un chapitre entier réécrit pour retrouver une réponse déjà écrite (VPS-M81), et un
> angle mort republié comme ouvert alors qu'il était corrigé depuis deux jours (VPS-M59, 11ᵉ
> report).
> *La procédure d'audit impose de relire le dernier rapport et le référentiel. **Elle n'a jamais
> imposé de relire la roadmap** — et c'est exactement là que vivait la passation.* 👉 **C'est le
> premier argument pour n'avoir qu'UNE roadmap, et c'est pourquoi elle est ici.**

---

# 🧾 Journal d'avancement

> **Ajouté le 2026-09-06, sur décision du propriétaire : « on suit ce fichier, et on coche au fur
> et à mesure ».** Une ligne par tâche close, **en tête**, jamais retirée. C'est ici qu'on répond à
> « qu'est-ce qui a été fait, quand, et qu'est-ce qui le prouve ? » — sans relire 700 lignes.
>
> ⚠️ **Une ligne n'entre ici qu'avec sa PREUVE.** Un commit n'est pas une preuve de déploiement, et
> un déploiement n'est pas une preuve de fonctionnement. *C'est la seule règle de ce tableau, et
> c'est celle qui a manqué à `docs/vps-audit/ROADMAP.md` le jour où il a annoncé VPS-013 « ✅ FAIT ».*

| Date | ID | Tâche | État | Commit | La preuve |
|---|:--:|---|:--:|---|---|
| **09/09** *(VPS)* | *(VPS-M94)* | 🆕 **Un test écrit d'avance contre un point de référence que la rétention efface avant l'échéance** | ⚖️ **RÈGLE POSÉE** *(constat neuf)* | *(voir commit du jour)* | **Deux tests datés arrivaient à échéance ce matin, et les deux tombent entre leurs branches — pour le 2ᵉ jour consécutif.** VPS-039 exigeait **≥ 38 %** ou **≤ 32 %** : la mesure rend **31,5 %**. Le rapport du 08/09 exigeait `MOVING` **≥ 25 %** ou **~18 %** : la mesure rend **24,3 %**, à **0,7 point** de sa borne. 🔑 **La cause n'est pas dans la machine, elle est dans les tests** : tous deux se réfèrent au **jeudi 09-03**, sur une table dont la rétention vaut **3,95 j** — `min(receivedAt) = 2026-09-05 03:30:02`, **le point de référence a été effacé avant l'échéance**. *Un test daté à J+3 sur une source qui n'en garde que 4 est indécidable par construction.* **Preuve mesurée** : le point du **09-05** valait **18,6 %** hier et **21,7 %** aujourd'hui — **+3,1 points, −9 049 lignes, zéro événement**, exactement ce que **VPS-M93** avait prédit la veille. ✅ **Et la question de fond EST tranchée, sur la table où elle est décidable** : `positions` garde **62 jours** et le collecteur publie déjà la comparaison au même jour de semaine — **×0,94 mardi contre mardi**, à **30 émetteurs contre 30**, dans la bande. *Le cycle hebdomadaire tient ; il n'y a pas de dérive.* ➜ **RÈGLE** : avant d'écrire un test daté, vérifier que la rétention de sa source couvre l'échéance **plus** la profondeur du point de comparaison. Sinon **changer de source, pas de date** |
| **09/09** *(VPS)* | **V14** | [VPS-033](../vps-audit/REFERENCE-CONSTATS.md) · 🆕 VPS-M97 — la mesure `apt` **réussit**, et elle réfute **deux** alarmes | ✅ **MESURE VALIDE** *(3ᵉ succès sur 15)* + 🔧 **collecteur corrigé** | *(voir commit du jour)* | Cache `apt` du **09/09 01:29:35**, soit **0 h** : **75 paquets, dont 0 estampillés sécurité.** 🔑 **Et la première chose que cette réussite a servi à faire est de réfuter deux alarmes.** **(1)** La 2ᵉ source annonçait *« dont 1 de sécurité »* : c'est la ligne **« 1 additional security update can be applied with ESM Apps »**, un abonnement **non souscrit** — donc **pas installable ici**. *Ce défaut n'était pas détectable avant aujourd'hui : les 14 passages précédents affichaient `apt` « NON MESURABLE », il n'y avait rien à confronter.* **🆕 VPS-M97, corrigé** — deux extractions distinctes, jamais additionnées ; banc sur 4 formes de fichier, **7 = 7 sur le cas normal, aucune régression**. **(2)** Le test de **VPS-M74** arrivait à échéance et aurait conclu *« panne établie »* sur `75 → 75` **alors que l'installateur fonctionne** : les 75 viennent tous de `noble-updates` et du dépôt Docker CE, **hors des `Allowed-Origins`** de `50unattended-upgrades` — le réglage **standard** d'Ubuntu. Le journal le prouve : **34 paquets installés le 09-02, 20 le 09-05** dont `openssh-server`. *Un total qui ne bouge pas ne prouve rien — le discriminant était le **journal**, pas le compte* |
| **09/09** *(VPS)* | *(VPS-M91 a · M96 · M95)* | 🔧 **Trois correctifs au collecteur, dont deux rattrapés au banc avant publication** | ✅ **CORRIGÉ** *(collecteur)* | *(voir commit du jour)* | **(a) VPS-M91 (a) — angle mort n° 1 du 08/09, traité.** Le verdict « jamais exécutée » couvre désormais les **25 unités** de `list-timers` et non les seules `*-backup`, **pour un coût NÉGATIF** : **2 appels `systemctl show` au lieu de ~22**. Première mesure : **22 succès, 0 échec, 0 armée-jamais-exécutée, 3 minuteries non démarrées, 0 active sans échéance.** 🔴 **Le banc a arrêté 3 fausses alertes** — `apport-autoreport`, `snapd.snap-repair` et `ua-timer` sont `enabled` **et** `inactive`, donc sans échéance, et c'est normal ; la 1ʳᵉ rédaction les déclarait *« rien ne la déclenchera : VPS-015 »*. *Un contrôle qui crie au loup se fait désactiver en trois jours (VPS-M13).* 🔑 **Et le bloc a produit un fait que rien d'autre ne disait** : `tracky-demo-refresh.service` a tourné le **08/09 à 16 h 14 min 37** pendant que **sa minuterie n'a jamais déclenché** (échéance dimanche 13/09) — un import complet depuis la production, un mardi après-midi, **hors de tout horaire déclaré**. **(b) 🆕 VPS-M96** : le contrôle croisé posé la veille confrontait `positions` (**4,7** lignes/émetteur/h) à `trips` (**0,1**) sur la base de démo et publiait **« 34 émetteurs d'écart »** — un faux, sur la famille de constats la plus lourde de la machine. Le **débit par émetteur** devient le discriminant de **grain** ; au-delà d'un facteur 10, 🔴 → **🟠, jamais VERT**. Banc **7 cas sur le code réel** ; **la divergence RÉELLE du 07/09 rejouée reste 🔴** : aucune régression. **(c) 🆕 VPS-M95** : `/opt` a **perdu 1,5 Go sans perdre un octet** — `/opt/maalem` a dépassé son `timeout` et **la somme a été publiée entière**. Le `17 / 18` était imprimé ; *annoncer le dénominateur ne suffit pas s'il faut le lire pour savoir que le numérateur est faux* |
| **09/09** *(VPS)* | **V26** · **V27** · **V5** | Les trois gestes VPS les plus rentables, re-mesurés | ☐ **OUVERTES** | — | **V26 — 3ᵉ jour où la prédiction du 07/09 se vérifie** : `capcom6`, `vizyo-manager` et `vizyo-texto` à **117 h ⚠️ PÉRIMÉE**, pendant que les dossiers vivants portent **3 copies de 21 h chacun** (2 → 3 : *le mécanisme tourne, c'est mesuré*). **Deux 🟠 faux par jour** côté couverture. **30 s, risque quasi nul.** **V27 — la réponse est quasiment acquise, et elle a changé de nature** : la reconstructibilité de `tracky_demo` n'est plus *documentée*, elle est **mesurée** (`ExecMainExitTimestamp = 08/09 16:14:37`, les 8 tables « recalé le 09-08 16:15 »). ➜ **ne pas la sauvegarder** : ~**14 Go** évités (459 Mo/j × 30 j). Reste **une** question, produit : `demo_replay_frames` (40 Mo) n'existe pas en production — l'import la regénère-t-il ? **V5 — la question a changé** : 147 s pour 90, mais **20 des 23 secondes supplémentaires n'ont acheté ni information ni fiabilité** (12 s sur `/opt/maalem` dont la mesure a **échoué**, 8 s sur une base de démo qui a produit 3 🔴 dont un faux). *Borner ce qu'on **mesure**, plutôt qu'indexer le budget sur la taille du périmètre* |
| **09/09** | **T24** | [TRK-073](./REFERENCE-ERREURS.md#trk-073) — marquer le passage au DÉPART | ✅ **FAIT ET PROUVÉ** | `dae97b03` + `dc35f1a3` | 🎯 **LA CONSIGNE ÉCRITE D'AVANCE EST TOMBÉE AU MOT PRÈS.** Elle exigeait *« 24 lignes, **dont une ou plusieurs MARQUÉES INTERROMPUES** — et si le compte monte à 24 sans qu'aucune ne soit marquée, on a maquillé le carnet »*. **Le 08/09 rend 24 passages sur 24, dont EXACTEMENT 1 `interrupted`** : celui de **05:45:00**, tué en vol par le déploiement de 05:45. **Les deux moitiés sont franchies séparément** — le compte monte à 24, *et* la ligne manquante n'a pas été fabriquée. Série : 05/09 **23** · 06/09 **16** · 07/09 **17** · 08/09 **24**. Déployé **08/09 17:12:05** (migration `20260908053000`). Vérifié sur l'**artefact servi** : `running` **×7**, `interrupted` **×2** dans `dist/trip-analysis/trip-automation.service.js`. 🔴 **L'effet de bord est réel et déjà traité** : depuis `f988c74e`, **une `CRITICAL` suffit à envoyer un e-mail**, donc tout déploiement pendant un passage en enverrait un — `deploy.sh` **refuse désormais de partir** quand une ligne `running` est ouverte (`fd87ca46`), **vérifié présent sur le VPS**, arbre git propre au commit `578038d0`. ⚠️ **`trip_automation_runs` ne garde que 100 lignes** : le 04/09 valait 22 le 06/09 et vaut **19** ce jour — la journée la plus ancienne **s'érode par le bas**, la mise en garde écrite hier vient de servir. ⚠️ **L'audit du 08/09 cherchait `EN_COURS` et le trouvait absent** — le correctif avait livré la même idée sous le nom `running` : *chercher le mot d'une spécification plutôt que le comportement qu'elle décrit fait manquer un correctif présent* |
| **09/09** | **T26** | [TRK-075](./REFERENCE-ERREURS.md#trk-075) — remonter la décision d'alerter, borner le rejeu | `»` **DÉPLOYÉ** *(moitié de la preuve venue)* | `dc35f1a3` | ✅ **Le trajet s'est tu** : dernière ligne le **08/09 15:55:05**, puis **8 passages horaires consécutifs sans aucune** ligne `stage: 'compute'` (tous `done`), après **une par passage sans exception** depuis le 07/09 03:45 — 27 au total. Artefact servi : `PositionsIntrouvables` ×2, `fige-retention` ×5, `fige-sans-positions` ×5, `horizonRetention` ×7. ⚠️ **LA SECONDE MOITIÉ DE LA DOUBLE CONDITION ÉTAIT INVÉRIFIABLE TELLE QU'ÉCRITE, ET ELLE EST REFORMULÉE PLUTÔT QUE DÉCLARÉE SATISFAITE.** « Les candidats tombent de 17 à 14 » suppose que le correctif retire des lignes : il n'en retire **aucune**, il **exclut** les candidats sous l'horizon *à la sélection*. Une lecture voit donc le **vivier**, et le vivier **GROSSIT** : **17 → 20**, dont **3 → 4** sous l'horizon. *C'est la fuite lente annoncée, à la vitesse annoncée : +3 candidats et +1 immortel par jour.* Et le rejeu **n'est pas éteint** — les 8 passages ont analysé **2 à 8 trajets chacun**, 30 analyses portent un `computedAt` postérieur. 🗓️ **Test qui tranche au 10/09** : **24 h pleines** sans une ligne, pendant que le vivier sous horizon passe de **4 à ~5** |
| **09/09** | **T28** | 🆕 [TRK-016](./REFERENCE-ERREURS.md#trk-016) — redéfinir la mesure du recalage | ☐ **OUVERT** | — | *(tâche neuve)* 🔴 **L'instrument a cessé de mesurer ce qu'il mesurait.** La fenêtre 24 h rend **0,0 %** d'échec (186 trajets, 0 sans recalage ; **témoin impossible posé** : longueur minimale **265** caractères, aucune chaîne vide — ce sont de vraies géométries) contre **85,5 %** la veille. **Mais le 07/09 lui-même est passé de 85,5 % à 1,2 % POUR LES MÊMES TRAJETS** : ils ont été recalés **après leur clôture**, par `recalerAnciensTraces` ou par le recalage à la demande du rejeu (`c2afb01f`). *La fenêtre n'a pas bougé — le passé a bougé.* 🔴 **Et `trips` n'a pas d'`updatedAt`** : rien ne distingue « bien fait tout de suite » de « rattrapé la nuit suivante ». **La série de dix points ne se prolonge pas.** Ce qui reste mesurable : **1 150 trajets d'historique déjà recalés sur 10 032**. ⏳ **Preuve attendue au 10/09** : ~**1 510** à 15 par passage — *s'il ne bouge pas, le rattrapage ne tourne pas ; s'il bondit très au-delà, un autre chemin recale en masse et il faut le nommer* |
| **09/09** | **T13** | [TRK-016](./REFERENCE-ERREURS.md#trk-016) — le chantier du recalage | ☐ **OUVERT, et sa prémisse est périmée** | — | **Le « ~88 % d'échec depuis avril » sur lequel ce chantier devait s'ouvrir ne décrit plus rien** : le flux neuf est réparé (0 % sur les trajets clôturés depuis le 08/09). Ce qui reste est **l'historique** — **8 882 trajets** non recalés — et **une mesure cassée**. 👉 **Faire T28 AVANT de rouvrir ou de clore T13** : sur une grandeur que le rattrapage réécrit, aucune conclusion n'est décidable |
| **08/09** *(VPS)* | **V11** | VPS-013 — trois bases de production sans sauvegarde reproductible | ✅ **FAIT ET PROUVÉ** *(remonté de `[»]`)* | *(unités systemd)* | ✅ **Les trois preuves écrites d'avance le 07/09 sont tombées, toutes les trois.** **(1)** `LastTriggerUSec` **renseigné** : `vizyo-manager-backup` **07/09 04:30:56**, `vizyo-texto-backup` **04:40:56**, `capcom6-backup` **04:50:30** — chacun **à la seconde près sur son propre `OnCalendar`**. **(2)** `ExecMainExitTimestamp` **non vide** (04:30:57 · 04:40:57 · 04:50:30), donc le `Result=success` est **adossé à une fin réelle** et non à la valeur par défaut de systemd *(VPS-M87)*. **(3)** **DEUX** copies dans chacun de `/var/backups/{vizyo_manager,vizyo_texto,sms}`, datées 06/09 puis 07/09. 🔑 **LE DISCRIMINANT DE VPS-M81, RETOURNÉ** : le 06/09 les trois démarrages tombaient dans la **même seconde** (06:35:47-48) — un `systemctl start` en rafale, donc un **geste** ; le 07/09 ils tombent à **10 min d'intervalle**. *Trois horloges distinctes qui sonnent chacune à son heure ne sont pas une main qui appuie trois fois.* 🔑 **Et une quatrième preuve, non demandée** : le journal imprime sa rétention et elle **compte** — « 0 supprimée(s), **1** conservée(s) » le 06/09, « **2** conservée(s) » le 07/09. Le second passage a **relu un dossier qu'un passage précédent avait peuplé** : un cycle, pas une exécution. ⚠️ **Aucune unité n'a été relancée à la main** entre les deux passages — le test est resté décidable |
| **08/09** *(VPS)* | **V27** | 🆕 [VPS-040](../vps-audit/REFERENCE-CONSTATS.md) · VPS-M91 — trancher si la base de **démonstration** doit être sauvegardée | ☐ **OUVERT** | — | *(tâche neuve)* Le parc `tracky-demo` a été déployé le **07/09 à 14 h 08** (4 conteneurs) et le collecteur écrit `🔴 AUCUNE SAUVEGARDE → la sauvegarder couterait 433MB par jour`. **Le suivre coûterait ~13 Go** (433 Mo/j × 30 j) **sur un disque à 55 %**, pour copier une base que `demo-refresh.sh` **reconstruit depuis la production** chaque dimanche — source qui est, elle, sauvegardée (✅ à jour, 42 copies). ⏳ **Question restante, produit et non machine** : `demo_replay_frames` (28 Mo, 115 265 lignes) n'existe **pas** en production — l'import les regénère-t-il ? ⚠️ **Ne pas éteindre le 🔴 en allongeant une liste blanche de noms** : ce serait reproduire la cause de VPS-M88. Le verdict doit rester **ORANGE** — *un faux vert sur une sauvegarde est la plus chère des erreurs de ce dispositif* |
| **08/09** *(VPS)* | **V26** | VPS-013 · VPS-M88 — ranger les dossiers de sauvegarde abandonnés | 🔓 **DÉBLOQUÉE** *(reste ouverte)* | — | **Le test de V11 est clos, donc le renommage ne rend plus rien indécidable.** 🔴 **Et le faux orange est désormais MESURÉ, pas prédit** : `capcom6`, `vizyo-manager` et `vizyo-texto` affichent **93 h ⚠️ PÉRIMÉE** pendant que `sms`, `vizyo_manager` et `vizyo_texto` portent chacun **2 copies de 21 h**. Pire, la table de **couverture** dit l'inverse sur les mêmes applications (« en retard (3 j) »), sauf `texto-postgres` que le rapprochement attrape. *Deux des trois sont faux côté couverture ; les trois le sont côté âge.* ⚠️ **Renommer, jamais supprimer**, et **seulement après** avoir constaté les copies fraîches — l'ordre inverse laisse `capcom6` sans aucune sauvegarde si le nouveau mécanisme tombe la même nuit |
| **08/09** *(VPS)* | *(VPS-M90)* | 🆕 Une bande de silence se vide toute seule, et VPS-M78 **recommandait** de la comparer | ✅ **CORRIGÉ** *(collecteur)* | *(voir commit du jour)* | Le vecteur des bandes passe de **`1/0/7/6` à `0/1/1/12`** en une nuit : lu bande à bande, *« six boîtiers déposés de plus »* — **un constat de gravité 1 entièrement fabriqué**. Les six muets depuis le 08-31 avaient simplement franchi leur **7ᵉ jour**. **Le cumul `> 3 j` vaut 13 hier et 13 aujourd'hui.** Correctif : publication des **cumuls**, **zéro requête**. ⚠️ **Le banc a réfuté ma première rédaction avant publication** — j'y écrivais qu'un cumul est insensible au vieillissement ; il ne l'est **que dans un sens** (`> 1 j` 13→14, `> 7 j` 6→12). *Une baisse de cumul est toujours réelle ; une hausse peut n'être que du temps qui passe* |
| **08/09** | **T27** | 🆕 [TRK-076](./REFERENCE-ERREURS.md#trk-076) — la carte survit à une perte de contexte WebGL | `»` **DÉPLOYÉ** | `09d04e2b` | **Corrigé hors session**, par une session parallèle, entre les audits du 07 et du 08. Déploiement **08/09 00:56:59** (`tracky-web`, image de 00:56:15). Vérifié sur l'**artefact servi** : `webglcontextlost` **et** `carteUtilisable` présents dans `/usr/share/nginx/html/chunk-3BYQORV7.js`. 🔑 *MapLibre 5.24 met `this.style` à `null` en gardant l'objet `Map` vivant : **les 19 gardes `if (!this.map) return` passaient toutes** — la garde demandait « la carte existe-t-elle ? » quand la question était « son style existe-t-il encore ? ».* ⏳ **Preuve de production non venue** — 26 min de recul à la collecte ; attendue : 0 ligne `getSource` sur 7 j **et** le bandeau de reprise au prochain cas |
| **08/09** | **T26** | 🆕 [TRK-075](./REFERENCE-ERREURS.md#trk-075) — remonter la décision d'alerter au bon étage, et borner le rejeu par la rétention | ☐ **OUVERT** | — | *(tâche neuve, aucune preuve à ce stade)* 15 lignes en 21 h, **toutes le même trajet** `b644fe50` (61,4 j, 0 position, front de purge à 60,9 j, `POSITIONS_RETENTION_DAYS=60` lu sur le conteneur **servi**). ⏳ **Preuve attendue, en double condition** : plus **aucune** ligne `stage: 'compute'` pour un trajet sous l'horizon, **ET** les candidats au rejeu de **17 → 14**, **sans** que `stats.rejouees` tombe à zéro |
| **08/09** | **T24** | [TRK-073](./REFERENCE-ERREURS.md#trk-073) — marquer le passage au DÉPART | ☐ **OUVERT, et sa preuve s'efface** | — | ⚠️ **Découverte d'outillage à porter à la tâche** : `trip_automation_runs` ne garde que **100 lignes** (`KEEP_RUNS`). Le 03/09 rend **21** passages aujourd'hui contre **23** mesurés le 06/09, et le total de la fenêtre vaut **exactement 100**. 🔑 *Le « 16 sur 24 » du 06/09 sera illisible dans quelques jours — une preuve qui doit être relue plus tard doit être **recopiée** hors d'une table qui s'élague.* Vérifié absent de l'artefact servi (`EN_COURS` : 0) ; 07/09 rend **17 sur 24** |
| **07/09** *(VPS)* | **V11** | VPS-013 — trois bases de production sans sauvegarde reproductible | 🔴 **REQUALIFIÉ** `[x]` → `[»]` | *(unités systemd)* | 🔴 **La preuve annoncée le 06/09 n'en était pas une, et la machine le dit en trois endroits.** `LastTriggerUSec` est **vide** sur `vizyo-manager-backup.timer`, `vizyo-texto-backup.timer` et `capcom6-backup.timer` ; `ExecMainStartTimestamp` et `ExecMainExitTimestamp` le sont aussi sur les trois services ; et le journal date l'unique exécution du **06/09 à 06 h 35 min 47-48, les trois à la même seconde** — un `systemctl start`, donc **un geste, pas un mécanisme** (VPS-M81). **Première échéance autonome : 07/09 à 04 h 34 / 04 h 40 / 04 h 50 UTC, soit 2 h après la collecte.** ⏳ **Preuve attendue au 08/09** : `LastTriggerUSec` renseigné, `ExecMainExitTimestamp` non vide, et **DEUX** copies dans `/var/backups/{vizyo_manager,vizyo_texto,sms}`. ⚠️ **Ne pas relancer à la main d'ici là** — cela rendrait le test indécidable |
| **07/09** *(VPS)* | **V25** | VPS-M59 — `chargeDeFond.note` s'affiche | ✅ **FAIT ET PROUVÉ** | `9dce59ec` | 🔑 **La preuve est venue, et elle est plus forte que celle qui était demandée.** `tracky-web` a été **reconstruit le 07/09 à 01 h 22 min 34**, et les deux chaînes témoins (`fond-note`, « mesure absente du manifeste ») sont **toujours dans l'artefact servi** — désormais `chunk-K6RYKC7I.js`, **un fichier différent** de celui d'hier (`chunk-K4HBXQ56.js`). *Ce n'est donc pas l'ancien artefact resté en place : c'est une construction neuve qui porte le correctif, donc la branche d'où l'on déploie le porte encore.* ⚠️ Prouve que le code est **servi**, pas qu'il s'affiche — barre que la roadmap se donne elle-même |
| **07/09** *(VPS)* | **V14** | VPS-033 — la mesure `apt` | ☐ **recommandation CHANGÉE** | — | **La validité de la mesure s'est jouée à 37 minutes.** Le cache lu ce passage (collecte 02 h 21) est **exactement celui** que le passage du 06/09 (collecte 04 h 05) avait déclaré valide : daté du **06/09 02 h 59 min 53**. *75 → 75 n'est pas une stabilité, c'est **une** mesure publiée deux fois.* `RandomizedDelaySec=30m` **rétrécit** la fenêtre sans la **placer** → le geste devient `OnCalendar=*-*-* 01:30:00` + `RandomizedDelaySec=15m` |
| **07/09** | **V24** | VPS-038 — sentinelle « boîtiers muets » | ✅ **FAIT ET PROUVÉ** | `fb0642f8` | 🔑 **La preuve attendue est tombée au mot près.** Passage du 06/09 à **06:30:01** : **exactement 2 lignes, pas 10** — `2ad69ac1` (cdef31, **8 boîtiers**, 17,8 → 5,7 j) et `88627f81` (A2R, **2 boîtiers**, `KSR•370` 23,2 j, `GLA•KC•31` 3,2 j, `deposesSansVehicule: 3`). Le regroupement par société tient |
| **07/09** | **T10** | TRK-070 — le niveau de l'escalade suit la CAUSE | `»` **DÉPLOYÉ** | `2112e9ae` | Déploiement **07/09 00:58:58**. Vérifié sur l'**artefact servi** : `causeTechnique` **×5** dans `dist/assistance/assistance.service.js`, et l'ancienne règle `urgent \|\| gravite === 'CRITICAL' ? …` **a disparu**. ⏳ **Preuve de production non venue** — aucun échec IA depuis le 05/09 17:00 |
| **07/09** | **T11** | TRK-068 — borner le `fetch` vers Vizyo Auth | `»` **DÉPLOYÉ** | `c80632ba` | Déploiement **07/09 00:58:58**. Vérifié sur l'**artefact servi** : `AbortSignal` et `ServiceUnavailableException` présents dans `dist/auth-client/auth-client.service.js`, `Vizyo Auth` nommé **6 fois**. ⏳ **Preuve de production non venue** — aucun rejet de transport depuis le 04/09 12:57 |
| **07/09** | **T2** | TRK-069 — rallumer le poste | ✅ **FAIT** | *(aucun — geste matériel)* | Le poste a repris **seul** le 06/09 à 06:08. 🔑 **Et c'est du même coup la preuve de l'auto-archivage annoncé par TRK-069** : les 4 lignes se sont archivées d'elles-mêmes (« Agent repassé … résolution automatique »), et une 5ᵉ — `agent-limites-vitesse` — est née à 18:50 et s'est refermée à 20:50. **Zéro geste humain** |
| **06/09** | **V11** | VPS-013 — trois bases de production sans sauvegarde reproductible | ✅ **FAIT ET PROUVÉ** | *(unités systemd)* | 3 unités dérivées du gabarit `vizyo-auth-backup`, exercées une fois chacune → **3 succès**. 🔑 **Confrontées à la base VIVANTE** : `vizyo_manager` **8 tables = 8** `CREATE TABLE` · `vizyo_texto` **47 lignes `allowlist_entries` = 47** · `sms` 9 tables. Archives **600**, dossiers **700**. Minuteries **actives** (04:30 / 04:40 / 04:50 UTC, `Persistent=true`). Elles portent déjà `ExecStart=/bin/bash` — le geste de **V13** |
| **06/09** | **T11** | TRK-068 — un appel à Vizyo Auth ne peut plus durer, ni remonter nu | `~` **COMMITÉ** | `c80632ba` | auth-client **16/16**, typecheck **3/3**, smoke-boot **5/5**. 🔑 **Deux mutations** — retrait du délai → **1 échec**, remontée nue du rejet → **4 échecs**. Le jumeau `verifyLoginCode` passe par le même chemin borné. ⏳ **Preuve attendue** : `statusCode 503`, niveau `ERROR`, motif technique **conservé** en fin de phrase |
| **06/09** | **T10** | TRK-070 — le niveau de l'escalade suit la CAUSE, pas la gravité de la conversation | `~` **COMMITÉ** | `2112e9ae` | Suite assistance **74/74**, typecheck **3/3**, smoke-boot DI **5/5**. 🔑 **Mutation de la règle de niveau → 1 échec exactement** : le test n'est pas tautologique. Les **trois** replis techniques traités ensemble *(leçon de TRK-004)*. ⏳ **Preuve attendue en production** : UNE seule ligne `ASSISTANCE`, en `DEGRADATION`, **et** le journal système garde son `assistance_escalade` |
| **06/09** | **V0** | Verser `docs/vps-audit/` sur `main` — 20 jours d'audit n'y existaient pas | ✅ **FAIT** | *(checkout de chemin, avec historique)* | Arborescences vérifiées identiques ; 29 rapports, 125 fiches, 631 Ko sur `main` |
| **06/09** | *(VPS-038)* | Sentinelle « boîtiers muets » | `[»]` **DÉPLOYÉE** | `fb0642f8` | 48 tests verts, mutation du seuil → 1 échec exactement ; smoke-boot OK ; `restarts=0`, `healthy`. ⏳ **Preuve attendue** : 2 lignes à la passe de 06:30 UTC, **pas 10** |
| **06/09** | *(VPS-M59)* | `chargeDeFond.note` s'affiche + repli explicite | `[»]` **DÉPLOYÉ** | `9dce59ec` | Sur l'**artefact servi** : `fond-note` 0 → 1, « mesure absente du manifeste » 0 → 1, **témoin impossible 0** ; `ng build` NG_EXIT=0 |

### Ce que le prochain passage doit faire de ce journal

1. **Relire le [tableau de bord](#-tableau-de-bord--55-tâches-lavancement-dun-coup-dœil) AVANT la
   collecte** — c'est là que vit la passation, et c'est précisément ce que les passages des 05 et
   06/09 n'ont pas fait, au prix d'un chapitre entier réécrit pour rien *(VPS-M81)*.
2. **Vérifier les `[»]` ci-dessus.** Ils passent `[x]` **le jour où la mesure tombe**, pas avant —
   et si elle ne tombe pas, le dire.
   ~~🔴 **Au 07/09, le plus urgent est V11** — `LastTriggerUSec`, `ExecMainExitTimestamp`, deux
   copies~~ → ✅ **LES TROIS SONT TOMBÉES LE 08/09.** V11 est **FAIT ET PROUVÉ**, et les unités
   n'ont **pas** été relancées à la main : le test est resté décidable.
   ~~**V25**, dont la preuve relève de la routine VPS~~ → **prouvé le 07/09**. Restent les deux
   déployés le matin du 07/09 :
   **T10** *(UNE seule ligne `ASSISTANCE`, en `DEGRADATION`, et le journal système garde son
   `assistance_escalade` — si les deux tombent, on a supprimé la trace)* et **T11** *(`503` et non
   `500`, niveau `ERROR` et non `CRITICAL`, motif technique **conservé** en fin de phrase)*.
   ⚠️ **Les deux attendent une OCCASION qui ne vient pas** : aucun échec IA depuis le 05/09 17:00,
   aucun rejet de transport depuis le 04/09 12:57. *Un correctif déployé qu'aucun événement
   n'exerce reste un correctif non prouvé — le dire vaut mieux que l'oublier.*
4. ~~🆕 **Relever la série de `trip_automation_runs`**~~ → ✅ **T24 EST CLOSE le 09/09.** Série
   complète : 02/09 **15** · 03/09 **23** · 04/09 **22** · 05/09 **23** · 06/09 **16** · 07/09 **17**
   · **08/09 24 sur 24, dont 1 `interrupted`**. ⚠️ **Cette série est désormais à recopier ici et
   nulle part ailleurs** : `trip_automation_runs` ne garde que **100 lignes**, et le 04/09 est déjà
   passé de 22 à **19 par le bas**. *Une preuve qui doit être relue plus tard doit vivre hors d'une
   table qui s'élague.*

6. 🆕 **Au 09/09, trois tests sont écrits d'avance pour le 10/09 :**
   - 🔬 **T26** — **24 h pleines sans une seule ligne** `stage: 'compute'` pour un trajet sous
     l'horizon, **pendant que** le vivier sous horizon passe de **4 à ~5**. *Si les lignes
     reviennent, le gel ne tient pas ; si le vivier sous horizon cesse de croître, on a purgé au lieu
     de borner.*
   - 🔬 **T28 / T13** — les trajets d'historique déjà recalés doivent passer de **1 150** à **~1 510**
     (15 par passage × 24 passages). *Immobile = le rattrapage ne tourne pas ; très au-delà = un
     autre chemin recale en masse, et il faut le nommer avant d'en tirer quoi que ce soit.*
   - 🔬 **La sentinelle « vitesse contredite » change de forme** (`8fa14cb4`, en ligne depuis 17:12) :
     au passage de **06:30**, le message doit désigner **les véhicules qui sortent du lot** (≥ 5
     analyses touchées **et** ≥ 50 % des leurs) et porter `vehiculesHorsNorme` au contexte — et non
     plus des flottes entières. ⚠️ **Il doit rester possible qu'elle se taise** : une flotte sans
     véhicule hors norme ne doit produire **aucune** ligne. *Un instrument qui ne peut plus rien dire
     rend le même silence qu'un instrument qui n'a rien à dire — c'est la leçon du témoin désarmé.*
5. 🆕 **Au 08/09 après la routine VPS, deux tests sont écrits d'avance pour le 09/09 :**
   - 🔬 **Le taux `MOVING` du mardi 09-08** doit rendre **≥ 25 %** si la reprise d'activité est en
     cours. La série des journées **complètes** fait ven 09-04 *(tronquée)* · sam **18,6 %** · dim
     **13,9 %** · lun **18,8 %**. *Le test du 07/09 prévoyait deux issues — « remonte vers 28 % » ou
     « reste sous 15 % » — et **la mesure est tombée entre les deux**. Ne pas choisir la branche qui
     arrange : un **lundi ouvré qui roule au niveau d'un samedi** reste à expliquer.* **Si le mardi
     rend encore ~18 %, deux jours ouvrés consécutifs sous le niveau du jeudi ne sont plus un effet
     de calendrier**, et la question passe côté produit.
     ⚠️ **Et lire la série avec VPS-M93** : son jour le plus ancien est **érodé par la rétention de
     3,95 j** et dérive de plusieurs points d'un passage à l'autre — le 09-04 est passé de 25,3 % à
     29,5 % **sans que rien n'arrive**, parce que ses 3 h 30 de nuit ont été purgées.
   - 🔬 **`tracky-demo-refresh.timer` n'a jamais tourné** (première échéance **dimanche 09-13**), et
     elle affiche pourtant `Result=success` — **VPS-M91**. *Ce n'est pas un défaut aujourd'hui ;
     c'est le rappel que le même affichage rendra la même chose le jour où une unité qui **devait**
     tourner ne tournera pas.*
3. **Cocher ce qui a été fait entre-temps**, même par un humain hors session : une tâche close qui
   reste `☐` fait rouvrir un chantier déjà terminé.
