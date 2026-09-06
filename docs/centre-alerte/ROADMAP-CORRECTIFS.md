# Roadmap des correctifs — centre d'alerte Tracky

> **Refondue le 2026-09-06**, à partir des **20 fiches ouvertes** du
> [référentiel](./REFERENCE-ERREURS.md) et des six derniers audits (01/09 → 06/09). Ce fichier dit
> **quoi faire, dans quel ordre, et ce qui est vérifiable aujourd'hui** — le référentiel, lui, dit
> *pourquoi*. Les deux ne se recopient pas.
>
> 📌 **Ce fichier est le SEUL sans date dans son nom, et c'est délibéré : c'est la roadmap
> VIVANTE.** `ROADMAP-CORRECTIFS-2026-08-25.md`, `-2026-09-01.md` et `-2026-09-04.md` sont les
> plans de passes de correction passées — ils décrivent ce qui a été fait ces jours-là et ne se
> mettent plus à jour. *Un dossier qui contient quatre roadmaps doit dire laquelle fait foi, sans
> quoi la plus récemment ouverte gagne — et ce n'est pas un critère.*

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

| # | Fiche | L'action, en une phrase | Depuis |
|---|---|---|---|
| **1** | [TRK-071](./REFERENCE-ERREURS.md#trk-071) | 🔴🔴 **Recharger au moins UN des deux comptes IA** — Anthropic **et** OpenAI sont vides | **76 h** |
| **2** | [TRK-069](./REFERENCE-ERREURS.md#trk-069) | 🔵 **Rallumer le poste** et lire le motif d'échec de `agent-recit-trajet` | 05/09 |
| **3** | [TRK-066](./REFERENCE-ERREURS.md#trk-066) | 🔴 **Trancher les trois questions du coupe-circuit** *(détail ci-dessous)* | 04/09 |
| **4** | [TRK-072](./REFERENCE-ERREURS.md#trk-072) | **Calibrer les notifications d'excès de vitesse** — 14/jour/super-admin, pour un produit calibré sur 2 à 3 | 06/09 |
| **5** | [TRK-062](./REFERENCE-ERREURS.md#trk-062) | **Autoriser la migration** `SENT_UNCONFIRMED` pour les commandes de boîtier | 03/09 |
| **6** | [TRK-065](./REFERENCE-ERREURS.md#trk-065) | **Prévenir `tyger.bcn@gmail.com`** — 21 notifications perdues faute d'appareil abonné | 04/09 |
| **7** | [TRK-035](./REFERENCE-ERREURS.md#trk-035) | **Ouvrir une fenêtre de maintenance** pour créer le rôle applicatif non-superutilisateur | 20/08 |
| **8** | [TRK-001](./REFERENCE-ERREURS.md#trk-001) · [TRK-027](./REFERENCE-ERREURS.md#trk-027) | 🔵 **Contrôler les antennes** de `FS-253-HR`, `FZ-862-VY`, `KSR•370` | 03/08 |
| **9** | *(hors fiche)* | 🔵 **Déclarer ou dépanner** `GLA•KC•31` (74 h) et `FG-669-DQ` (57 h), muets et **non déclarés** | 03/09 |

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

### TRK-070 · gravité 2 · 🔧 À CODER — *le plus rentable de la liste*

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

### TRK-068 · gravité 2 · 🔧 À CODER

**Ce qui se passe** — `auth-client.service.ts`, méthode `request()` : l'appel à Vizyo Auth est un
`fetch` **sans `try/catch` ni délai d'expiration**. Le rejet de transport remonte nu, NestJS en fait
un **500** là où une dépendance injoignable est un **503**, et le tout sort en `CRITICAL`.

**Le geste** — Envelopper le `fetch` : `AbortSignal.timeout()`, capture du rejet, puis
`ServiceUnavailableException` dont le message nomme **Vizyo Auth**, l'opération tentée et la
conséquence pour l'utilisateur, **motif technique conservé en fin de phrase**. Niveau `DEGRADATION`.
**Traiter le jumeau `verifyLoginCode()`**, qui appelle `fetch` en direct avec le même angle mort.

⚠️ **1 occurrence, 2 jours.** Fait mesuré, pas une tendance — mais le geste est connu et borné.

### TRK-022 · gravité 2 · 🔧 À CODER *(à clore)*

**Ce qui se passe** — Aucune déduplication **générique** des alarmes du boîtier. Le volet 1 est
**répondu** (1 317 → 1-2 par jour, plancher net à 6,16 h), mais la déduplication n'est posée **que
sur le chemin de la survitesse** — qui n'est qu'un cas parmi d'autres.

**Le geste** — Remonter la déduplication dans la fonction qui crée une alerte à partir d'une trame,
**par véhicule ET par type ET par fenêtre**. Le modèle existe déjà dix lignes plus loin (perte GPS,
24 h), avec un commentaire qui explique longuement pourquoi.

🔗 **Croisement neuf avec [TRK-072](./REFERENCE-ERREURS.md#trk-072)** : c'est ce chemin générique qui
décidera si la chaîne V5 sature à nouveau ses destinataires.

## P1 — le message ment, ou le compteur dérive

### TRK-016 · gravité 2 · 🔧 CHANTIER *(hors passe)*

**Le recalage cartographique échoue sur ~9 trajets sur 10, depuis avril.** Mesure fraîche sous les
lots V1→V9, prise le 06/09 : **87,9 %** (131 trajets sur 149).

Série ouvrée : 90,2 · 88,7 · 91,3 · 87,0 · 89,3 · 91,1 · 91,9 · 89,2 · 83,3 · **87,9**.

⚠️ **Le 83,3 % du 05/09 était une fluctuation, et la réserve écrite ce jour-là vient de
s'auto-vérifier.** Le chantier peut désormais s'ouvrir : le chiffre est frais et stable autour de
**~88 %**. Ce n'est pas une passe d'une heure — c'est un vrai sujet, à planifier.

### TRK-053 · gravité 1 · ⛔ déployé, **aucune occasion**

Correctif déployé le **01/09 à 09:17**. **Sans régression** : `alertes_depuis_declaration` = **7**,
identique aux 04, 05 et 06/09 — **3ᵉ point**. Ce qui manque est une **occasion** : les 10 véhicules
déclarés hors service sont muets, et *un correctif qui fait taire des boîtiers déjà silencieux ne
prouve rien*.

👉 **Décision proposée** : le **provoquer** au prochain retour de LLD, ou le **requalifier** le 08/09.

---

# 🗓️ DÉPLOYÉ, NON EXERCÉ — la consigne datée attend son occasion

*Ces quatre correctifs sont **en ligne**, marqueurs vérifiés sur l'**artefact servi** le 05/09.
Aucun n'a encore eu l'occasion de se prouver. **Ne pas les rouvrir ; les guetter.***

| Fiche | Ce qui le prouvera | Attendu |
|---|---|---|
| [TRK-060](./REFERENCE-ERREURS.md#trk-060) | Une ligne `system-metrics` commençant par « **Un point de mesure système n'a pas pu être enregistré** », et non par la pile de transport brute | au prochain incident DNS |
| [TRK-064](./REFERENCE-ERREURS.md#trk-064) | *Son sujet a changé* : la chaîne **est armée** sur 2 sociétés sur 5, et le silence de la sentinelle est **légitime** | — 👉 **à clore ?** |
| [TRK-065](./REFERENCE-ERREURS.md#trk-065) | La ligne hebdomadaire tombe de **42 à ~21**, ne cite plus `system@tracky.local`, et porte `comptesTechniquesEcartes: 1` | **~11/09** |
| [TRK-066](./REFERENCE-ERREURS.md#trk-066) | La ligne `sms-gateway` commence par « **SMS non remis au relais** », nomme `vizyo-texto`, **et conserve le motif technique en fin de phrase** | au prochain échec du relais |

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

| Fiche | Ce qu'il faut provoquer | En attente | Décision proposée |
|---|---|---|---|
| [TRK-032](./REFERENCE-ERREURS.md#trk-032) | une trame `ac alarm` pendant une coupure programmée | 🔴 **16 j** | **REQUALIFIER** — 7 coupures cette semaine, toutes hors plage. Soit on la fabrique en atelier, soit on ferme la fiche en « non reproductible en exploitation ». |
| [TRK-051](./REFERENCE-ERREURS.md#trk-051) | mode fix : badge ambre « cible atteinte (mesurée) » | 🔴 **12 j** | **CONFIER À UN HUMAIN** — geste d'interface, impossible à provoquer en lecture seule. **30 s pour qui a l'écran.** |
| [TRK-053](./REFERENCE-ERREURS.md#trk-053) | une alarme sur un véhicule déclaré hors service | 6 j | Encore dans la fenêtre. **À trancher le 08/09** si aucune occasion. |

---

# ⛔ BLOQUÉ PAR UN PRÉREQUIS

| Fiche | Ce qui bloque | Le prérequis |
|---|---|---|
| [TRK-062](./REFERENCE-ERREURS.md#trk-062) | `SENT_UNCONFIRMED` n'existe **pas** pour les commandes de boîtier — vérifié **absent de l'artefact servi 3 fois** | Une **migration d'énumération**, donc un accord humain. Spec prête. |
| [TRK-027](./REFERENCE-ERREURS.md#trk-027) | Le garde-fou juste est **physique** (contact coupé), pas temporel | **L'état du contact n'est PAS persisté sur une trame sans fix.** Il faut d'abord le persister. |
| [TRK-035](./REFERENCE-ERREURS.md#trk-035) *(voie 1)* | Le rôle applicatif est **superutilisateur ET propriétaire** — un `REVOKE` est sans effet sur lui | Fenêtre de maintenance + répétition : *un droit oublié casse l'ingestion GPS*. |
| [TRK-018](./REFERENCE-ERREURS.md#trk-018) | Les 4 correctifs sont livrés et **prouvés** (313 → **0** commandes `SENT`, 307 → **0** de plus de 24 h) | Reste : **la passerelle SMS n'expose aucun accusé de remise**. Même sujet que TRK-026 et TRK-062. |

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
