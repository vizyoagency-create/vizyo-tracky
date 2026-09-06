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

## 🗂️ Tableau de bord — 49 tâches, l'avancement d'un coup d'œil

**Au 2026-09-06 : 2 faites · 2 déployées, preuve attendue · 2 commitées · 43 ouvertes.**

> 🖥️ **Le même état, en visuel : [`TABLEAU-DE-BORD.html`](./TABLEAU-DE-BORD.html)** — un fichier autonome, regénéré à chaque passage des deux routines quotidiennes, qui se filtre par gravité, par partie et par état. *Il ne remplace pas ce fichier-ci : il en donne l'état, jamais le pourquoi.*

### Partie I — centre d'alerte *(23 tâches)*

| | ID | Fiche | La tâche | État |
|:--:|:--:|---|---|---|
| ☐ | **T1** | TRK-071 | 🔴🔴 Recharger **au moins un** des deux comptes IA | 🤝 HUMAIN |
| ☐ | **T2** | TRK-069 | 🔵 Rallumer le poste, lire le motif de `agent-recit-trajet` | 🤝 HUMAIN |
| ☐ | **T3** | TRK-066 | 🔴 Trancher les **trois questions** du coupe-circuit | 🤝 HUMAIN |
| ☐ | **T4** | TRK-072 | Calibrer les notifications d'excès de vitesse | 🤝 HUMAIN |
| ☐ | **T5** | TRK-062 | Autoriser la migration `SENT_UNCONFIRMED` | 🤝 HUMAIN |
| ☐ | **T6** | TRK-065 | Prévenir `tyger.bcn@gmail.com` *(21 notifications perdues)* | 🤝 HUMAIN |
| ☐ | **T7** | TRK-035 | Ouvrir la fenêtre de maintenance *(rôle non-superutilisateur)* | 🤝 HUMAIN |
| ☐ | **T8** | TRK-001 · 027 | 🔵 Contrôler les antennes *(3 véhicules)* | 🤝 HUMAIN |
| ☐ | **T9** | — | 🔵 Déclarer ou dépanner `GLA•KC•31` et `FG-669-DQ` | 🤝 HUMAIN |
| `~` | **T10** | TRK-070 | Le niveau de l'escalade suit la **cause**, pas la gravité | ✅ **COMMITÉ** `2112e9ae` |
| `~` | **T11** | TRK-068 | Borner le `fetch` vers Vizyo Auth *(+ le jumeau)* | ✅ **COMMITÉ** `c80632ba` |
| ☐ | **T12** | TRK-022 | Déduplication **générique** des alarmes du boîtier | 🔧 À CODER |
| ☐ | **T13** | TRK-016 | Recalage cartographique — **~88 % d'échec** | 🔧 CHANTIER |
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

### Partie II — VPS *(26 tâches)*

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
| ☑ | **V11** | VPS-013 | 🔴 **3 bases de prod sans sauvegarde reproductible** | ✅ **FAIT ET PROUVÉ** |
| ☐ | **V12** | VPS-012 | Restreindre la clé CI `vizyo-auth` *(10 s)* | 🟡 PRÉPARÉ |
| ☐ | **V13** | VPS-015 | `ExecStart` par `bash` **+ `OnFailure=` sur `tracky-backup`** | 🟢 AUTO |
| ☐ | **V14** | VPS-033 | `RandomizedDelaySec=30m` sur `apt-daily.timer` | 🟡 PRÉPARÉ |
| ☐ | **V15** | VPS-034 | Épingler Traefik par digest *(déjà relevé)* | 🔴 HUMAIN |
| ☐ | **V16** | VPS-026 | Épingler `alpine` par empreinte *(déjà relevée)* | 🟡 PRÉPARÉ |
| ☐ | **V17** | VPS-030 | Purger 1,4 Go de copies sans rétention *(périmètre prêt)* | 🟡 PRÉPARÉ |
| ☐ | **V18** | VPS-032 | Multiplexage SSH **côté poste** | 🟢 AUTO |
| ☐ | **V19** | VPS-007 | `random_page_cost` — *déconseillé en l'état* | 🟡 PRÉPARÉ |
| ☐ | **V20** | VPS-M79 | Étiqueter les images de repli au build | ⛔ BLOQUÉ |
| ☐ | **V21** | VPS-029 | Trancher quel mécanisme gouverne le cache de build | ⛔ BLOQUÉ |
| ☐ | **V22** | VPS-M36 | Échantillonner `wchan` 3× et publier la répartition | ⛔ BLOQUÉ |
| ☐ | **V23** | VPS-M73 | Afficher l'écart en jours sur `/admin → Audit VPS` | ⛔ BLOQUÉ |
| `»` | **V24** | VPS-038 | **Sentinelle « boîtiers muets »** — *preuve attendue : 2 lignes à 06:30 UTC, pas 10* | 🗓️ DÉPLOYÉE |
| `»` | **V25** | VPS-M59 | **`chargeDeFond.note` s'affiche** + repli explicite | 🗓️ DÉPLOYÉ |



> ⭐ **Les deux tâches les plus rentables de tout le fichier, si vous n'en faites que deux :**
> **T10** *(quelques lignes, referme le motif récurrent de la semaine)* et **V11** *(20 minutes,
> trois bases de production qui n'ont aujourd'hui aucun filet reproductible)*.

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
| **06/09** | **82** | **Les DEUX fournisseurs IA sont à sec en même temps** — le repli `claude → gpt` livré la veille a été exercé 6 min après sa mise en ligne et n'avait nulle part où aller *(🆕 TRK-070, TRK-071, TRK-072)* |

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
| **06/09** | **V11** | VPS-013 — trois bases de production sans sauvegarde reproductible | ✅ **FAIT ET PROUVÉ** | *(unités systemd)* | 3 unités dérivées du gabarit `vizyo-auth-backup`, exercées une fois chacune → **3 succès**. 🔑 **Confrontées à la base VIVANTE** : `vizyo_manager` **8 tables = 8** `CREATE TABLE` · `vizyo_texto` **47 lignes `allowlist_entries` = 47** · `sms` 9 tables. Archives **600**, dossiers **700**. Minuteries **actives** (04:30 / 04:40 / 04:50 UTC, `Persistent=true`). Elles portent déjà `ExecStart=/bin/bash` — le geste de **V13** |
| **06/09** | **T11** | TRK-068 — un appel à Vizyo Auth ne peut plus durer, ni remonter nu | `~` **COMMITÉ** | `c80632ba` | auth-client **16/16**, typecheck **3/3**, smoke-boot **5/5**. 🔑 **Deux mutations** — retrait du délai → **1 échec**, remontée nue du rejet → **4 échecs**. Le jumeau `verifyLoginCode` passe par le même chemin borné. ⏳ **Preuve attendue** : `statusCode 503`, niveau `ERROR`, motif technique **conservé** en fin de phrase |
| **06/09** | **T10** | TRK-070 — le niveau de l'escalade suit la CAUSE, pas la gravité de la conversation | `~` **COMMITÉ** | `2112e9ae` | Suite assistance **74/74**, typecheck **3/3**, smoke-boot DI **5/5**. 🔑 **Mutation de la règle de niveau → 1 échec exactement** : le test n'est pas tautologique. Les **trois** replis techniques traités ensemble *(leçon de TRK-004)*. ⏳ **Preuve attendue en production** : UNE seule ligne `ASSISTANCE`, en `DEGRADATION`, **et** le journal système garde son `assistance_escalade` |
| **06/09** | **V0** | Verser `docs/vps-audit/` sur `main` — 20 jours d'audit n'y existaient pas | ✅ **FAIT** | *(checkout de chemin, avec historique)* | Arborescences vérifiées identiques ; 29 rapports, 125 fiches, 631 Ko sur `main` |
| **06/09** | *(VPS-038)* | Sentinelle « boîtiers muets » | `[»]` **DÉPLOYÉE** | `fb0642f8` | 48 tests verts, mutation du seuil → 1 échec exactement ; smoke-boot OK ; `restarts=0`, `healthy`. ⏳ **Preuve attendue** : 2 lignes à la passe de 06:30 UTC, **pas 10** |
| **06/09** | *(VPS-M59)* | `chargeDeFond.note` s'affiche + repli explicite | `[»]` **DÉPLOYÉ** | `9dce59ec` | Sur l'**artefact servi** : `fond-note` 0 → 1, « mesure absente du manifeste » 0 → 1, **témoin impossible 0** ; `ng build` NG_EXIT=0 |

### Ce que le prochain passage doit faire de ce journal

1. **Relire le [tableau de bord](#-tableau-de-bord--46-tâches-lavancement-dun-coup-dœil) AVANT la
   collecte** — c'est là que vit la passation, et c'est précisément ce que les passages des 05 et
   06/09 n'ont pas fait, au prix d'un chapitre entier réécrit pour rien *(VPS-M81)*.
2. **Vérifier les deux `[»]` ci-dessus.** Ils passent `[x]` **le jour où la mesure tombe**, pas
   avant — et si elle ne tombe pas, le dire.
3. **Cocher ce qui a été fait entre-temps**, même par un humain hors session : une tâche close qui
   reste `☐` fait rouvrir un chantier déjà terminé.
