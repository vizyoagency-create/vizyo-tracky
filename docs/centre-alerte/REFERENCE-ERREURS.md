# Référentiel des erreurs — Centre d'alerte Tracky

> Mémoire longue du centre d'alerte. Une erreur qui apparaît en prod se retrouve ici, avec sa
> cause racine et son correctif. À chaque passage, l'audit compare ce qu'il voit à ce fichier :
> **signature connue → on met à jour les compteurs ; signature inconnue → on enquête et on ajoute
> une fiche.**
>
> Il existe parce que la table `error_logs` **ne garde rien** : `ERROR_LOGS_RETENTION_DAYS`
> vaut 30 par défaut et n'est pas défini en prod, donc une erreur jamais corrigée s'efface
> toute seule à J+30. Ce fichier, lui, survit à la purge.

- Procédure d'audit : [`PROCEDURE-AUDIT.md`](./PROCEDURE-AUDIT.md)
- Rapports quotidiens : [`rapports/`](./rapports/)
- Dernière mise à jour : **2026-08-11**

---

---

## 🔎 2026-08-11 — le silence du boîtier est PROUVÉ, et le repli SMS n'a jamais eu de preuve de remise

Première nuit complète après les correctifs du 10/08 au soir. **Zéro ligne `error_logs` en six
heures**, et les trois correctifs déployés font ce qu'ils annonçaient — vérifiés chacun sur une
mesure, pas sur leur intention.

Le test daté de [TRK-014](#trk-014) rend son verdict, et c'est le deuxième cas de sa table de
décision : `total = 14`, `avec_ack = 0`, `silences_traces = 14`. **Le boîtier ne répond jamais —
prouvé, plus supposé.** L'écoute armée la veille a produit quatorze silences tracés en cinq heures.
Ce que ça débloque n'est pas un correctif : c'est le droit d'éliminer une hypothèse. « Le firmware
accepte mais n'applique pas » n'est **pas** confirmée ; le test SMS sur un boîtier redevient le seul
discriminant, et le correctif de [TRK-012](#trk-012) reste suspendu.

> La garde la plus fragile a tenu : les 14 commandes sont `FAILED` par les chemins ordinaires
> (réconciliation, échéance), **aucune par l'ACK**. Armer une écoute sans lui donner de pouvoir de
> décision était le point où la récidive était la plus probable.

**Et un angle mort neuf, trouvé en ouvrant une table qu'aucun passage n'avait ouverte.**
`engine_control_commands` : **112 commandes moteur reparties en SMS depuis le 03/06, aucune
acquittée**, statut `SENT` définitif. Côté passerelle, les **112 messages correspondants sont
encore en `queued`** — et **aucun message sortant, sur 310 depuis l'origine, n'a jamais dépassé cet
état**. Voir [TRK-018](#trk-018).

> Le constat n'est pas « les SMS n'arrivent pas » — c'est que **rien, nulle part, ne peut le dire**.
> Un véhicule est coupé et redémarré chaque nuit par ce canal. La cécité se distingue mal d'un
> fonctionnement normal : c'est exactement ce qui l'a laissée passer dix semaines.

**Ce que l'épisode apprend sur la méthode.** Deux instruments posés la veille ont répondu en une
nuit, et **un troisième s'est périmé dans le même geste** : le comptage de lignes `sms-allowlist`
proposé comme discriminant de [TRK-017](#trk-017) est devenu illisible, deux causes se superposant
désormais (la garde empêche le trou, l'alerte est passée par épisode). Le journal d'appels l'a
remplacé — et il renverse l'hypothèse « appelant actif aux heures ouvrées » : la machine a frappé à
21:25, 22:25, 23:25 et 00:25 UTC. *Un instrument neuf périme parfois celui qui l'a fait naître ;
encore faut-il s'en apercevoir avant de lire son zéro comme une bonne nouvelle.*

**Et deux en-têtes de fiche disaient faux** — vérifiés sur `main`, pas recopiés : TRK-001 et TRK-002
étaient annoncés « écrits, pas déployés ». Le commit `d5e5fb1` les contient, et il est en production
depuis le 10/08 19:39. *Une fiche écrite le soir d'un déploiement décrit l'état d'avant.*

---

## 🔎 2026-08-10 — le seul repli du coupe-circuit était coupé pour 24 boîtiers sur 43

Deux lignes inédites, source `sms-allowlist`, et derrière elles le trou le plus coûteux vu depuis
l'amorçage : **25 numéros sur 41 étaient absents de l'allowlist de la passerelle SMS, dont 24 SIM
de boîtier.** Le mode allowlist est actif ; un numéro absent reçoit un `403` levé **avant** toute
écriture. Un SMS refusé pour ce motif ne laisse donc **rien** : ni message en échec côté passerelle,
ni ligne d'erreur côté Tracky. Voir [TRK-017](#trk-017).

> Ce n'est pas un canal dégradé, c'est un canal absent — et c'est le **dernier recours** du
> coupe-circuit, celui qu'on utilise précisément quand le boîtier ne répond pas sur TCP. Or
> [TRK-014](#trk-014) a établi qu'il ne répond **jamais**.

**Ce que l'épisode apprend sur la méthode.** La ligne qui a tout révélé est celle d'un garde-fou
écrit le 27/07 pour ce défaut exact. Il a fallu treize jours pour qu'elle apparaisse — et l'enquête
ne peut pas dire si c'est parce que le trou vient de se former ou parce que le garde-fou ne tourne
pas à la cadence déclarée. Les deux lectures mènent à des correctifs opposés. **Un test daté les
sépare sans écrire une ligne de code** : relire `createdAt` des entrées demain. C'est écrit dans la
fiche, avec sa condition d'échec.

> ### 🔄 Suite — 2ᵉ passage du même jour, 17:12 UTC : le test daté a tranché, et il renverse la lecture
>
> Passage supplémentaire demandé par le propriétaire, seize heures après le premier. Le test posé
> pour le 11/08 a été exécuté avec de l'avance, et **la lecture A est écartée** : la réconciliation
> tourne parfaitement — six exécutions de plus dans la journée, toutes `+25 / -0`. Ce ne sont pas
> les numéros qui manquaient depuis treize jours, ce sont les entrées qui **sont effacées en bloc
> et recréées** au h:25 suivant. **Au moins six réouvertures du trou en 19 h**, chacune jusqu'à
> 60 minutes.
>
> Six pistes d'attribution ont été fermées (synchro Tracky, route d'admin, 2ᵉ instance,
> `vizyo-manager`, ménage programmé, tenant concurrent) — et **aucun instrument en place ne peut
> nommer l'appelant** : pas de journal d'accès au proxy, pas de table de requêtes dans la
> passerelle, `docker logs` du relais muet, point d'entrée exposé publiquement. C'est ce vide-là,
> et non le compteur, qui devient le correctif nº 0.
>
> **La leçon de méthode est double.** D'abord : *refuser de trancher a payé* — un correctif choisi
> le 09/08 aurait supervisé un cron qui tournait déjà. Ensuite : *une absence de ligne ne se lit
> pas seule.* « Aucune ligne entre le 27/07 et le 09/08 » avait été lu comme « le trou durait
> depuis treize jours » ; en régime B, la même absence signifie exactement l'inverse — **rien ne
> manquait**. Le fait était juste, l'inférence était retournable. Voir [le rapport du 2ᵉ passage](./rapports/2026-08-10-passe-2.md).

Et un second épisode **en rafale** de [TRK-015](#trk-015), sur un autre véhicule que celui du 08/08 :
GS-014-NY perd 21 minutes de trajet (entrée à 15 km/h, sortie à 130 km/h), 60 trames tamponnées
écartées. Le mécanisme n'était pas propre à HD-779-MA.

**Piège d'outillage :** `docker logs texto-relay` ne rend jamais la main sur cet hôte (deux essais,
sortie vide). Aucune conclusion de ce passage ne s'appuie sur des journaux de conteneur. *Un journal
illisible n'est pas un journal vide.*

---

## 🔎 2026-08-09 — le test daté passe, et deux pertes silencieuses se révèlent

Le rapport du 08/08 avait posé un test vérifiable à date : l'épisode GPS ouvert sur FZ-862-VY
devait franchir le plafond de 24 h vers le 08/08 09:07 UTC. **L'alerte est arrivée à 09:10:15**, au
premier tick suivant l'échéance. C'est la première vérification de [TRK-011](#trk-011) sur un
épisode **neuf** — le mécanisme tient sur un cas indépendant, pas seulement sur les deux véhicules
suivis depuis cinq jours.

> Un audit qui écrit un test daté et sa condition d'échec obtient une réponse. Celui qui écrit
> « à surveiller » n'obtient rien.

Derrière ce calme, deux pertes qui ne produisent aucune ligne :

1. **Une coupure réseau de 6 h 17 sur HD-779-MA a fait rejeter 1643 positions tamponnées d'un seul
   bloc.** Le trou est prouvé en base — aucune position entre 07/08 23:00 et 08/08 05:16, alors que
   le véhicule roulait à 87 km/h en y entrant et à 127 km/h en en sortant. [TRK-015](#trk-015)
   décrivait une perte diffuse ; elle est aussi **en rafale**. Et le boîtier concerné est celui
   dont l'incident de téléportation de juin a motivé l'écriture du garde-fou.
2. **89,8 % des trajets du 08/08 s'affichent en trace brute** : le recalage cartographique échoue
   depuis avril (80,7 % sur 12 462 trajets). Voir [TRK-016](#trk-016).

**Et le remède d'outillage d'hier était faux.** Le 08/08 avait établi que `docker logs --since`
ment sur ce conteneur, et recommandait `--tail N`. Mesuré ce jour : `--tail 200000` renvoie
3714 lignes s'arrêtant **79 minutes avant l'heure courante**, quand `--tail 3` donne la seconde.
Ce qui survit est la règle générale, pas le remède particulier : *citer le premier et le dernier
horodatage réellement observés*. C'est elle qui a attrapé ce piège-ci.

---

## 🔎 2026-08-08 — le centre d'alerte est muet pour la première fois, et 3466 positions manquent

Zéro ligne `error_logs` en 24 h — jamais vu depuis l'amorçage. Vérifié avant de s'en réjouir : le
détecteur GPS tourne, il a enregistré deux nouveaux épisodes le 07/08, les crons de commandes ont
créé et soldé 74 commandes. Le capteur n'est pas éteint : **les deux pertes GPS ouvertes depuis
quatre nuits se sont refermées**, et il n'y avait plus rien à rappeler.

Pendant ce temps, une perte de données tournait sans produire une seule alerte. Le garde-fou
d'ingestion — écrit pour empêcher la téléportation (incident HD-779-MA du 10-11/06) — a écarté
**8360 trames en 4 jours sur les 37 boîtiers du parc**. Sur ces 8360, **3466 n'ont aucune position
à ± 60 s dans la base** : ce sont des trous, pas des doublons. Voir [TRK-015](#trk-015).

> Dans la **même** classe de rejet, un tiers des trames sont des fantômes prouvés et la moitié
> sont des trous prouvés. Un critère unique ne peut pas être juste pour les deux — et c'est la
> donnée qui le dit, pas le raisonnement.

**Et un piège d'outillage qui invalide une méthode de mesure :** `docker logs --since 26h` a
renvoyé 205 lignes **se terminant 25 h avant l'heure courante**, quand `--tail 5` renvoyait des
lignes de la minute (`json-file`, `max-size=10m`, `max-file=3` — `--since` traverse mal les
fichiers tournés). Toute affirmation tirée des journaux doit désormais citer le **premier et le
dernier horodatage réellement observés**, jamais la fenêtre demandée. *Le « 62 auto-alignements en
24 h » du 06/08 était vraisemblablement une tranche plus courte : la conclusion tient (aucune
valeur sous 20 s, confirmée à nouveau ce jour sur 29 mesures), le libellé de fenêtre non.*

---

## 🔎 2026-08-07 — 3797 commandes depuis avril, pas un seul accusé de réception

Le journal de trames (`wire_logs`) tranche la question que TRK-012 laissait ouverte. Sur 4 jours :
**275 commandes `fix…***n123456` envoyées à 35 boîtiers, et aucune trame entrante contenant
« ok », « fix », « error » ou « password ».** Le boîtier ne répond rien.

Et personne n'écouterait de toute façon : le chemin adaptatif écrit `SENT` puis passe à la suite,
sans jamais armer `waitForAck` — alors que le catalogue définit bien un motif d'ACK pour
`fix_continuous`. `ackedAt` est **NULL sur les 3797 commandes** émises depuis le 2026-04-27, tous
templates confondus. Voir [TRK-014](#trk-014).

> Une chaîne de commande qui n'a jamais reçu de réponse en trois mois n'est pas « peu fiable ».
> Le savoir change ce qu'on peut conclure de chaque échec en aval.

**Et deux fiches disaient faux — vérifiées sur le code, pas recopiées :**

1. **TRK-007** affirmait qu'il n'existe pas d'`expectedAckPattern` pour `fix_continuous`. Le
   catalogue en définit un (`coban.catalog.ts:177`, `/fix.*ok/i`, 15 s). Ce qui manque est
   l'appel, pas le motif.
2. **TRK-008** portait une réserve sur un chemin d'écriture « non borné, plancher à 1 s ». Il est
   borné à 20 s depuis V1.19 (`tracker-fix-mode.service.ts:67`). Ce qui a induit la réserve en
   erreur est un **commentaire périmé** laissé en place aux lignes 473-478, qui annonce encore le
   comportement d'avant le correctif. *Un commentaire périmé fabrique un faux constat aussi
   sûrement qu'un bug.*

---

## 🔎 2026-08-06 — le correctif de TRK-007 marche, et il fabrique un message faux

Première fenêtre de **28 h sans redémarrage** depuis le correctif (`restarts=0` depuis le 04/08
21:32 UTC) : la comparaison porte enfin sur une journée pleine. Tout tient — 0 commande en
attente, 0 cible sous le minimum matériel, et cette fois vérifié **sur les journaux** et pas
seulement sur un instantané : 62 auto-alignements en 24 h, aucun sous 20 s.

Mais le balayage qui solde les commandes **clôt tout en `FAILED`, sans jamais comparer**. Trois
clôtures sur dix-sept annoncent « sans effet constaté : cadence réelle 20 s pour une cible de
20 s » — l'intervalle demandé est exactement celui observé. Voir [TRK-013](#trk-013).

> Un correctif qui solde correctement une file d'attente peut, dans le même geste, remplir le
> journal d'échecs qui ne sont pas des échecs. Le compteur ainsi gonflé est **celui qui sert à
> juger les autres fiches**.

Et une fiche disait faux : TRK-011 annonçait une dédup « par épisode ». Elle est **par 24 h**
(`alerts.service.ts:156`, fenêtre documentée). Les deux lignes des dernières 24 h sont donc des
rappels quotidiens sur des épisodes déjà connus, pas des doublons — un audit qui aurait cru la
fiche aurait enquêté pour rien.

---

## 🔎 2026-08-05 — les correctifs tiennent, mais TRK-008 se trompait sur 90 % de son volume

Vérifié en production 3 h 40 après le déploiement (conteneurs recréés le 04/08 à 21:30 UTC,
`restarts=0`) : **plus aucune cible sous le minimum matériel**, **plus aucune commande en
attente**, et le plafond de silence GPS a produit **ses deux premières alertes**. Les correctifs
de la nuit font ce qu'ils annonçaient.

**Et pourtant le volume d'échecs de commandes n'a pas bougé d'une ligne** — 14 échecs sur la
fenêtre 21:30 → 01:10, exactement comme la veille, sur les mêmes six boîtiers, à 9 millisecondes
près sur l'horodatage.

Parce que la cause n'était pas celle qu'on croyait. TRK-008 attribuait ses 295 échecs
« intervalle observe: 20 s » à une cible descendue sous le minimum matériel. **281 de ces 291
échecs demandaient en réalité 300 s** (`params.interval = '005m'`) — une consigne parfaitement
légitime. Le correctif ne pouvait donc pas les faire disparaître. Voir [TRK-012](#trk-012).

> Une cause racine se vérifie sur la **donnée de la commande**, pas sur la vraisemblance du récit.
> Le récit de TRK-008 était cohérent, documenté, et il expliquait 10 % des cas.

---

## 🟢 2026-08-04 — les neuf fiches ouvertes ont été corrigées et déployées

Livré en production le 2026-08-04 (PR #86, `f7896d9`, smoke-boot OK, `restarts=0`). Le fil
commun n'était pas « des bugs » : **le centre d'alerte ne disait pas la vérité — il criait
pour des non-fautes, et se taisait sur de vraies pannes.**

| Fiche | Ce qui a été livré |
|---|---|
| **TRK-011** | Plafond de silence de 24 h sur une zone bénigne. Le forçage est explicite : une zone confirmée est aussi « recognized », donc sans lui le dépassement n'aurait produit **aucune** ligne. |
| **TRK-008** | Cible clampée **à la lecture** (valeurs héritées neutralisées sans migration) · émettre plus vite **en mouvement** n'est plus une faute · plancher d'auto-alignement remonté · normalisation des cibles stockées. |
| **TRK-007** | Échéance **purement temporelle** (30 min). La conditionner à un état du boîtier l'aurait fait retomber dans le même piège. |
| **TRK-004** | `ExpectedRefusalException` — marqueur structurel, jamais textuel. Hérite de `ServiceUnavailableException` pour que la réponse HTTP ne bouge pas d'un octet. |
| **TRK-005** | Échec de l'API carburants marqué passager. Le message n'a pas bougé : il était déjà bon. |
| **TRK-003** | CRITICAL exige désormais que ça **dure** (2 min) ou que ça **recommence** (2ᵉ report dans l'heure). |
| **TRK-002** | Garde de visibilité + réessai silencieux à 3 s, sur le chemin proactif. |
| **TRK-009** | Boîtiers jamais mis en service exclus. Une pose ratée (jamais vu **mais** rattaché) reste signalée. |
| **TRK-010** | `ERROR_LOGS_RETENTION_DAYS=90` en production. |

### Vérifié en production, pas seulement en test

- **TRK-007** — le balayage a réellement tourné : *« 3 commande(s) fix_continuous close(s) par
  échéance »*, avec le texte attendu : « Sans effet constaté après 305 min : cadence réelle
  3601 s pour une cible de 20 s. »
- **TRK-008** — `fixCommandFailing` = 0 sur 43 boîtiers, **0 échec** depuis le déploiement.
- **TRK-009** — le compteur « hors ligne » passe de 7 à 4 ; les 3 boîtiers en stock sont écartés.
- **TRK-010** — `ERROR_LOGS_RETENTION_DAYS=90` lu dans l'environnement du conteneur.
- **TRK-011** — le détecteur tourne et **supprime correctement** : FS-253-HR est à 13,3 h,
  sous le plafond de 24 h. C'est le comportement voulu — un stationnement de nuit reste
  silencieux. Le déclenchement réel s'observera au franchissement des 24 h.

### ⚠️ Deux tests verrouillaient l'ancien comportement

Recalibrés, pas supprimés — leur intention restait juste :

1. *« SUPPRIME l'alerte en zone confirmée »* utilisait une perte de **29 h** et verrouillait donc,
   sans le vouloir, le trou de TRK-011. Il teste désormais une perte **courte**.
2. *« auto-aligns desired to a sub-20s interval (V1.15) »* verrouillait le **contournement** qui a
   produit toute la dérive. Remplacé par ce qui traite la cause.

> Si rien ne casse en corrigeant un défaut, se méfier : c'est souvent qu'un test protégeait le bug.

---

## Comment lire une fiche

**Signature** — l'empreinte stable d'une erreur, *après normalisation* (plaques, IMEI, UUID,
durées et nombres remplacés par des jetons). C'est la clé d'identité : deux lignes qui ont la
même signature sont le même problème, même si leurs textes diffèrent.

**Statut** — le seul champ qui décide si on agit :

| Statut | Sens | Ce que fait l'audit |
|---|---|---|
| 🔴 **NON CORRIGÉ** | Défaut réel, aucun correctif livré | Remonte en tête du rapport, propose le correctif |
| 🟠 **CORRECTIF PROPOSÉ** | Cause connue, correctif écrit ici, pas encore livré | Rappelle la proposition, ne ré-enquête pas |
| 🟢 **CORRIGÉ** | Correctif livré ET vérifié en prod | Silencieux — sauf réapparition, qui devient une **régression** (🔴 immédiat) |
| ⚪ **BRUIT ACCEPTÉ** | Pas une faute ; on assume de le voir | Compte, ne propose rien |
| 🔵 **TERRAIN** | Vrai signal, mais l'action est matérielle/métier, pas du code | Liste l'action, n'écrit pas de code |

**Règle absolue** — on ne supprime **jamais** une ligne de `error_logs` tant que le défaut
n'est pas corrigé *et vérifié*. Le centre d'alerte n'est pas une boîte de réception à vider.

---

## Index

| ID | Source | Signature courte | Statut | Vu la 1ʳᵉ fois | Dernière |
|---|---|---|---|---|---|
| [TRK-018](#trk-018) | *coupe-circuit* | Repli SMS : 112 commandes moteur, **0 confirmée**, aucun message jamais sorti de `queued` | 🔴 NON CORRIGÉ | 2026-08-11 | 2026-08-11 |
| [TRK-017](#trk-017) | `sms-allowlist` | Une 2ᵉ instance de Tracky, hors VPS, efface 25 numéros à chaque h:25 avec la clé de PROD — **garde posée, clé NON rotationnée** | 🔴 NON CORRIGÉ *(appelant nommé le 10/08 ; toujours actif, y compris la nuit)* | 2026-08-09 | 2026-08-11 |
| [TRK-016](#trk-016) | *trajets* | Recalage cartographique en échec sur 9 trajets sur 10 | 🔴 NON CORRIGÉ | 2026-08-09 | 2026-08-11 |
| [TRK-015](#trk-015) | *ingestion* | Positions réelles écartées par le garde-fou anti-téléportation | 🔴 NON CORRIGÉ | 2026-08-08 | 2026-08-11 |
| [TRK-014](#trk-014) | *commandes* | Aucun accusé de réception boîtier — silence désormais **PROUVÉ** (écoute armée le 10/08) | 🔴 NON CORRIGÉ *(correctif #1 livré et vérifié ; #2 et #3 ouverts)* | 2026-08-07 | 2026-08-11 |
| [TRK-012](#trk-012) | *commandes* | Cadence d'arrêt (300 s) jamais appliquée, redemandée 2×/jour | 🔴 NON CORRIGÉ *(correctif **suspendu** au test SMS)* | 2026-08-05 | 2026-08-11 |
| [TRK-013](#trk-013) | *commandes* | Clôture par échéance : « sans effet » sans jamais comparer | 🔴 NON CORRIGÉ | 2026-08-06 | 2026-08-11 |
| [TRK-001](#trk-001) | `gps-integrity` | GPS perdu — boîtier vivant sans fix | 🔵 TERRAIN *(espacement des rappels livré le 10/08)* | 2026-07-28 | 2026-08-11 |
| [TRK-002](#trk-002) | `frontend` | Rafraîchissement de session — API injoignable | 🟢 CORRIGÉ *(confirmation à 2 échecs livrée le 10/08 — test daté au 18/08)* | 2026-07-29 | 2026-08-10 |
| [TRK-003](#trk-003) | `realtime-client` | Canal temps réel JAMAIS établi | 🟢 CORRIGÉ | 2026-07-31 | 2026-07-31 |
| [TRK-004](#trk-004) | `http` | Budget IA mensuel atteint (503) | 🟢 CORRIGÉ | 2026-07-29 | 2026-07-29 |
| [TRK-005](#trk-005) | `fuel-station` | API prix carburants injoignable | 🟢 CORRIGÉ | 2026-07-28 | 2026-07-28 |
| [TRK-006](#trk-006) | `frontend` | NG02100 sur `/admin/subscriptions` | 🟢 CORRIGÉ | 2026-07-29 | 2026-07-30 |
| [TRK-007](#trk-007) | *commandes* | `fix_continuous` bloquée en SENT à vie | 🟢 CORRIGÉ *(→ produit TRK-013 · justification rectifiée le 07/08)* | 2026-08-03 | 2026-08-07 |
| [TRK-008](#trk-008) | *commandes* | Cible de cadence sous le minimum matériel | 🟢 CORRIGÉ *(diagnostic rectifié · réserve levée le 07/08)* | 2026-08-03 | 2026-08-07 |
| [TRK-009](#trk-009) | *trackers* | Boîtiers « hors ligne » jamais mis en service | 🟢 CORRIGÉ | 2026-08-03 | 2026-08-04 |
| [TRK-010](#trk-010) | *plateforme* | La rétention efface les erreurs non corrigées | 🟢 CORRIGÉ | 2026-08-03 | 2026-08-04 |
| [TRK-011](#trk-011) | `gps-integrity` | Zone bénigne = silence GPS **sans borne de durée** | 🟢 CORRIGÉ *(test daté vérifié sur un épisode neuf le 09/08)* | 2026-08-04 | 2026-08-09 |

> ⚠️ **Les en-têtes de fiche ci-dessous portent le statut du jour où la fiche a été écrite.**
> Neuf d'entre elles ont été corrigées le 2026-08-04 sans que leur en-tête soit repris — remis à
> jour le 2026-08-06. **En cas de doute, l'index ci-dessus fait foi.**

---

## TRK-001

**Signature** — `gps-integrity | ERROR | GPS perdu : <PLAQUE> (<IMEI>) — boîtier vivant mais sans position GPS depuis <DURÉE>. Antenne à vérifier.`
**Statut : 🔵 TERRAIN** · 5 occurrences · 3 véhicules · 2026-07-28 → 2026-08-03

### Ce que ça veut dire
Le boîtier Coban parle (`lastSeenAt` frais, trames `no_fix` LBS) mais n'a plus de verrou GPS :
la dernière position reste figée. Détecté par `gps-integrity.service.ts`.

### Ce n'est pas un bug
Le détecteur fait exactement son travail, et il est déjà bien borné :
- une zone morte confirmée bénigne (parking souterrain) **éteint** l'alerte (`CONFIRMED_BENIGN`) ;
- une zone récurrente non suspecte ne remonte **pas** au centre admin, seulement à l'alerte flotte ;
- `createGpsLostAlert` déduplique **par épisode** — une seule ligne par perte, pas une par tick.

### État constaté le 2026-08-03
| IMEI | Plaque | Verdict |
|---|---|---|
| `864035054756102` | FZ-862-VY | **En cours** — dernière position 17:34, `lastNoFixAt` 20:25 → ~3 h sans fix |
| `864035054489449` | HD-779-MA | Reparti (position fraîche) |
| `864035053277480` | KSR370 | Reparti (position fraîche) — 3 épisodes distincts en 3 jours |

### Mise à jour du 2026-08-04
`FZ-862-VY` est **toujours sans fix : 7,4 h** (contre ~3 h la veille). L'épisode dure, il n'est
pas clos.

⚠️ **Et il ne réalertera plus.** Sa zone morte (`879699a3…`, parking souterrain, Toulouse) a été
**confirmée bénigne le 03/08 à 19:36**, une minute après l'alerte. Le détecteur cesse donc
d'alerter pour ce véhicule à cet endroit, **quelle que soit la durée de la perte** — voir
[TRK-011](#trk-011). Le suivi de cette antenne repose désormais sur les rapports d'audit, plus
sur le centre d'alerte.

### Mise à jour du 2026-08-05 — deux épisodes toujours ouverts, et désormais visibles

| IMEI | Plaque | Sans position depuis | Boîtier |
|---|---|---|---|
| `864035054757027` | **FS-253-HR** | **36,1 h** (dernière position 03/08 13:02) | vivant, trames à la minute |
| `864035054756102` | **FZ-862-VY** | **31,6 h** (dernière position 03/08 17:34) | vivant, trames à la minute |

Ces deux véhicules ont **enfin alerté** — le plafond de silence de [TRK-011](#trk-011) a produit
ses deux premières lignes (à 24 h et 26 h). Ils n'étaient plus détectables autrement.

`FW-298-WV` (`864035054756714`) a perdu son fix 2 h le 04/08 et **est reparti** : il n'apparaît
plus dans `gps_sans_fix`. Rien à faire — et c'est la preuve que l'alerte ordinaire fonctionne
toujours à côté du nouveau plafond.

### Mise à jour du 2026-08-06 — troisième nuit, les deux épisodes s'allongent

| IMEI | Plaque | Sans position depuis | La veille |
|---|---|---|---|
| `864035054757027` | **FS-253-HR** | **60,1 h** | 36,1 h |
| `864035054756102` | **FZ-862-VY** | **55,6 h** | 31,6 h |

Mêmes épisodes : `lastPositionAt` n'a pas bougé (03/08 13:02 et 03/08 17:34). Les deux boîtiers
émettent toujours des trames à la minute — c'est l'antenne, pas le réseau.

Chacun a produit **une seconde ligne**, 24 h après la première : c'est le rappel quotidien de la
fenêtre de dédup (voir la rectification en tête de [TRK-011](#trk-011)), pas un nouvel épisode.
Tant que l'antenne n'est pas vérifiée, comptez **une ligne par véhicule et par jour**.

### Mise à jour du 2026-08-07 — quatrième nuit

| IMEI | Plaque | Sans position depuis | La veille |
|---|---|---|---|
| `864035054757027` | **FS-253-HR** | **84,1 h** | 60,1 h |
| `864035054756102` | **FZ-862-VY** | **79,6 h** | 55,6 h |

Mêmes épisodes, `lastPositionAt` toujours figé au 03/08 (13:02 et 17:34). Une ligne par véhicule
et par jour, comme prévu par la fenêtre de dédup. Rien de nouveau à diagnostiquer : ce qui manque
est une intervention.

### ✅ Mise à jour du 2026-08-08 — les deux épisodes sont CLOS

| IMEI | Plaque | État au 08/08 01:13 UTC |
|---|---|---|
| `864035054757027` | **FS-253-HR** | **position fraîche** (01:13:40) — l'épisode du 03/08 13:02 est terminé |
| `864035054756102` | **FZ-862-VY** | position reprise le 07/08 09:07 — puis **reperdue** : nouvel épisode, **16,1 h** |

C'est ce qui explique le **zéro absolu** de `error_logs` sur 24 h : il n'y avait plus de rappel
quotidien à produire. FS-253-HR a même connu un **nouvel** épisode court le 07/08 à 13:50, déjà
résolu — silencieux à raison (zone bénigne, sous le plafond).

Le nouvel épisode de FZ-862-VY est également silencieux **à raison** : 16,1 h < 24 h.
Il franchira le plafond vers **08/08 09:07 UTC**. Une alerte est attendue dans la journée —
**si elle ne vient pas, c'est une régression de [TRK-011](#trk-011)**, et ce test tombe bien : il
vérifie le plafond sur un épisode neuf plutôt que sur les deux mêmes véhicules depuis cinq jours.

⚠️ **Un épisode clos ne vaut pas antenne réparée.** FZ-862-VY a repris une position puis l'a
reperdue en quelques minutes ; FS-253-HR a rouvert un épisode le lendemain. Le comportement reste
celui d'une antenne défaillante par intermittence. Le contrôle terrain reste à faire.

### Mise à jour du 2026-08-09 — l'épisode de FZ-862-VY dure, et il alerte

| IMEI | Plaque | Sans position depuis | Épisode ouvert le |
|---|---|---|---|
| `864035054756102` | **FZ-862-VY** | **40,1 h** | 07/08 09:07 |

FS-253-HR n'apparaît plus dans `gps_sans_fix` : son épisode du 07/08 13:50 s'est refermé. Un seul
boîtier vivant sans fix ce jour, contre deux les jours précédents.

L'épisode de FZ-862-VY a franchi le plafond de 24 h le 08/08 à 09:10 et produit sa ligne — voir
[TRK-011](#trk-011), dont c'est la première vérification sur un épisode neuf. Rappel quotidien
attendu tant que la perte dure.

### Mise à jour du 2026-08-10 — l'épisode entre dans sa quatrième journée

| IMEI | Plaque | Sans position depuis | Épisode ouvert le |
|---|---|---|---|
| `864035054756102` | **FZ-862-VY** | **64,1 h** | 07/08 09:07 |

Seul boîtier vivant sans fix, deuxième jour de suite. Le rappel quotidien attendu a bien été produit
le 09/08 à 09:15 (« sans position depuis 2 j ») : le plafond de [TRK-011](#trk-011) tient sur un
troisième rappel consécutif. Prochain rappel attendu vers le **10/08 09:15**.

⚠️ Rien de nouveau à diagnostiquer, et c'est le problème : cette antenne est signalée depuis le
03/08 et n'a toujours pas été touchée. Ce que la plateforme sait faire, elle le fait ; ce qui manque
est une intervention.

### Action
**Terrain, pas code.** Antennes GPS à vérifier sur **FS-253-HR** et **FZ-862-VY** — les deux longs
épisodes se sont refermés au bout de ~4 jours, mais les deux véhicules **reperdent leur fix dans
la journée** : c'est une antenne intermittente, pas une panne résolue. KSR370 récidive
(3 épisodes en 3 jours) → candidat au même contrôle.

### ⚠️ Ne pas « corriger » en silenciant
Ce détecteur a été explicitement mis hors périmètre de la passe du 2026-07-27 : c'est un vrai
signal matériel. Baisser son niveau ou élargir sa dédup ferait disparaître la seule chose qui
rende visible une antenne morte. *Corriger un message ≠ affaiblir une garde.*

---

### ✅ 2026-08-10 19:39 UTC — correctif DÉPLOYÉ *(l'en-tête ci-dessous disait « non déployé » : périmé le soir même)*

Le rappel quotidien sans fin est corrigé — livré sur `main` @ `d5e5fb1`, en production depuis le
10/08 19:39 UTC (vérifié sur `main`, pas sur la note du passage précédent). Les rappels au centre
d'alerte s'ESPACENT avec l'âge de l'épisode (quotidien les 2 premiers jours, puis hebdomadaire,
puis mensuel).

**Première mesure, 2026-08-11 :** aucune ligne `gps-integrity` depuis le 10/08 09:20, alors que
l'épisode de FZ-862-VY dure toujours (5ᵉ jour). L'espacement s'applique.
🗓️ **Test daté au 12/08** : l'épisode ayant plus de 4 jours, la cadence doit être **hebdomadaire** —
**aucune ligne attendue le 11/08 vers 09:20**. Si un rappel quotidien réapparaît, l'espacement n'a
pas pris.

### Mise à jour du 2026-08-11 — l'épisode entre dans sa cinquième journée, et un second rouvre

| IMEI | Plaque | Sans position depuis | Épisode ouvert le | Alerte ? |
|---|---|---|---|---|
| `864035054756102` | **FZ-862-VY** | **88,1 h** | 07/08 09:07 | rappels espacés (voir ci-dessus) |
| `864035054757027` | **FS-253-HR** | **10,1 h** | 10/08 15:03 | **silencieux à raison** — sous le plafond de 24 h |

FS-253-HR rouvre un épisode cinq jours après le précédent : le profil « antenne intermittente »
décrit le 08/08 se confirme sur un quatrième cycle. Son silence est le comportement voulu
([TRK-011](#trk-011)) — un stationnement de nuit ne doit pas crier.

⚠️ Ces deux véhicules sont aussi ceux dont les commandes de coupure moteur restent `SENT` sans
confirmation possible : sans fix GPS, la chute d'ignition qui sert d'accusé de réception n'est pas
observable. Voir [TRK-018](#trk-018) — même cause matérielle, vue depuis une autre table.

### ~~✍️ 2026-08-10 (soir) — correctif ÉCRIT, pas encore déployé~~ *(périmé, voir ci-dessus)*

⚠️ Ce qui n'est pas touché : l'alerte FLOTTE garde sa cadence quotidienne — c'est le canal de
l'exploitant, et l'acquitter la fait taire. Et le rappel ne devient **jamais** muet : un épisode
d'un an produit encore une ligne par mois. Rendre le silence infini serait rouvrir exactement le
trou de [TRK-011](#trk-011), où une zone confirmée bénigne éteignait l'alerte sans borne de durée.
*On corrige le cri, pas le garde-fou.* 4 tests ajoutés, dont un qui vérifie que le rappel ne
s'éteint pas.


## TRK-002

**Signature** — `frontend | ERROR | [api-fetch] Error: Rafraichissement de session — API injoignable : TypeError: <TYPE>`
(`<TYPE>` = `Load failed` sur Safari/iOS, `Failed to fetch` sur Chrome — même défaut)
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 2 occurrences · 2026-07-29 → 2026-08-03
*(Aucune nouvelle occurrence depuis le correctif. Les 2 lignes restantes lui sont antérieures.)*

### Chaîne d'appel
`auth.service.ts` → `scheduleProactiveRefresh()` arme un `setTimeout` **~60 s avant l'expiration**
du token → `proactiveTick()` → `doRefresh()` → `apiFetchRaw('/api/auth/refresh', …, 'Rafraichissement de session')`
→ `api-fetch.ts` rattrape l'échec réseau et appelle `reportClientError('api-fetch', …)`.

### Cause racine
Un minuteur `setTimeout` est **gelé** quand l'onglet passe en arrière-plan ou que l'appareil
dort, puis **tiré au réveil** — c'est-à-dire à l'instant précis où la connectivité n'est pas
encore rétablie. Le rafraîchissement part dans le vide et échoue au niveau transport.

La garde censée filtrer ça ne filtre rien :

```ts
// api-fetch.ts
if (typeof navigator === 'undefined' || navigator.onLine !== false) {
  reportClientError('api-fetch', new Error(`${label} — API injoignable : ${describe(err)}`));
}
```

`navigator.onLine` dit seulement « une interface réseau est active » — il vaut `true` sur un
iPhone qui vient de se réveiller et n'a pas encore de route utilisable. La condition est donc
vraie, et on archive une ERREUR pour un hoquet que personne ne peut corriger.

### Preuves
- Les deux occurrences portent des UA distincts (iPhone iOS 18.7 / Chrome Windows) — donc pas
  un bug de navigateur, un défaut de conception du report.
- `TypeError: Load failed` est la signature Safari d'une requête **tuée**, pas refusée.
- Aucun 5xx correspondant côté serveur au même horodatage : le serveur n'a jamais reçu l'appel.
- La session n'est **pas** perdue pour autant : `doRefresh` pose `_refreshUnavailable` et ne
  déconnecte personne (commentaire explicite dans `auth.service.ts`). L'utilisateur ne voit rien.

### Correctif proposé
1. **Réessayer une fois avant de crier.** Sur échec *transport* du refresh **proactif**
   (pas celui déclenché par un 401 dans l'interceptor), attendre ~3 s et retenter. Ne remonter
   qu'au second échec. Un réveil d'appareil se résorbe en bien moins que ça.
2. **Reprendre la garde de visibilité qui existe déjà et qui marche.**
   `realtime.service.ts` fait exactement ce qu'il faut :
   `if (typeof document !== 'undefined' && !this.visibility.isVisible()) return;`
   — appliquer la même condition avant `reportClientError` dans `api-fetch.ts`.
   ⚠️ **Uniquement sur le chemin proactif** : une panne réelle vécue au premier plan doit
   continuer à remonter, c'est la raison d'être de ce module.

### Comment vérifier après correctif
Aucune nouvelle ligne de cette signature sur 7 jours, **alors qu'une vraie coupure d'API
(redéploiement) continue d'en produire**. Le second point est le vrai test : un correctif qui
supprime les deux cas a rendu le module inutile.

---

### ✅ 2026-08-10 19:39 UTC — correctif DÉPLOYÉ *(la note ci-dessous disait « non déployé » : périmée le soir même)*

« Confirmer avant de crier » : un échec de transport ISOLÉ ne remonte plus. Il faut **deux échecs
consécutifs**, le compteur étant remis à zéro dès qu'une requête aboutit. Le cas visé est le
hoquet mobile (tunnel, bascule wifi/4G, changement de cellule) que `navigator.onLine` ne voit pas
et que la garde « page cachée » ne couvre pas — encore une ligne le 10/08 sur `/map` depuis un
iPhone. **Livré sur `main` @ `d5e5fb1`**, image `tracky-web` reconstruite le 10/08 à 19:38 UTC
(`consecutiveTransportFailures` vérifié présent dans `api-fetch.ts` sur `main`).

🗓️ **Test daté au 2026-08-18** : zéro ligne de cette signature sur 7 jours **alors qu'une vraie
coupure d'API (redéploiement) continue d'en produire**. *Condition d'échec : si aucune ligne
n'apparaît jamais, y compris pendant un redéploiement, le correctif a supprimé le signal et pas le
bruit — et le module est devenu inutile.*

### ~~✍️ 2026-08-10 (soir) — correctif ÉCRIT, pas encore déployé~~ *(périmé, voir ci-dessus)*

⚠️ Le signal survit : une API réellement tombée enchaîne des dizaines d'échecs en une fraction de
seconde, donc elle parle en quelques secondes — et le canal temps réel a par ailleurs son propre
détecteur indépendant ([TRK-003](#trk-003)). Ce qui disparaît est uniquement le hoquet unique.
19 tests au vert, dont trois neufs sur la confirmation et la remise à zéro.

⚠️ Piège rencontré en écrivant les tests : `reportClientError` déduplique un message identique
sur **15 s**, avec un état au niveau du MODULE que rien ne réinitialise entre deux tests. Deux
tests utilisant le même libellé se masquaient l'un l'autre — un test peut ainsi passer au vert
pour une raison qui n'a rien à voir avec ce qu'il croit vérifier.


## TRK-003

**Signature** — `realtime-client | CRITICAL | Canal temps réel JAMAIS établi (<DURÉE>s) — API/WS injoignable — reason=<R>, transport=<T>, flaps=<N>, err=<E>`
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 1 occurrence · 2026-07-31 13:00
*(Aucune nouvelle occurrence. La ligne CRITICAL encore visible au centre d'alerte lui est antérieure.)*

### Contexte
`realtime-incident.controller.ts` force le niveau **CRITICAL** dès que `everConnected === false` :

```ts
const level = neverConnected || (body.downMs ?? 0) >= 120_000 ? 'CRITICAL' : 'ERROR';
```

L'occurrence relevée : `downMs=45001`, `flaps=0`, `transport=websocket`, `err=timeout`, sur `/map`.

### Ce qui est déjà correct — et qu'il ne faut pas défaire
Le client **ne remonte pas** en arrière-plan (`armIncidentTimer` + `reportRealtimeIncident`
vérifient `visibility.isVisible()`). Donc contrairement au faux positif « onglet en arrière-plan »
connu, **cet incident a bien été vécu au premier plan** : quelqu'un a regardé une carte sans live
pendant 45 s. Le signal est réel.

### Cause probable
Charge VPS. `redis-io.adapter.ts` documente déjà que sous 2 vCPU l'API rate un pong et que
« tous les incidents tombent pile à 45 s » — ce qui est exactement la valeur observée
(`INCIDENT_DELAY_MS`).

### Correctif proposé
Nuancer le niveau, sans supprimer l'alerte. Un premier chargement de page qui met 45 s à établir
son WebSocket n'est pas du même ordre qu'une plateforme injoignable :

- **CRITICAL** si `everConnected === false` **et** (`downMs ≥ 120 s` **ou** au moins un second
  report pour la même flotte dans la fenêtre de dédup) ;
- **ERROR** sinon.

Le corps du message conserve `everConnected` — l'information n'est pas perdue, seul le cri baisse.

### Seuil de ré-escalade
Si cette signature dépasse **3 occurrences sur 24 h**, ce n'est plus un aléa : c'est la charge
VPS, et le sujet devient le dimensionnement (voir la piste « offline = TCP / VPS 2 vCPU saturé »).

---

## TRK-004

**Signature** — `http | ERROR | Le budget IA mensuel est atteint. L'analyse sera de nouveau possible le mois prochain, ou après relèvement du budget.` (`statusCode: 503`)
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 1 occurrence · 2026-07-29

### Cause racine — une décision volontaire journalisée comme une faute
`place-analysis.service.ts` protège la dépense IA en levant un refus explicite :

```ts
if (await this.monthBudgetExhausted()) {
  throw new ServiceUnavailableException("Le budget IA mensuel est atteint. …");
}
```

`ServiceUnavailableException` porte un **503**. Et `all-exceptions.filter.ts` archive tout ce qui
est ≥ 500 :

```ts
if ((status >= 500 || !(exception instanceof HttpException)) && !isUpstreamThrottle(exception)) {
```

Le filtre sait déjà distinguer un 5xx *volontaire* (→ `ERROR`) d'un crash (→ `CRITICAL`)… mais il
**archive les deux**. Résultat : la gouvernance IA qui fonctionne parfaitement — le plafond tient,
l'utilisateur est prévenu — produit une erreur au centre d'alerte. Un plafond atteint n'est pas
une panne.

### Portée réelle (plus large qu'une ligne)
Le **même** défaut existe 6 lignes plus haut dans le même fichier : la porte
« l'assistance IA est désactivée pour cette société » lève aussi un 503. Elle n'a pas encore
produit de ligne, mais elle le fera. Tout refus métier habillé en 5xx est concerné.

### Correctif proposé
Reprendre **exactement** le patron qui existe déjà et qui a fait ses preuves — `isUpstreamThrottle()`
dans le même filtre, ajouté après l'incident des ~100 fausses CRITICAL au redéploiement du
2026-07-15 :

1. Ajouter une garde `isExpectedRefusal(exception)` dans `all-exceptions.filter.ts`, sur le
   modèle de `isUpstreamThrottle`, qui exclut de l'archivage les refus délibérés.
2. **Structurel, pas textuel.** Reconnaître le message serait fragile et attraperait des refus
   légitimes au passage — c'est le raisonnement déjà écrit en tête de `error-logger.service.ts`
   pour `isTransient`. Faire porter à l'exception une propriété (`expected: true`), posée par une
   `AiBudgetExhaustedException` / `AiDisabledException` dédiée.
3. La réponse HTTP au client **ne change pas** : seule la journalisation disparaît.

### Alternative envisagée puis écartée
Passer ces refus en 4xx (402 / 429) supprimerait le symptôme sans toucher au filtre. Écarté :
le front distingue déjà « API en panne » (5xx) de « refusé » (4xx) sur d'autres chemins, et
`auth.service.ts` s'appuie explicitement sur `status >= 500` pour décider de **ne pas déconnecter**.
Déplacer un statut a des effets à distance ; ajouter une garde n'en a pas.

---

## TRK-005

**Signature** — `fuel-station | ERROR | Passages en station non détectés : API publique des prix carburants injoignable sur <N> arrêt(s) — aucun plein n'est affirmé sur ce trajet, le reste de l'analyse est conservé. Cause : <CAUSE>`
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 1 occurrence · 2026-07-28

### Le message est bon
Il nomme la dépendance, la conséquence exacte (« aucun plein affirmé ») et ce qui est préservé
(« le reste de l'analyse est conservé »). C'est le résultat de la passe du 2026-07-27 sur les
messages bruts, et il faut le garder tel quel.

### Ce qui reste à corriger, c'est le classement
`This operation was aborted` = timeout d'une **API publique tierce** (prix carburants). Ni un bug
Tracky, ni une action à mener. C'est exactement la définition du contrat `transient` déjà posé
dans `error-logger.service.ts` — et déjà appliqué au 400 IA « Grammar compilation timed out »,
classé aléa fournisseur.

### Correctif proposé
Marquer cet échec `transient: true` à la levée → journalisé dans le conteneur, **non archivé**.
Le garde-fou existe déjà en aval : `error-rate-watchdog` réagit à un taux d'échec anormal, donc
une vraie panne durable de l'API carburants reste détectable sans polluer le centre au coup par coup.

### ⚠️ Piège
Ne pas reconnaître « aborted » dans le texte. Le contrat est **structurel** (une propriété sur
l'erreur), volontairement, pour la raison écrite en tête de `error-logger.service.ts`.

---

## TRK-006

**Signature** — `frontend | ERROR | [uncaught] Error: NG02100` · page `/admin/subscriptions`
**Statut : 🟢 CORRIGÉ** · 2 occurrences · 2026-07-29 et 2026-07-30

### Cause racine
NG02100 = `InvalidPipeArgument`. `admin-subscriptions.component.ts` demande explicitement la
locale française à deux endroits :

```html
{{ totalRevenueYear() | number : '1.0-0' : 'fr' }}
```

Angular n'embarque que `en-US`. Sans `registerLocaleData(localeFr)`, `formatNumber` lève
« Missing locale data » — que `DecimalPipe.transform` **réemballe** en NG02100. Le premier de ces
deux pipes affiche le **revenu annuel total en haut de page** : l'écran de pilotage commercial
cassait donc à l'affichage.

### Pourquoi rien ne l'a vu
`ng build` ne charge pas les locales et `tsc` ne lit pas les gabarits : l'erreur n'existe qu'à
l'exécution du pipe, sur cette page précise.

### Correctif livré
- `registerLocaleData(localeFr)` dans `main.ts` (commit `bb8c6c1`) ;
- `{ provide: LOCALE_ID, useValue: 'fr' }` dans `app.config.ts` (commit `6d2d57f`) — posé ensuite
  parce que les affichages *sans* locale explicite sortaient en format anglais : l'écran Rapports
  affichait « 27,944.4 km », qu'un francophone lit mille fois plus petit.

### Vérifié en prod le 2026-08-03
Les chunks cités dans les piles archivées (`chunk-L4A3VVAY.js`, `chunk-64WXMCK5.js`) sont
**absents** du bundle servi ; le bundle courant date du 2026-08-03 19:28 et contient bien
`registerLocaleData`. Les 2 lignes restantes sont donc de l'historique — à conserver comme trace,
pas à traiter.

### Régression à surveiller
Toute réapparition de NG02100 = 🔴 immédiat. Deux causes possibles : un nouveau pipe avec une
locale non enregistrée, ou une date non parsable passée à `DatePipe`.

---

## TRK-007

**Signature** — `COMMAND_PENDING | fix_continuous | SENT | acknowledgedAt IS NULL | âge > 10 min`
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · **3 commandes · 2 boîtiers** · 2026-08-03 → 2026-08-04

> ⚠️ **Le correctif tient — et il a créé [TRK-013](#trk-013).** Le balayage solde bien la file
> (0 commande en attente les 05 et 06/08, 6 puis 8 clôtures observées), mais il clôt **tout** en
> `FAILED` sans jamais comparer la cadence obtenue à la cadence demandée. Ne pas défaire
> l'échéance temporelle en voulant corriger cela : c'est la comparaison qui manque, pas la patience.

### Cause racine — aucun chemin automatique ne solde une `fix_continuous`
La commande déclare pourtant comment elle devrait être confirmée :

```ts
expectedResult: `intervalle ~${target}s observe sur les 3 prochaines trames`
```

Mais **rien n'écrit jamais cette observation dans la commande.** Inventaire des écritures de statut :

| Écriture | Fichier | Déclencheur |
|---|---|---|
| `ACKNOWLEDGED` | `tracker-commands.service.ts` | ACK attendu sur le fil — **jamais atteint depuis le chemin adaptatif** *(voir la rectification ci-dessous)* |
| `acknowledgedAt` | `admin-alerts.controller.ts` | **Acquittement manuel** par un admin, uniquement |
| `FAILED` | `positions.service.ts` | Seulement à la **transition** `fixCommandFailing` false→true |

Conclusion : si le boîtier ne bascule jamais FAILING, la commande reste `SENT` **à vie** et
s'affiche indéfiniment au centre d'alerte. C'est le cas ici (3 h et 9 h d'ancienneté).

> ### ⚠️ Rectification du 2026-08-07 — l'`expectedAckPattern` existe
>
> Cette fiche affirmait « jamais pour `fix_continuous` (pas d'`expectedAckPattern`) ». Le
> catalogue en définit un : `coban.catalog.ts:177` → `/fix.*ok/i`, `ackTimeoutMs: 15000`.
>
> Ce qui manque n'est pas le **motif**, c'est l'**appel**. Le chemin adaptatif
> (`tracker-fix-mode.service.ts:647-659`) n'arme jamais `ackWaiter.waitForAck` ; le chemin
> générique (`tracker-commands.service.ts:239-241`), lui, le fait. Voir [TRK-014](#trk-014).
>
> **La conclusion opérationnelle de cette fiche reste juste** — l'échéance doit être purement
> temporelle — mais elle reposait sur une justification fausse. Et si l'on arme l'écoute d'ACK
> (correctif de TRK-014), il ne faut surtout **pas** en reconditionner la clôture : c'est
> exactement le piège que l'échéance temporelle a été écrite pour éviter.

### Défaut aggravant — la colonne « Raison » ment
Le centre d'alerte affiche `outcomeReason`. Or `outcomeReason` est écrit **à la création**
(`tracker-fix-mode.service.ts`), avec le motif du **déclenchement** :

```ts
outcomeReason: reason,   // ex. 'STOPPED_TO_MOVING'
status: TrackerCommandStatus.PENDING,
```

Le nom du champ annonce un résultat, le contenu livre un déclencheur. Un admin lit
`STOPPED_TO_MOVING` comme *la cause du blocage* alors que c'est *la raison de l'envoi*.
C'est la famille « message qui ment » de la passe du 2026-07-27, jamais purgée sur ce chemin.

### Correctif proposé
1. **Solder par échéance.** Toute `fix_continuous` encore `SENT` au-delà d'un plafond
   (2 × `desiredFixIntervalS`, plancher ~15 min) est close en `FAILED` avec `observedResult`
   = l'intervalle réellement observé. Une commande sans ACK doit avoir une fin, sinon la file
   d'attente du centre d'alerte n'est plus une file d'attente.
2. **Afficher ce qui parle du résultat.** Renommer la colonne en « Motif d'envoi », ou afficher
   `diagnosticHint` / `observedResult`, qui décrivent bien l'état constaté.

### ⚠️ Contexte à ne pas perdre
Le Coban n'ACK pas de façon fiable — c'est un fait matériel documenté (Sprint 2 : confirmation
par chute d'ignition faute d'ACK). Le correctif n'est donc **pas** d'attendre un ACK : c'est de
donner une échéance à l'attente.

### Mise à jour du 2026-08-04 — le mécanisme, et pourquoi la transition n'arrivera jamais

**Vérification empirique :** les 2 commandes vues la veille sont **toujours `SENT` 24 h plus
tard** (7 h 40 et 13 h 40 d'ancienneté). Une troisième s'est ajoutée, sur un **second** boîtier.

| Créée le | Boîtier | Plaque | Âge | Motif d'envoi |
|---|---|---|---|---|
| 03/08 21:15 | `864035054756763` | **FZ-731-YF** | 3 h 45 | `STOPPED_TO_MOVING` |
| 03/08 17:20 | `864035052915643` | EY-613-MF | 7 h 40 | `STOPPED_TO_MOVING` |
| 03/08 11:20 | `864035052915643` | EY-613-MF | 13 h 40 | `STOPPED_INTERVAL_ADJUSTED` |

La fiche disait « si le boîtier ne bascule jamais FAILING ». On sait maintenant **pourquoi** il ne
bascule pas : la garde « véhicule garé » (V1.18) de `reconcile()` remet le compteur d'échecs à
**zéro** à chaque trame lente d'un boîtier immobile.

```ts
const movingNow = frame.ignition === true || frame.speedKmh > PARKED_SPEED_KMH;
if (observedS > upper && !movingNow) {
  return { nextCurrentFixIntervalS: observedS, nextFailureCount: 0, nextFailing: false, … };
}
```

Or c'est exactement l'état des deux boîtiers concernés :

| Boîtier | Plaque | Cible | Réel | État |
|---|---|---|---|---|
| `864035054756763` | FZ-731-YF | 20 s | **3601 s** | ONLINE |
| `864035052915643` | EY-613-MF | 20 s | **3600 s** | ONLINE |

~1 trame par heure : le heartbeat Coban ACC OFF, comportement matériel normal. La garde V1.18 fait
donc **correctement** son travail — et, ce faisant, **désarme définitivement le seul chemin
automatique qui pouvait solder la commande**. Les deux gardes sont justes prises séparément ;
c'est leur **composition** qui laisse une commande ouverte pour toujours.

**Conséquence pour le correctif :** l'échéance proposée doit être **purement temporelle**. La
conditionner à un état du boîtier (FAILING, en mouvement, en ligne) la ferait retomber dans le
même piège. Ne pas non plus « corriger » la garde V1.18 : elle empêche un vrai faux positif
(3 véhicules garés déclarés FAILING à tort, prod du 2026-06-15).

---

## TRK-008

**Signature** — `fix_continuous | FAILED | observedResult = "Tracker FAILING — <N> trames non conformes"` — **en volume**
**Statut : 🔴 NON CORRIGÉ** · ~72/jour · 507 sur 7 jours · **3564+ au total** · découvert 2026-08-03 · **en extension**

> ### C'est le point le plus important de cet audit, et le centre d'alerte n'en dit rien.

### Les chiffres (prod, 2026-08-03)
- `fix_continuous` : **3564 en FAILED**, 2 en SENT, 30 acquittées manuellement — *depuis toujours*.
- **506 échecs sur 7 jours**, ~72/jour, tous les jours, sans exception.
- **100 %** portent le même `observedResult` : `Tracker FAILING — 3 trames non conformes`.
- 36 boîtiers concernés, chacun à **exactement 14 commandes / 7 jours = 2 par jour** —
  c'est-à-dire **le plafond anti-flapping** (`FLAPPING_MAX_CHANGES`). Le système tape son quota
  maximum, tous les jours, pour rien.

### Pourquoi c'est invisible
- `fixCommandFailing` vaut **`false` pour les 43 boîtiers** → le centre d'alerte affiche
  « Trackers FAILING : 0 ».
- La requête « commandes en attente » ne regarde que `PENDING`/`SENT` → les 3564 `FAILED` n'y
  sont pas.

**Une panne chronique qui tourne depuis des mois ne produit aucune alerte.** C'est l'exact inverse
du défaut de juillet (des alertes qui ne nommaient pas leur cause) : ici, une cause réelle
ne produit aucune alerte.

### Cause racine — l'auto-alignement écrit une cible que le matériel ne peut pas tenir

Deux chemins écrivent `desiredFixIntervalS`, et **un seul des deux est borné** :

| Chemin | Ce qu'il écrit | Borné ? |
|---|---|---|
| `requestChange()` — la logique adaptative | `Math.min(Math.max(HARD_CAP_MIN_S, desiredS), HARD_CAP_S)` → toujours **20 / 30 / 300 s** | ✅ oui |
| **auto-alignement** (`positions.service.ts`) | l'intervalle **observé brut**, plancher `AUTO_ALIGN_FLOOR_S = 1` | ❌ **non** |

Or `HARD_CAP_MIN_S = 20` **est le minimum officiel du Coban GPS403D**, documenté comme tel dans
le fichier. L'auto-alignement peut donc inscrire comme *cible à faire respecter* une valeur que
le boîtier n'atteindra jamais — et c'est exactement ce qu'on lit en base :

| `desired` (cible) | `current` (réel) | Boîtiers | |
|---|---|---|---|
| **2 s** | 30 s | 2 | 🔴 sous le minimum matériel |
| **4 s** | 5 s | 1 | 🔴 |
| **8 s** | 20 s | 1 | 🔴 |
| 12 s | 21 s | 1 | 🔴 |
| 28 s | 331 s | 1 | |
| 20 / 21 / 19 s | 20 s | 18 | ✅ sain |

Une fois `desired = 12`, la bande de tolérance vaut [9,6 s ; 14,4 s]. Le boîtier émet à sa
cadence normale de 20 s → hors bande → 3 trames → `FAILING`. **Il ne peut plus jamais converger.**

### La boucle
1. `reconcile()` marque `FAILING` (3 trames hors bande, tolérance ±20 %).
2. `positions.service.ts` ferme les commandes `SENT`/`PENDING` en `FAILED`.
3. L'auto-alignement écrit l'observé dans `desired` et remet `fixCommandFailing = false`
   → **plus rien à voir au centre d'alerte**.
4. Le prochain changement d'état (`STOPPED` → `MOVING`) rappelle `requestChange()`, qui réécrit
   20 s… et tout recommence, jusqu'au plafond de 2 commandes/jour.

### Ce que confirme la répartition des échecs
Sur 506 échecs en 7 jours, **295 portent `intervalle observe: 20s`** — c'est-à-dire un boîtier
qui émet **exactement à son minimum matériel** et qu'on déclare pourtant non conforme, parce que
la cible enregistrée est descendue plus bas que ce minimum. Le reste s'échelonne sur 30 s, 21 s,
19 s, 10 s, 5 s, 2 s : la même dérive à différents stades.

### Le défaut de conception, en une phrase
> L'auto-alignement confond **« accepter ce que fait le boîtier »** et **« en faire la cible à
> faire respecter »**. Accepter devrait vouloir dire *arrêter de juger* — pas *juger contre une
> nouvelle valeur*.

### Coût
~72 écritures TCP/jour vers des boîtiers en 2G + 72 lignes DB/jour, pour zéro effet. Et surtout :
**la cadence d'échantillonnage réellement appliquée n'est plus celle décidée**, sans que rien ne
le signale.

### Correctifs proposés
1. **Séparer la cible de l'observé.** `desiredFixIntervalS` est la consigne d'exploitation
   (20 / 30 / 300) ; l'intervalle accepté doit vivre dans un champ distinct
   (`acceptedFixIntervalS`). `reconcile()` juge alors contre l'accepté quand il existe, et
   `requestChange()` reste seul maître de la consigne. C'est le correctif de fond : il supprime
   la boucle sans rien retirer.
2. **Un boîtier « accepté » ne se juge plus.** Plutôt que de réécrire une cible, poser un
   indicateur (« ce boîtier n'honore pas la consigne, on prend ce qu'il donne ») qui **désarme
   le compteur d'échec** au lieu de le relancer contre une nouvelle valeur.
3. **Rendre la boucle visible.** Une famille d'alerte « boîtier qui n'honore jamais sa cadence »,
   fondée sur le **taux de `FAILED` sur 24 h** — et non sur le drapeau `fixCommandFailing`, que
   l'auto-alignement efface avant que quiconque puisse le lire.

### Correctif minimal, si l'on ne veut toucher qu'une ligne
Porter `AUTO_ALIGN_FLOOR_S` de `1` à `HARD_CAP_MIN_S` (20 s) : l'auto-alignement ne pourrait plus
écrire une cible sous le minimum matériel, ce qui élimine à lui seul les cas 2 s / 4 s / 8 s / 12 s.

⚠️ **Mais c'est un retour en arrière partiel, à faire en connaissance de cause.** Ce plancher
*était* à `HARD_CAP_MIN_S` et a été **volontairement abaissé à 1** (V1.15) pour sortir les
boîtiers qui émettent plus vite que demandé (2 s / 10 s) et restaient `FAILING` à vie, incapables
de converger comme de s'aligner. Le remonter les y renverrait. C'est pourquoi le correctif 1 est
préférable : il résout les deux situations au lieu de les échanger.

### Mise à jour du 2026-08-04 — la dérive s'étend, et le plancher descend

| | 2026-08-03 | 2026-08-04 |
|---|---|---|
| Boîtiers à cible < 10 s | 4 | **10** |
| Cible la plus basse | 2 s | **1 s** |
| Échecs / jour | 72 | 72,4 |

| Cible | Réel | Véhicules |
|---|---|---|
| **1 s** | 20 s | FR-428-DQ, FM-772-JH |
| 2 s | 30 s / 8 s | FR-629-AD, FZ-862-VY |
| 3 s | 20 s / 8 s | GT-493-KS, KSR370 |
| 4 s | 19 s | *(boîtier sans véhicule)* |
| 5 s | 20 s | GS-909-NX |
| 8 s | 19 s / 9 s | GS-187-NY, FS-253-HR |

Le volume d'échecs, lui, est d'une régularité qui confirme le plafond anti-flapping : **36
boîtiers × exactement 2 commandes/jour, dix jours de suite** (71–74/jour du 25/07 au 03/08).

> L'important n'est pas que le compteur d'échecs stagne — c'est que **le nombre de boîtiers
> enfermés dans la boucle a plus que doublé en 24 h.** Le défaut ne se stabilise pas, il se
> propage : chaque nouvel épisode d'auto-alignement fait descendre une cible de plus.

L'apparition de cibles à **1 s** rend le correctif minimal (remonter `AUTO_ALIGN_FLOOR_S`) plus
tentant à court terme. Il reste déconseillé pour la raison écrite ci-dessous : il renverrait en
FAILING perpétuel les boîtiers qui émettent plus vite que demandé. Le correctif 1 reste le bon.

### Vérification après correctif
`SECTION commandes_sante_7j` doit tomber **bien en dessous de 72 échecs/jour**, et
`SECTION cadence_derive` ne doit plus afficher aucune ligne `cible_suspecte = t`. Un correctif
qui ferait seulement disparaître les lignes du centre d'alerte sans faire baisser le compteur
d'échecs n'aurait rien réglé — il aurait juste éteint le témoin.

### ✅ Mise à jour du 2026-08-05 — la cause déclarée est corrigée…

Vérifié 3 h 40 après le déploiement :

| `cadence_resume` | 2026-08-04 | 2026-08-05 |
|---|---|---|
| Cibles sous le minimum matériel | 14 | **0** |
| Cible la plus basse en base | 1 s | **20 s** |
| `cadence_derive` | 10 lignes | **0 ligne** |

Le clamp à la lecture a neutralisé toutes les cibles héritées, sans migration. Sur ce point la
fiche est close.

### 🔴 …mais elle ne rendait compte que de 10 % du volume

**Le compteur d'échecs n'a pas bougé.** Sur la fenêtre strictement comparable 21:30 → 01:10
(conteneur recréé à 21:30 UTC) : **14 échecs la veille, 14 cette nuit**, mêmes six boîtiers,
horodatages superposés à 9 ms près.

La fiche affirmait que les **295 échecs « intervalle observe: 20 s »** venaient d'un boîtier
émettant à son minimum matériel, jugé contre une cible descendue plus bas. **C'est faux.** Le
croisement `params.interval` × `observedResult` sur 7 jours le montre :

| Intervalle **demandé** | Observé | Occurrences |
|---|---|---|
| **300 s** (`005m`) | 20 s | **281** |
| 300 s | 30 s | 53 |
| 300 s | 21 s | 45 |
| 300 s | 19 s | 38 |
| 20 s | 10 s | 6 |
| 20 s | 4 s | 4 |

**281 des 291** échecs à « observe: 20 s » demandaient **300 s** — très au-dessus du minimum
matériel, donc parfaitement légitime. Aucun clamp ne pouvait les faire disparaître.

Répartition réelle des 506 échecs par motif d'envoi : **454 (90 %) en `STOPPED_INTERVAL_ADJUSTED`
à 300 s**, sur 36 boîtiers. C'est un **autre défaut** → [TRK-012](#trk-012).

> **Leçon.** Le récit de cette fiche était cohérent, documenté, appuyé sur du vrai code — et il
> expliquait un dixième des cas. Une cause racine se vérifie sur la **donnée de la commande**
> (`params`), pas sur la vraisemblance de l'histoire. Le contre-exemple tenait dans une requête
> de trois lignes qui n'a pas été faite.

### Confirmation du 2026-08-06 — vérifiée sur le comportement, pas sur un instantané

Le « 0 cible sous le minimum » du 05/08 était mesuré 3 h 40 après un redémarrage, sur une base que
`normalizeDriftedTargets` réécrit **toutes les 10 min** : un instantané ne pouvait pas distinguer
« plus rien n'écrit sous 20 s » de « le balayage a nettoyé juste avant la mesure ». Vérifié cette
fois sur 24 h de journaux, **62 auto-alignements, aucun sous 20 s** :

| Valeur écrite | 20 s | 21 s | 30 s | 31 s | 92 s |
|---|---|---|---|---|---|
| Occurrences | 44 | 9 | 7 | 1 | 1 |

La fiche est donc close sur une preuve de comportement, et non de coïncidence.

### ~~⚠️ Réserve — le chemin d'écriture, lui, n'est toujours pas borné~~ — **levée le 2026-08-07**

> La réserve écrite le 06/08 disait : « `positions.service.ts:303` écrit `desiredFixIntervalS`
> sans clamp, avec un plancher `AUTO_ALIGN_FLOOR_S = 1` ». **C'est faux.**

Vérifié dans le code le 2026-08-07 :

```ts
// tracker-fix-mode.service.ts:67
const AUTO_ALIGN_FLOOR_S = HARD_CAP_MIN_S;          // = 20 s depuis V1.19

// tracker-fix-mode.service.ts:479-482
const autoAlignDesiredS =
  nextFailing && observedS >= AUTO_ALIGN_FLOOR_S && observedS <= HARD_CAP_S
    ? observedS
    : null;
```

`autoAlignDesiredS` ne vaut donc autre chose que `null` que si l'observé tombe dans **[20 s, 300 s]**.
Le chemin d'écriture **est** borné, et il l'a été dans la même livraison que le clamp à la lecture.
La garantie n'est pas seulement comportementale : elle est dans le code. Rien à surveiller.

### ⚠️ Ce qui a fabriqué cette fausse réserve — et qui est toujours là

Le commentaire V1.15 des **lignes 473-478** n'a pas été repris lors de la livraison du 04/08. Il
annonce encore le comportement d'avant :

> « on accepte desormais aussi les intervalles SOUS le minimum hardware (boitiers qui emettent
> plus vite que demande, ex. 2s/10s) […] l'ancien plancher etait HARD_CAP_MIN_S = 20s »

Six lignes plus bas, la constante dit exactement l'inverse. Un lecteur qui s'arrête au commentaire
— c'est ce qui s'est produit le 06/08 — écrit une réserve sur un défaut qui n'existe plus.

> *Un commentaire périmé fabrique un faux constat aussi sûrement qu'un bug.* Même leçon que la
> rectification de [TRK-011](#trk-011) : ce qui décrit un mécanisme se vérifie sur le code.

*(Nettoyage de commentaire — hors périmètre de l'audit, qui ne modifie pas de code applicatif.)*

---

## TRK-012

**Signature** — `fix_continuous | FAILED | params.interval = "005m" | observedResult = "Tracker FAILING — <N> trames non conformes (intervalle observe: <DURÉE>)"` — **en volume**
**Statut : 🔴 NON CORRIGÉ** · **454 échecs / 7 jours · 36 boîtiers · 0 succès** · découvert 2026-08-05

> ### 454 fois la même consigne au même matériel, jamais honorée une seule fois.

### Constat

| Motif d'envoi | Échecs / 7 j | Boîtiers | Intervalle demandé |
|---|---|---|---|
| **`STOPPED_INTERVAL_ADJUSTED`** | **454 (90 %)** | **36** | `005m` = **300 s** |
| `MOVING_INTERVAL_ADJUSTED` | 17 | 8 | 20 s |
| `STOPPED_TO_MOVING` | 12 | 6 | 20 s |
| autres transitions | 23 | — | 20 / 30 s |

`acquittees = 0` sur les 454. Les boîtiers continuent à 19–30 s.

Le `contextSnapshot` est sans ambiguïté : `ignition: false`, `speedKmh: 0`, et surtout
`previousState = "STOPPED"`, `newState = "STOPPED"` — **l'état n'a même pas changé**. On réémet
une consigne à un véhicule déjà à l'arrêt, qui ne l'a jamais appliquée.

### Cause racine

À l'arrêt (contact coupé depuis > 10 min), `desiredIntervalFor()` demande **300 s** pour
économiser la batterie et le forfait 2G. Le Coban GPS403D **n'applique pas cet intervalle**.

La garde V1.19 qui exempte « émettre plus vite que demandé » est **restreinte au mouvement**, et
son commentaire l'assume explicitement (`tracker-fix-mode.service.ts`, ~ligne 450) :

```
⚠️ RESTREINT AU MOUVEMENT, volontairement. À l'ARRÊT, la cible (300 s) vise l'ÉCONOMIE de
batterie et de données : un boîtier qui émet plus vite y contrevient réellement.
```

**Ce raisonnement est juste.** C'est une vraie non-conformité, et l'économie visée est réelle.
Le défaut n'est pas dans le jugement — il est dans la **réponse au jugement** :

1. 3 trames hors bande → `FAILING` → la commande passe en `FAILED` ;
2. le prochain ajustement d'état relance `requestChange()` → **la même consigne repart** ;
3. jusqu'au plafond anti-flapping de **2 commandes / jour / boîtier** ;
4. 36 boîtiers × 2 ≈ **65–72 échecs par jour**, tous les jours, depuis des mois, **sans un seul
   succès**.

> **En une phrase :** la bonne réponse à « ce boîtier n'a jamais accepté cette consigne, 454 fois
> de suite » n'est pas « redemande-lui demain ».

### Coût

~454 écritures TCP par semaine vers des boîtiers 2G + autant de lignes en base, pour zéro effet.
Et surtout : **l'économie de batterie et de données que la cible de 300 s existe pour obtenir
n'est pas obtenue**, sur 36 boîtiers, sans qu'aucun écran ne le dise.

### Correctifs proposés

1. **Ne plus réémettre une consigne jamais honorée.** Après N échecs consécutifs sur le **même
   intervalle demandé** (proposition : 5), cesser d'envoyer cette consigne à ce boîtier et poser
   un état explicite — *« n'honore pas la consigne 300 s à l'arrêt »*. La consigne reprend si le
   boîtier l'honore une fois, ou sur action manuelle. C'est le correctif de fond : il supprime le
   trafic sans rien masquer.
2. **Rendre l'état lisible plutôt que bruyant.** Une section « boîtiers qui n'appliquent pas la
   cadence d'arrêt » alimentée par cet état. Un fait matériel stable **se consulte** ; il ne se
   notifie pas 72 fois par jour. *(Même famille que « à lire, pas à notifier ».)*
3. **Vérifier l'hypothèse matérielle AVANT d'écrire du code.** Le `payload` émis est
   `fix005m***n123456` : le suffixe est le **mot de passe Coban par défaut**. Si ces boîtiers ont
   un mot de passe différent, la commande est rejetée en silence et aucun correctif logiciel n'y
   changera rien. À trancher par un test SMS sur **un** boîtier. *(Piste, pas conclusion.)*

### 🔓 2026-08-10 — le préalable est levé, le code attend sa preuve

Cette fiche impose, noir sur blanc : *« Vérifier l'hypothèse matérielle AVANT d'écrire du
code. »* Ce préalable n'était pas vérifiable — personne n'écoutait la réponse des boîtiers.

**Il l'est depuis le 2026-08-10 20:03** : [TRK-014](#trk-014) arme le guetteur d'ACK sur ce
chemin exact. La réponse (ou le silence PROUVÉ) de chaque `fix005m` arrive désormais en base.

Aucune ligne de code n'a donc été écrite ici, **volontairement**. Le correctif #1 (cesser de
réémettre après N échecs sur le même intervalle) et le #3 (mot de passe Coban) mènent à des
gestes différents, et le résultat du test daté de TRK-014 dit lequel s'applique. Écrire le #1
maintenant serait exactement l'erreur que cette fiche interdit depuis le 05/08 — et la série a
déjà montré ce que coûte un correctif fondé sur un récit cohérent mais invérifié
([TRK-008](#trk-008), faux sur 90 % de son volume).

⚠️ **Ce qui ne change pas en attendant** : la cible d'arrêt de 300 s reste demandée, et les
~72 échecs quotidiens continuent. C'est assumé pour une nuit — ils ne produisent aucune alerte
et n'ont jamais rien cassé ; ce qu'ils coûtent est du trafic et une économie non obtenue.

### ⚠️ Ne pas « corriger » en élargissant la garde

Étendre l'exemption « plus vite que demandé » à l'arrêt ferait disparaître les 454 lignes en une
ligne de code — et annulerait silencieusement l'économie que la cible de 300 s existe pour
obtenir. Trois tests du module verrouillent ce comportement depuis l'origine, à raison.
*Le témoin n'est pas le défaut.*

### Vérification après correctif

`SECTION commandes_sante_7j` doit tomber **sous 15 échecs/jour** et `STOPPED_INTERVAL_ADJUSTED`
quitter la tête de `commandes_motifs_7j` — **sans** que la cible d'arrêt de 300 s soit
abandonnée. Un correctif qui ferait baisser le compteur en cessant de demander 300 s aurait
supprimé la fonctionnalité, pas le défaut.

### Mise à jour du 2026-08-06 — périmètre élargi, volume inchangé

Le motif `MOVING_TO_STOPPED` demande **la même consigne (300 s) au même matériel** et échoue de
la même façon. Il appartient donc à cette fiche, qui ne comptait que `STOPPED_INTERVAL_ADJUSTED` :

| Motif d'envoi | Demandé | Échecs / 7 j | Boîtiers |
|---|---|---|---|
| `STOPPED_INTERVAL_ADJUSTED` | `005m` | 441 | 36 |
| `MOVING_TO_STOPPED` | `005m` | 11 | 5 |
| **Total famille « 300 s à l'arrêt »** | | **452 / 502 = 90 %** | **36** |

Toujours `acquittees = 0`. Quatre points de mesure sur la **même fenêtre** (21:30 → 01:10, seule
fenêtre strictement comparable depuis le redémarrage du 04/08) :

| Nuit | 02→03/08 | 03→04/08 | 04→05/08 | 05→06/08 |
|---|---|---|---|---|
| Échecs | 14 | 14 | 14 | **15** |

Quatre points, même définition : **plat**. Ici la stabilité *est* l'information — elle prouve un
plafond atteint (2 commandes/jour/boîtier), pas un aléa.

**Fait nouveau, un seul point :** `fixCommandFailing` passe de 0 à **1** boîtier (HD-779-MA,
cible 20 s, réel 10 s à l'arrêt). Ce n'est pas une régression — la garde V1.19 refuse
volontairement d'exempter « plus vite que demandé » à l'arrêt, où la cible vise l'économie. C'est
donc ce défaut qui devient *partiellement visible* à l'écran. Un boîtier, une mesure : à
reconfirmer avant d'en conclure quoi que ce soit.

⚠️ Une partie du compteur d'échecs qui sert à juger cette fiche est **fausse** — voir
[TRK-013](#trk-013). Avant de mesurer l'effet d'un correctif ici, corriger là.

### Mise à jour du 2026-08-07 — volume plat, et l'hypothèse matérielle avance

**445 échecs sur 496 (89,7 %)**, 36 boîtiers, `acquittees = 0`. Répartition inchangée :
`STOPPED_INTERVAL_ADJUSTED` 435 + `MOVING_TO_STOPPED` 10.

Cinquième point sur la fenêtre strictement comparable (21:30 → 01:10) :

| Nuit | 02→03/08 | 03→04/08 | 04→05/08 | 05→06/08 | 06→07/08 |
|---|---|---|---|---|---|
| Échecs | 14 | 14 | 14 | 15 | **13** |

Cinq points, même définition : **plat**. Le total quotidien passe de 72 à 68 les 05 et 06/08, mais
sur **34 boîtiers au lieu de 36** — écart de périmètre, pas de tendance.

`fixCommandFailing` **repasse de 1 à 0** : le boîtier signalé la veille (HD-779-MA) n'est plus en
échec. C'est la confirmation qu'il ne fallait rien conclure d'une mesure unique — ni hier, ni
aujourd'hui.

### Mise à jour du 2026-08-08 — sixième point, toujours plat

**446 échecs sur 498 (89,6 %)**, 36 boîtiers, `acquittees = 0`. Répartition inchangée :
`STOPPED_INTERVAL_ADJUSTED` 435 + `MOVING_TO_STOPPED` 11.

| Nuit | 02→03/08 | 03→04/08 | 04→05/08 | 05→06/08 | 06→07/08 | 07→08/08 |
|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 14 | 15 | 13 | **13** |

Six points, même définition : **plat**. Le total quotidien remonte à **74 le 07/08 sur
37 boîtiers** (68 sur 34 les 05 et 06/08). Le rapport échecs/boîtier est constant à 2 : c'est le
plafond anti-flapping, et l'écart quotidien suit le nombre de boîtiers actifs, pas une tendance.

`fixCommandFailing` reste à **0**, deuxième jour de suite.

### Mise à jour du 2026-08-09 — septième point, et un invariant qui se confirme

**446 échecs sur 498 (89,6 %)**, 36 boîtiers, `acquittees = 0`. Répartition :
`STOPPED_INTERVAL_ADJUSTED` 433 + `MOVING_TO_STOPPED` 13, tous à `005m`.

| Nuit | 02→03 | 03→04 | 04→05 | 05→06 | 06→07 | 07→08 | 08→09 |
|---|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 14 | 15 | 13 | 13 | **13** |

Sept points, même définition : **plat**.

Et l'invariant qui explique tout l'écart quotidien est désormais mesuré sur huit jours pleins :

| Jour | 01/08 | 02/08 | 03/08 | 04/08 | 05/08 | 06/08 | 07/08 | 08/08 |
|---|---|---|---|---|---|---|---|---|
| Commandes | 72 | 72 | 74 | 70 | 68 | 68 | 74 | 72 |
| Boîtiers | 36 | 36 | 37 | 35 | 34 | 34 | 37 | 36 |
| **Par boîtier** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** | **2,00** |

Le ratio ne bouge pas d'un centième : c'est le plafond anti-flapping (2 commandes/jour/boîtier)
atteint tous les jours par tous les boîtiers actifs. **Toute variation du total quotidien est un
écart de périmètre, jamais une tendance.** Le chiffre à surveiller après correctif n'est donc pas
le total : c'est le ratio, qui doit décrocher de 2,00.

### Mise à jour du 2026-08-10 — huitième point, et l'invariant tient sur neuf jours

**449 échecs sur 498 (90,2 %)**, 36 boîtiers, `acquittees = 0`. Répartition :
`STOPPED_INTERVAL_ADJUSTED` 427 + `MOVING_TO_STOPPED` 15, tous à `005m`, plus 7
`STOPPED_INTERVAL_ADJUSTED` à `030s`.

| Nuit | 02→03 | 03→04 | 04→05 | 05→06 | 06→07 | 07→08 | 08→09 | 09→10 |
|---|---|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 14 | 15 | 13 | 13 | 13 | **13** |

Huit points, même définition : **plat**. Et le ratio commandes/boîtier reste à **2,00 le 09/08**
(72 commandes, 36 boîtiers) — neuvième jour consécutif sans écart d'un centième.

⚠️ **Un fait nouveau change le contexte de cette fiche sans changer son diagnostic.**
[TRK-017](#trk-017) établit que 24 des 43 SIM du parc étaient hors de l'allowlist SMS. Cela ne
concerne **pas** le canal des commandes de cadence, qui passe en TCP : les 449 échecs restent
mesurés sur l'intervalle des trames reçues. Mais cela retire une option au correctif #3 — le test
SMS sur un boîtier — tant qu'on n'a pas la certitude que son numéro est autorisé. **Vérifier
l'allowlist avant d'interpréter l'échec d'un test SMS**, sans quoi un `403` de la passerelle
passerait pour un boîtier muet.

**Le correctif #3 avance sans le test SMS.** [TRK-014](#trk-014) établit que le boîtier ne répond
**rien** : 275 commandes `fix…` envoyées en 4 jours, aucune trame de réponse, et `ackedAt` NULL sur
les 3797 commandes émises depuis avril. Le test SMS reste utile pour trancher entre « rejetée en
silence » et « acceptée mais non appliquée » — mais **armer l'écoute d'ACK est plus rapide, plus
sûr et couvre les 36 boîtiers d'un coup**. À faire avant tout correctif ici : sans ça, on pilote
à l'aveugle.

### 🔓 Mise à jour du 2026-08-11 — l'écoute a répondu, et elle ne désigne pas le firmware

**447 échecs « 300 s à l'arrêt » sur 496 (90,1 %)**, 36 boîtiers, `acquittees = 0`. Répartition :
`STOPPED_INTERVAL_ADJUSTED` 430 + `MOVING_TO_STOPPED` 14, tous à `005m`, plus 7
`STOPPED_INTERVAL_ADJUSTED` à `030s`.

| Nuit | 03→04 | 04→05 | 05→06 | 06→07 | 07→08 | 08→09 | 09→10 | 10→11 |
|---|---|---|---|---|---|---|---|---|
| Échecs (21:30 → 01:10) | 14 | 14 | 15 | 13 | 13 | 13 | 13 | **13** |

Neuf points, même définition : **plat**. Et le ratio commandes/boîtier atteint **dix jours
consécutifs à 2,00** — 72/36, 74/37, 70/35, 68/34, 68/34, 74/37, 72/36, 72/36, 72/36 du 02 au 10/08,
sans un centième d'écart. Le plafond anti-flapping est saturé tous les jours.

**Le test daté de [TRK-014](#trk-014) est tombé, et il ne libère pas le correctif #1 — il le
suspend.** Quatorze commandes `fix005m` émises après l'armement de l'écoute, **quatorze silences
tracés, zéro réponse**. Selon la table de décision de TRK-014, ce résultat écarte
« le firmware accepte mais n'applique pas » et laisse en lice « la commande n'arrive pas » et
« elle est rejetée en silence (mot de passe) ». Or le correctif #1 (cesser de réémettre) suppose que
le boîtier reçoive et refuse d'appliquer.

> **Écrire le #1 maintenant serait exactement l'erreur que cette fiche interdit depuis le 05/08.**
> Le préalable est désormais le **test SMS sur un boîtier** — et [TRK-017](#trk-017) impose de
> vérifier d'abord que son numéro est dans l'allowlist, sans quoi un `403` de la passerelle passerait
> pour un boîtier muet. À quoi [TRK-018](#trk-018) ajoute une contrainte : un SMS resté `queued`
> n'est pas une preuve d'envoi. **Trois fiches se rejoignent sur le même geste, et aucune ne peut
> le remplacer.**

---

## TRK-013

**Signature** — `fix_continuous | FAILED | observedResult = "Sans effet constaté après <DURÉE> :
cadence réelle <N>s pour une cible de <N>s."` — *avec les deux valeurs égales*
**Statut : 🔴 NON CORRIGÉ** · **5 clôtures fausses + 6 cibles mal citées sur 28** · découvert 2026-08-06

> ### Le correctif de [TRK-007](#trk-007) solde la file. Il la solde en déclarant échec ce qui a abouti.

### Constat

Sur les 17 commandes closes par échéance depuis le 03/08, **trois** portent ce texte :

> « Sans effet constaté après 37 min : cadence réelle **20 s** pour une cible de **20 s**. Le
> boîtier n'acquitte pas ; commande close par échéance. »

| Commande | `params.interval` | Cadence réelle | Statut écrit |
|---|---|---|---|
| HD-443-QY · 05/08 15:40 | `020s` | 20 s | `FAILED` |
| FS-808-CE · 05/08 13:44 | `020s` | 20 s | `FAILED` |
| FW-298-WV · 04/08 13:45 | `020s` | 20 s | `FAILED` |

L'intervalle demandé est exactement celui observé, et la ligne est archivée comme un échec.

### Cause racine — il n'y a aucune comparaison

`tracker-fix-mode.service.ts:302-317` sélectionne les commandes trop vieilles, écrit `FAILED`, et
compose un message. Aucun test de conformité n'existe entre les deux :

```ts
const reel = c.tracker.currentFixIntervalS;
data: {
  status: TrackerCommandStatus.FAILED,
  observedResult: `Sans effet constaté après ${ageMin} min : cadence réelle ` +
    `${reel != null ? `${reel}s` : 'inconnue'} pour une cible de ` +
    `${c.tracker.desiredFixIntervalS}s. …`,
}
```

Une commande dont la cible est atteinte est close **exactement comme** une commande à 3600 s réels
pour une cible de 20 s.

### Second défaut, dans la même requête — la cible citée n'est pas celle demandée

Le `select` (ligne 293-297) ne charge pas `params`. La « cible » du message est donc
`c.tracker.desiredFixIntervalS`, **lue au moment du balayage** : la cible courante du boîtier, qui
a pu changer depuis l'envoi. Sur 4 des 17 clôtures, les deux diffèrent :

| Commande | Demandé (`params`) | Annoncé dans le message |
|---|---|---|
| HD-443-QY · 05/08 15:24 | `005m` (300 s) | « cible de 20 s » |
| FW-298-WV · 04/08 13:36 | `030s` | « cible de 20 s » |
| HD-779-MA · 04/08 22:32 | `030s` | « cible de 20 s » |
| EY-613-MF · 03/08 11:20 | `005m` (300 s) | « cible de 20 s » |

### Famille — **mensonger**

Au sens du §7 de la procédure : le message affirme un fait faux et envoie enquêter au mauvais
endroit. C'est la famille la plus grave, et c'est la même que celle du `outcomeReason` que
TRK-007 dénonçait déjà — le champ dont le nom annonce un résultat et le contenu livre autre chose.

### Ce que ça coûte, au-delà du message

Ces clôtures alimentent `commandes_sante_7j`, **le compteur qui sert à juger [TRK-012](#trk-012)
et à mesurer si un correctif porte**. Un indicateur qui compte des succès parmi ses échecs ne peut
pas servir de preuve. Le volume est faible aujourd'hui (3 sur 502), mais il croît avec le nombre
de commandes soldées — c'est-à-dire avec l'efficacité du correctif de TRK-007.

### Correctif proposé

Charger `params` dans le `select`, comparer, puis conclure :

1. si `currentFixIntervalS` tombe dans la bande de tolérance de l'intervalle **demandé par la
   commande** (la même bande ±20 % que `reconcile`), clore en `ACKNOWLEDGED` avec
   `observedResult` = « cible atteinte : cadence réelle X s — sans accusé de réception du
   boîtier » ;
2. sinon, garder `FAILED` **et citer l'intervalle demandé par la commande**, jamais la cible
   courante du boîtier.

### ⚠️ Ne pas allonger l'échéance à la place

Le délai n'est pas le sujet. L'échéance doit rester **purement temporelle** — c'est la leçon
durement acquise de TRK-007 : la conditionner à un état du boîtier la ferait retomber dans le
piège des deux gardes justes qui, composées, laissent une commande ouverte à vie. Ce qui manque
est la **comparaison**, pas la patience.

### Vérification après correctif

Plus aucune clôture n'annonce une cadence réelle égale à l'intervalle demandé tout en portant
`FAILED` — **et** les vraies non-conformités continuent de sortir en `FAILED` (EY-613-MF à
3600 s pour une cible de 300 s doit rester un échec). Le second point est le vrai test : un
correctif qui ferait disparaître les deux aurait supprimé le balayage, pas le défaut.

### Mise à jour du 2026-08-07 — dénominateur en hausse, numérateur stable

**19 clôtures par échéance** (17 la veille). Toujours **3 fausses** et **4 cibles mal citées** —
les deux nouvelles clôtures sont correctes :

| Commande | Demandé | Réel | Message | Verdict |
|---|---|---|---|---|
| `…6763` · 06/08 21:52 | `020s` | 4406 s | « cadence réelle 4406s pour une cible de 20s » | ✅ juste |
| `…7480` · 06/08 12:29 | `005m` | 6 s | « cadence réelle 6s pour une cible de 300s » | ✅ juste |

Deux clôtures justes ne prouvent rien : elles tombent du bon côté par construction (la cible du
boîtier au moment du balayage coïncidait avec celle de la commande). **Le défaut de code est
intact** — il n'y a toujours aucune comparaison, et `params` n'est toujours pas chargé.

### Mise à jour du 2026-08-08 — les deux compteurs montent

**24 clôtures par échéance** (19 la veille). **4 fausses** (+1) et **5 cibles mal citées** (+1).
Les deux nouveaux cas sont sur FS-253-HR le 07/08, à cinq minutes d'intervalle :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| FS-253-HR · 07/08 11:44 | `020s` | 21 s | « cadence réelle 21s pour une cible de 20s » | ❌ **fausse** — 21 s est dans la bande ±20 % de 20 s, donc la cible **est atteinte** |
| FS-253-HR · 07/08 11:39 | `030s` | 17 s | « cadence réelle 17s pour une cible de 20s » | ⚠️ **mal citée** — la commande demandait 30 s |
| FZ-731-YF · 07/08 22:43 | `005m` | 20 s | « cadence réelle 20s pour une cible de 300s » | ✅ juste |
| EY-613-MF · 07/08 02:20 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 07/08 01:20 | `020s` | 7198 s | « … pour une cible de 20s » | ✅ juste |

⚠️ **Précision de critère.** Les trois fausses clôtures des 04 et 05/08 affichaient une égalité
**stricte** (20 s pour 20 s). Celle du 07/08 est à 21 s pour 20 s : elle n'est fausse qu'au sens de
la **bande de tolérance ±20 %** — la même que celle dont `reconcile()` se sert pour juger. C'est
bien le critère du correctif proposé ci-dessus, et c'est celui qu'il faut retenir : comptée à
l'égalité stricte, cette clôture passerait pour juste alors que le boîtier honore sa consigne.

### Mise à jour du 2026-08-09 — les deux compteurs montent encore, sur le même véhicule

**28 clôtures par échéance** (24 la veille). **5 fausses** (+1) et **6 cibles mal citées** (+1).
Les deux nouveaux cas sont sur FS-253-HR le 08/08, à cinq minutes d'intervalle — **exactement la
même paire, sur le même véhicule, que le 07/08** :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| FS-253-HR · 08/08 12:11 | `020s` | 20 s | « cadence réelle 20s pour une cible de 20s » | ❌ **fausse** — égalité stricte |
| FS-253-HR · 08/08 12:06 | `030s` | 20 s | « cadence réelle 20s pour une cible de 20s » | ⚠️ **mal citée** — la commande demandait 30 s |
| FZ-731-YF · 08/08 23:17 | `005m` | 3602 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 08/08 02:20 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |

La récurrence de la paire n'est pas un hasard : deux commandes émises à quelques minutes d'écart
sur le même boîtier sont closes par le même balayage, et la seconde hérite d'une cible courante
réécrite entre-temps. **C'est le scénario que le correctif doit couvrir en priorité** — charger
`params` suffit à traiter les deux cas d'un coup.

⚠️ **Le taux ne baisse pas.** 11 clôtures défectueuses sur 28 (39 %) contre 9 sur 24 (37,5 %) la
veille. Le défaut de code est intact ; seul le dénominateur grandit, avec l'efficacité du balayage.

### Mise à jour du 2026-08-10 — trois clôtures de plus, toutes justes

**31 clôtures par échéance** (28 la veille). Les trois nouvelles, toutes du 09/08, sont **correctes** :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| FZ-731-YF · 09/08 23:29 | `005m` | 3602 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 09/08 06:25 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |
| EY-613-MF · 09/08 02:20 | `005m` | 3600 s | « … pour une cible de 300s » | ✅ juste |

Le décompte défectueux reste donc **5 fausses + 6 cibles mal citées**, soit 11 sur 31 (35,5 %)
contre 11 sur 28 (39 %) la veille.

⚠️ **Ce recul du taux n'est pas une amélioration.** Le numérateur n'a pas bougé ; seul le
dénominateur a grandi. Et ces trois clôtures tombent du bon côté **par construction** — la cible
courante du boîtier coïncidait avec celle de la commande — exactement comme les deux du 07/08.
`params` n'est toujours pas chargé dans le `select` : le défaut de code est intact, et il
reproduira la paire FS-253-HR dès que deux commandes rapprochées seront closes par le même balayage.

### Mise à jour du 2026-08-11 — deux clôtures de plus, toutes deux justes

**33 clôtures par échéance** (31 la veille) :

| Commande | Demandé (`params`) | Cadence réelle | Message | Verdict |
|---|---|---|---|---|
| EY-613-MF · 10/08 02:21 | `020s` | 110 s | « cadence réelle 110s pour une cible de 20s » | ✅ juste |
| FZ-731-YF · 10/08 23:41 | `005m` | 3602 s | « … pour une cible de 300s » | ✅ juste |

Décompte défectueux **inchangé** : **5 fausses + 6 cibles mal citées = 11 sur 33 (33,3 %)**, contre
11 sur 31 (35,5 %) la veille. Troisième passage consécutif où le numérateur ne bouge pas et où seul
le dénominateur grandit — **le taux baisse sans que rien ne s'améliore.** C'est précisément pourquoi
la fiche compte les deux défauts en valeur absolue et non en pourcentage : un ratio qui décroît par
dilution raconte le contraire de ce qui se passe.

`params` n'est toujours pas chargé dans le `select` (vérifié : les deux nouvelles clôtures citent
juste parce que la cible courante coïncidait, comme les cinq précédentes). Le défaut de code est
intact.

---

## TRK-014

**Signature** — *(absence de réponse, pas une ligne d'erreur)* `tracker_commands | ackedAt IS NULL |
100 % des commandes, tous templates, depuis l'origine`
**Statut : 🔴 NON CORRIGÉ** · **3797 commandes · 0 accusé de réception · depuis 2026-04-27** ·
découvert 2026-08-07

> ### La chaîne de commande n'a jamais reçu une seule réponse. Personne ne s'en est aperçu parce
> ### que personne n'écoutait.

### Constat 1 — le chemin adaptatif n'arme jamais l'écoute

`tracker-fix-mode.service.ts:647-659` écrit `SENT`, journalise la trame sortante, met à jour la
cible du boîtier, et s'arrête là. Il n'appelle **jamais** `ackWaiter.waitForAck`.

Le chemin générique, lui, le fait (`tracker-commands.service.ts:239-241`) :

```ts
const template = findTemplate(command.templateId);
if (template && template.expectedAckPattern) {
  this.ackWaiter.waitForAck(resolvedImei, template.expectedAckPattern, template.ackTimeoutMs, command.id)
    .then(/* → ACKNOWLEDGED, ackedAt, ackResponse */)
    .catch(/* → FAILED, lastError = "ACK timeout: …" */);
}
```

Preuve en base que ce chemin n'est jamais emprunté pour la cadence : sur 3797 commandes,
**4 seulement** portent un `lastError` de type `ACK timeout`, toutes datées du **2026-05-24** —
les essais manuels de `sensitivity` / `shock_on`. Les 3788 `fix_continuous` n'en portent aucun.

| Colonne | Valeur sur les 3797 commandes |
|---|---|
| `ackedAt` | **NULL — sans exception** |
| `ackResponse` | **NULL — sans exception** |
| `status` | `FAILED` — **100 %**, tous templates confondus |

Les **30** commandes portant un `acknowledgedAt` sont des **acquittements manuels d'administrateur**
(`admin-alerts.controller.ts`), la dernière le 2026-07-08. Aucune ne vient d'un boîtier.

### Constat 2 — et il n'y aurait rien à entendre

Le journal de trames est actif en production (`WIRE_LOG_ENABLED=true`, rétention 3 jours). Sur la
fenêtre disponible (03/08 03:00 → 07/08 01:15 UTC) :

| Sens | Contenu | Trames | Boîtiers |
|---|---|---|---|
| OUT | `fix005m***n123456` | **244** | 35 |
| OUT | `fix020s***n123456` | **21** | 9 |
| OUT | `fix030s***n123456` | **10** | 5 |
| IN | position · heartbeat · no_fix · login | 690 728 | 37 |
| IN | classées `ack` | 281 | 32 |
| IN | contenant « ok », « fix », « error » ou « password » | **0** | — |

Dans les 60 s qui suivent chaque `fix…`, il ne revient que du trafic ordinaire.

⚠️ **Les 281 trames classées `ack` ne sont pas des accusés de réception.** Ce sont des rapports de
minuterie Coban — `imei:…,jt,260806180001,100%,F,…` et `…,kt,…`, à 18:00 et 03:00 chaque jour —
que le motif générique `/imei:\d{15},/i` d'un autre template attrape au passage. Elles ne
répondent à aucune commande. *Un compteur d'ACK non nul peut ne contenir aucun ACK.*

### Ce que ça change — et ce que ça ne change pas

**Ça ne rend aucune fiche caduque.** [TRK-012](#trk-012) reste exact : la cadence de 300 s n'est
pas appliquée, c'est mesuré sur les trames reçues, pas sur les ACK.

**Ça change ce qu'on peut conclure.** Le diagnostic de TRK-012 repose entièrement sur
l'observation de l'intervalle des trames. Trois causes restent indistinguables :

1. la commande n'arrive pas (canal descendant) ;
2. elle arrive et est **rejetée en silence** (mot de passe — le payload finit par `***n123456`,
   le mot de passe Coban par défaut) ;
3. elle arrive, est acceptée, et le firmware ne l'applique pas.

Un `fix ok` ou un message d'erreur trancherait entre elles en 15 s. L'information circule
peut-être déjà sur le fil ; rien ne la lit.

### Une piste tentante, et pourquoi elle ne tient pas

Le catalogue n'offre que `010s`, `030s`, `060s`, `002m`, `005m`, `010m`
(`coban.catalog.ts:162-173`) — **`020s` n'y figure pas**, et l'automate adaptatif en envoie quand
même (21 trames en 4 jours), parce qu'il construit son intervalle sans passer par la liste.

Tentant d'y voir la cause. **Faux pour l'essentiel du volume :** `005m` *est* dans la liste, il est
valide, et il échoue **435 fois sur 7 jours**. La valeur d'intervalle n'explique pas TRK-012.
Anomalie de cohérence à corriger, pas cause racine. *(Le contre-exemple tient en une ligne : le
chercher avant d'écrire la fiche, pas après.)*

### Correctifs proposés

1. **Armer l'écoute sur le chemin adaptatif.** Appeler `ackWaiter.waitForAck` après l'envoi, comme
   le chemin générique. Le motif (`/fix.*ok/i`) et le délai (15 s) existent déjà dans le
   catalogue ; `tcp-server.service.ts:296,341` offre déjà chaque trame entrante au guetteur. Il ne
   manque que l'inscription du guetteur.
2. **Distinguer « sans réponse » de « en échec ».** Une commande à laquelle le boîtier n'a rien
   répondu n'est pas dans le même état qu'une commande explicitement rejetée. Aujourd'hui les deux
   s'écrivent `FAILED` — même famille de défaut que [TRK-013](#trk-013).
3. **Aligner le catalogue sur ce que l'automate émet** (ajouter `020s`, ou faire passer l'automate
   par la liste d'options). Faible priorité.

### ⚠️ Ne pas reconditionner la clôture des commandes à cet ACK

C'est la leçon durement acquise de [TRK-007](#trk-007) : un boîtier muet laisserait de nouveau des
commandes ouvertes à vie, et le centre d'alerte redeviendrait une file qui ne se vide pas.
L'échéance temporelle reste la fin de vie de la commande. **L'ACK ajoute une information quand elle
existe — il ne décide de rien.**

### Vérification après correctif

Au moins une commande porte un `ackResponse` non nul, **ou** le journal montre des
`ACK_TIMEOUT pattern=fix.*ok` réguliers. Les deux résultats sont utiles, et le second l'est
autant que le premier : il prouverait que l'écoute fonctionne et que le silence du boîtier est
réel — ce qu'on ne sait pas prouver aujourd'hui, faute d'écouter.

⚠️ Un correctif qui ferait seulement disparaître des lignes `FAILED` sans jamais produire ni ACK
ni timeout tracé n'aurait rien mesuré.

### Mise à jour du 2026-08-08 — inchangé, sur un dénominateur plus grand

**3871 commandes** émises depuis le 27/04 (+74 depuis la veille), **`ackedAt` NULL et
`ackResponse` NULL sans exception**, toujours 30 acquittements manuels d'administrateur et aucun
venant d'un boîtier. Rien n'a été armé, rien n'a répondu.

### Mise à jour du 2026-08-09 — inchangé, troisième jour

**3943 commandes** émises depuis le 27/04 (+72), `ackedAt` **NULL** et `ackResponse` **NULL** sans
exception, 30 acquittements manuels et aucun venant d'un boîtier. Trois passages, trois fois le
même zéro sur un dénominateur qui grossit de ~72 par jour.

### ✅ 2026-08-10 20:03 UTC — CORRECTIF #1 DÉPLOYÉ : l'écoute est armée

`tracker-fix-mode.service` inscrit désormais un guetteur d'ACK après chaque envoi TCP réussi
(`main` @ `73440d8`, `restarts=0`, API `healthy`). Le motif `/fix.*ok/i` et le délai de 15 s
venaient déjà du catalogue ; il ne manquait que l'inscription.

⚠️ **L'ACK informe, il ne décide de rien.** Le `status` de la commande n'est jamais modifié —
ni `ACKNOWLEDGED` sur réponse, ni `FAILED` sur silence. L'échéance PUREMENT TEMPORELLE reste la
seule fin de vie d'une commande ([TRK-007](#trk-007)). Un test verrouille ce point sur les deux
scénarios : c'est le garde-fou contre la récidive la plus probable.

Le silence, lui, est désormais **tracé** : au journal de trames, et dans `diagnosticHint` — qui
est durable et visible à l'écran des commandes.

### 🗓️ Test daté — au passage du 2026-08-11

Aucune commande n'est partie entre le déploiement (20:03) et 20:15 : les véhicules sont à
l'arrêt le soir et les transitions d'état se raréfient. La mesure se fera sur la nuit.

```sql
SELECT count(*) FILTER (WHERE "ackResponse" IS NOT NULL) AS avec_ack,
       count(*) FILTER (WHERE "diagnosticHint" LIKE 'Aucune réponse%') AS silences_traces,
       count(*) AS total
FROM tracker_commands WHERE "createdAt" > timestamp '2026-08-10 20:03:00';
```

| Résultat | Conclusion — et ce qu'il débloque pour [TRK-012](#trk-012) |
|---|---|
| `avec_ack > 0` | Le boîtier **reçoit et accepte** la consigne. La cause de TRK-012 est donc le **firmware qui ne l'applique pas** — l'hypothèse « mot de passe » tombe, et le correctif #1 de TRK-012 (cesser de réémettre) devient le bon. |
| `avec_ack = 0` **et** `silences_traces > 0` | Le boîtier **ne répond jamais**, ce qui est maintenant PROUVÉ et non plus supposé. Restent « non reçue » et « rejetée en silence (mot de passe) » → le test SMS sur un boîtier devient la seule façon de trancher. |
| `total = 0` | Aucune commande n'est partie : rien n'est mesuré. **Ne rien conclure** — et surtout ne pas lire ce zéro comme un silence du boîtier. |

⚠️ **Le troisième cas est le piège.** Un compteur à zéro parce que rien n'a été émis ressemble
exactement à un compteur à zéro parce que rien n'a répondu. Toujours lire `total` d'abord.

### 🔓 2026-08-11 — VERDICT DU TEST DATÉ : le silence du boîtier est PROUVÉ

Fenêtre 10/08 20:03 → 11/08 01:11 UTC, cinq heures :

```
avec_ack = 0   ·   silences_traces = 14   ·   total = 14
```

`total = 14` : le piège du troisième cas est écarté d'emblée — **des commandes sont bien parties**.
Les quatorze portent le même `diagnosticHint` : *« Aucune réponse du boîtier en 15 s (motif
attendu : fix.*ok). Le canal descendant est ouvert… »*. Quatorze `fix005m`, quatorze attentes
arrivées à échéance, **zéro réponse**.

C'est la **deuxième ligne** de la table de décision ci-dessus. Ce qu'elle établit :

- le boîtier **ne répond jamais** — désormais *prouvé*, plus supposé. L'écoute fonctionne, et son
  silence est un fait mesuré ;
- pour [TRK-012](#trk-012), l'hypothèse « le firmware accepte mais n'applique pas » n'est **pas**
  confirmée. Restent « la commande n'arrive pas » et « elle est rejetée en silence (mot de passe) » ;
- **le test SMS sur un boîtier redevient le seul discriminant**, exactement comme la fiche l'avait
  posé — et le correctif #1 de TRK-012 reste **suspendu** en attendant.

### ✅ La garde « l'ACK ne décide de rien » a tenu

C'était le point où la récidive était la plus probable. Les 14 commandes sont `FAILED`, mais
**aucune ne l'est par le chemin de l'ACK** :

| Chemin d'écriture du statut | Commandes |
|---|---|
| Réconciliation (« Tracker FAILING — 3 trames non conformes ») | 13 |
| Échéance temporelle (« Sans effet constaté après 39 min ») | 1 |
| **Guetteur d'ACK** | **0** |

Le `status` n'a pas bougé d'un cran à cause d'une absence de réponse. L'ACK informe
(`diagnosticHint`), l'échéance décide. *La leçon de [TRK-007](#trk-007) est appliquée, et vérifiée
en production sur des données réelles — pas seulement par le test unitaire qui la verrouille.*

**Ce qui reste ouvert :** les correctifs #2 (distinguer « sans réponse » de « en échec ») et #3
(aligner le catalogue sur `020s`). La fiche reste 🔴.

### Mise à jour du 2026-08-11 — cumul

**4087 commandes** émises depuis le 27/04 (+72), `ackedAt` **NULL** et `ackResponse` **NULL** sans
exception, 30 acquittements manuels d'administrateur. Le zéro d'`ackResponse` n'a plus le même sens
qu'hier : il est maintenant **accompagné de 14 silences tracés**, ce qui le transforme d'ignorance
en constat.

### Mise à jour du 2026-08-10 — inchangé, quatrième jour

**4015 commandes** émises depuis le 27/04 (+72), `ackedAt` **NULL** et `ackResponse` **NULL** sans
exception, 30 acquittements manuels et aucun venant d'un boîtier.

⚠️ **Et le second canal vient de se révéler muet lui aussi.** [TRK-017](#trk-017) établit que
24 des 43 SIM du parc étaient hors de l'allowlist de la passerelle : leur repli SMS échouait en
`403`, sans trace. Sur ces boîtiers, **aucune** des deux voies de commande ne pouvait confirmer quoi
que ce soit — le TCP parce que personne n'écoute (cette fiche), le SMS parce que la passerelle
refusait. Le correctif #1 (armer `waitForAck`) devient plus urgent : c'est la seule des deux voies
dont la remise en service ne dépend pas d'un tiers.

---

## TRK-015

**Signature** — `positions | SKIPPED_REPLAY | garde-fou ingestion (stale_devicetime) : deviceTime
<DATE> vs dernier <DATE>` — **en volume, et sans aucune alerte**
**Statut : 🔴 NON CORRIGÉ** · **8360 trames écartées / 4 j · 37 boîtiers (tout le parc) ·
3466 trous réels** · découvert 2026-08-08

> ### Le garde-fou qui empêche la téléportation efface aussi des positions que la base n'a nulle part ailleurs.

### Constat

`evaluateIngestionFix` refuse toute trame dont l'horodatage boîtier n'est pas **strictement**
postérieur au dernier horodatage valide. Sur 4 jours de `position_sampling_decisions` :
**8360 rejets**, soit 1,4 % du flux, sur **les 37 boîtiers du parc**. `stale_devicetime` en produit
**8356** ; `implausible_jump`, 4.

Le volume n'est pas le sujet. Le sujet est que la **même** règle produit deux résultats opposés,
et que la donnée permet de les séparer — en vérifiant si une ligne `positions` existe déjà pour ce
boîtier à cet horodatage :

| Classe de rejet | Trames | Jumeau en base *(fantôme → rejet correct)* | Aucune position à ± 60 s *(**trou**)* |
|---|---|---|---|
| Doublon exact (Δt = 0 s) | 1695 | **1650** | 9 |
| Retour arrière ≤ 60 s | 273 | 1 | **103** |
| **Retour arrière 1-60 min** | **6388** | 2186 | **3354** |
| **Total** | **8356** | **3837** | **3466** |

Le doublon exact est traité correctement : 97 % des trames ont leur jumeau en base, rien n'est
perdu. La classe « retour arrière 1-60 min », elle, contient **les deux à la fois** — un tiers de
fantômes prouvés, la moitié de trous prouvés.

### Ce qui est perdu n'est pas cosmétique

Les 6388 trames de cette classe sont en moyenne à **3688 m** de la dernière position connue
(maximum **47 km**) ; **4017** sont au-delà de 100 m et **3054** portent une vitesse rapportée
> 5 km/h — un véhicule **en mouvement**.

| Boîtier | Trous / 4 j | Distance moyenne | Maximum | Part de ses trames rejetées |
|---|---|---|---|---|
| EP-047-TY | 267 | 3061 m | 16,2 km | **22,3 %** |
| FG-669-DQ | 200 | 4641 m | 22,6 km | 17,4 % |
| HD-584-BF | 295 | 212 m | 4,7 km | 14,3 % |
| AL-927-QM | 227 | 529 m | 7,9 km | 9,3 % |
| DZ-034-CA | 296 | 44 m | 122 m | 20,0 % |

Sur DZ-034-CA ou GS-138-LT (4 m de moyenne) le trou est sans conséquence. Sur EP-047-TY et
FG-669-DQ, ce sont des segments de trajet entiers qui manquent — donc des kilomètres absents des
rapports de distance.

### Cause racine — un critère protège explicitement contre la perte, l'autre pas

`packages/shared/src/utils/gps-sanity.ts` applique trois critères. Le commentaire du **critère 2**
(saut infaisable) est sans ambiguïté sur l'intention :

> « On utilise le `dt` PLEIN (non borne) : un grand `dt` legitime (rattrapage post-coupure GPRS,
> vehicule deplace hors-ligne) tolere une grande distance — on ne rejette que l'infaisable, **pour
> ne jamais PERDRE une position reelle**. »

Le **critère 1** n'a aucune nuance équivalente :

```ts
const dtSec = (nextMs - prevMs) / 1000;
// 1. deviceTime non strictement croissant → trame rejouee depuis le buffer.
if (dtSec <= 0) {
  return { authoritative: false, reason: 'stale_devicetime' };
}
```

Or c'est lui qui produit 8356 des 8360 rejets. Un Coban qui bufferise pendant une coupure 2G puis
rejoue son tampon **après** que la trame temps réel a établi la nouvelle baseline voit toutes ses
positions tampon déclarées « antérieures » — et écartées. Le code ne peut pas distinguer ce
rattrapage d'un rejeu fantôme : les deux arrivent avec un horodatage plus ancien.

### Pourquoi personne ne l'a vu

`PositionsService.ingest` fait exactement ce qu'il faut pour rester discret, et il le fait bien :
il met à jour la liveness (le boîtier reste ONLINE), il journalise la décision en
`SKIPPED_REPLAY`, et il émet un `logger.warn`. Résultat :

- **aucune ligne `error_logs`** — ce n'est pas une erreur, c'est une décision ;
- **aucun compteur d'écran** — le centre d'alerte ne lit pas `position_sampling_decisions` ;
- le `warn` se perd dans les journaux du conteneur, qui ne retiennent que quelques heures.

Un trajet amputé de 16 km ne se voit que si quelqu'un connaît le trajet réel.

### Correctifs proposés

1. **Le test qui manque tient en une requête.** Avant de rejeter sur `stale_devicetime`, vérifier
   s'il existe déjà une ligne `positions` pour ce boîtier **à cet horodatage exact**. C'est
   précisément ce qui sépare un fantôme d'un rattrapage, et la donnée prouve que le test discrimine :
   3837 rejets ont leur jumeau, 3466 n'en ont aucun.
2. **Fantôme → rejeter**, comportement actuel strictement inchangé.
3. **Sinon → persister en trame NON autoritaire.** Écrire la ligne `positions` (l'historique est
   récupéré) **sans** toucher à la dernière position dénormalisée du tracker, ni à l'ignition, ni
   au broadcast temps réel. La baseline reste protégée — c'est elle, et elle seule, que l'incident
   du 10-11/06 a empoisonnée.
4. **Rendre la perte lisible.** Un compteur « trames écartées sans jumeau en base » par boîtier,
   sur 24 h. Un boîtier à 22 % de rejet est un signal terrain (couverture 2G) autant qu'un signal
   logiciel — et aujourd'hui rien ne le dit.

### ⚠️ Ne pas « corriger » en relâchant le critère 1

Accepter les trames antérieures **comme autoritaires** rouvrirait exactement l'incident que ce
garde-fou ferme : baseline empoisonnée → téléportation en live, distances négatives en rapports,
polylignes triangulaires en replay. Le même invariant est appliqué à trois autres étages
(`TripsService.processPosition`, le segmenter, le rendu replay) : les relâcher ensemble ferait
revenir le bug de « double trace ».

> *Le correctif porte sur ce qu'on **persiste**, pas sur ce qui fait **autorité**.* Ce sont deux
> décisions distinctes que le code d'aujourd'hui prend en une seule.

### Vérification après correctif

Le nombre de rejets **sans aucune position à ± 60 s** doit tomber vers 0, **pendant que** le
nombre de rejets ayant leur jumeau en base reste autour de **2000 / 4 jours**. Si les deux tombent
à zéro, le garde-fou a été supprimé et non réparé — et la téléportation reviendra.

Second test, sur la conséquence métier : la distance totale parcourue par EP-047-TY et FG-669-DQ
sur une semaine doit **augmenter** après correctif. Un correctif qui ne changerait aucune distance
n'aurait rien récupéré.

### ⚠️ Ce qui reste à établir

La classe « retour arrière ≤ 60 s » (273 trames, 103 trous) n'a pas été instruite séparément.
Elle est trop petite pour peser, mais son profil diffère : quasi aucun jumeau en base. À regarder
au prochain passage — il peut s'agir d'un tout autre mécanisme (horloge boîtier qui recule d'une
seconde) qu'il serait faux de fondre dans cette fiche.

### 🔴 Mise à jour du 2026-08-09 — la perte est aussi EN RAFALE : 1643 trames d'un seul bloc

La fiche décrivait une perte **diffuse**, ~1,4 % du flux réparti sur tout le parc. Le 08/08 en
montre l'autre visage. Une classe de rejet **absente des trois jours précédents** apparaît : le
retour arrière de **plus de 60 minutes**.

| Jour (`receivedAt`) | Doublon exact | Retour ≤ 60 s | Retour 1-60 min | **Retour > 60 min** |
|---|---|---|---|---|
| 05/08 | 407 | 29 | 2524 | **0** |
| 06/08 | 393 | 41 | 966 | **0** |
| 07/08 | 462 | 21 | 882 | **0** |
| **08/08** | 360 | 36 | 1730 | **1646** |

**1643 des 1646 viennent d'un seul boîtier : HD-779-MA.** Horodatages boîtier continus de
**07/08 22:58:54 à 08/08 05:16:34**, retard de 1,0 h à 6,3 h, rejeu reçu à partir de 05:16:55.

Ce que la base dit du même véhicule :

| | |
|---|---|
| Dernière position avant le trou | **07/08 22:59:54** — 43.317, -1.840, **86,7 km/h** |
| Positions entre 23:00 et 05:16 | **aucune** |
| Première position après le trou | **08/08 05:16:44** — 43.374, -1.663, **126,5 km/h** |
| Distance entre les bords du trou | **15,7 km** |
| Trames rejetées comblant l'intervalle | **1643**, dont **1636 sans position à ± 60 s** |

Le boîtier est entré dans le trou à 87 km/h et en est ressorti à 127 km/h six heures plus tard. Il
a tamponné pendant la coupure, rejoué à la reconnexion — et **tout a été écarté**, parce que la
trame temps réel avait déjà établi la nouvelle référence. C'est le mécanisme décrit par cette
fiche, observé pour la première fois **de bout en bout sur un épisode unique et datable**.

**Deux conséquences pour le correctif :**

1. **Il devra encaisser une rafale.** Un seul événement réseau produit 1600 trames à traiter d'un
   coup. Une vérification « existe-t-il déjà une position ? » ligne à ligne doit tenir ce débit.
2. **Le boîtier concerné est HD-779-MA** — celui-là même dont l'incident de téléportation des
   10-11/06 a motivé l'écriture du garde-fou. Le matériel qui justifie la garde est celui qui lui
   coûte le plus cher. Cela ne plaide pas pour relâcher la garde : cela plaide pour la proposition
   déjà écrite — **persister sans faire autorité**.

⚠️ **Réserve d'honnêteté.** `position_sampling_decisions` ne conserve pas les coordonnées des
trames rejetées : on ne peut pas prouver que les 1643 points sont géographiquement cohérents. Sont
prouvés : le trou (aucune position sur 6 h 17), la continuité temporelle des trames qui le comblent
exactement, et le fait que le véhicule roulait en y entrant comme en en sortant. La distance
moyenne au rejet (175 km) se lit vis-à-vis de la position **courante au moment du rejeu**, pas
comme une incohérence — le véhicule a manifestement voyagé loin pendant la coupure.

**Mesure du jour, à la définition du 08/08** (trou = aucune position à ± 60 s de l'horodatage rejeté) :

| Classe | Trames | Sans jumeau à ± 60 s | Distance moyenne |
|---|---|---|---|
| Doublon exact (Δt = 0) | 1627 | 11 | 0 m |
| Retour ≤ 60 s | 130 | 19 | 302 m |
| Retour 1-60 min | 6118 | **3911** | 3560 m |
| Retour > 60 min | 1646 | **1636** | 181 957 m |
| **Total `stale_devicetime`** | **9521** | **5577** | |

*(9527 `SKIPPED_REPLAY` sur 4 j au total : 9521 `stale_devicetime` + 6 `implausible_jump`.)*

**La question ouverte avance d'un point, sans se refermer.** La classe « retour ≤ 60 s » mesure ce
jour **130 trames dont 111 ont une position à ± 60 s** — profil **inverse** de celui du 08/08
(273 trames, quasi aucun jumeau). Deux points, deux profils opposés : rien à conclure, la classe
reste à instruire. Elle pèse 1,4 % du volume, elle peut attendre un troisième point.

### 🔴 Mise à jour du 2026-08-10 — deuxième rafale, sur un AUTRE véhicule

La rafale du 08/08 reposait sur un épisode unique (HD-779-MA), donc sur un seul boîtier — celui-là
même dont l'incident de juin a motivé le garde-fou. On pouvait encore croire à une particularité de
ce matériel. **Un second épisode, indépendant, est mesuré ce jour sur GS-014-NY :**

| | |
|---|---|
| Dernière position avant le trou | **09/08 14:50:22** — 15 km/h |
| Positions entre 14:50 et 15:11 | **aucune** |
| Première position après le trou | **09/08 15:11:28** — **130 km/h** |
| Trames rejetées comblant l'intervalle | **60**, à **21,5 km** en moyenne de la position courante au moment du rejeu |

Même signature de bout en bout : entrée dans le trou à basse vitesse, sortie à 130 km/h vingt et une
minutes plus tard, trames tamponnées pendant la coupure toutes écartées parce que la trame temps
réel avait déjà établi la nouvelle référence. **Deux épisodes, deux véhicules, deux jours** — le
mécanisme n'est pas propre à HD-779-MA, et le correctif doit encaisser des rafales de tailles très
différentes (60 trames ici, 1643 le 08/08).

**Mesure du jour, sur 24 h** (⚠️ fenêtre différente des passages des 08 et 09/08, qui portaient sur
4 jours — ces nombres ne se comparent pas aux précédents ; seule la **proportion** se compare) :

| Classe | Trames | Sans jumeau à ± 60 s | Part de trous | Distance moyenne |
|---|---|---|---|---|
| Doublon exact (Δt = 0) | 238 | 2 | 0,8 % | 0 m |
| Retour ≤ 60 s | 38 | 7 | 18,4 % | 155 m |
| Retour 1-60 min | **1969** | **1886** | **95,8 %** | 1143 m |
| Retour > 60 min | 0 | — | — | — |
| **Total `stale_devicetime`** | **2245** | **1895** | 84,4 % | |

Les rejets pèsent **1,55 % du flux** de décisions d'échantillonnage sur 24 h — proportion stable
depuis le 08/08 (1,4 %).

**La question ouverte prend un troisième point, et reste ouverte.** La classe « retour ≤ 60 s »
mesure 38 trames dont 7 sans jumeau (18 %) : ni le profil du 08/08 (quasi aucun jumeau), ni celui du
09/08 (quasi tous). *Trois points, trois profils.* C'est en soi une information : cette classe n'a
pas un mécanisme unique, et la fondre dans cette fiche serait faux. Elle pèse moins de 2 % du
volume — la traiter après le reste.

### Mise à jour du 2026-08-11 — aucune rafale ce jour

**Mesure sur 24 h**, même définition et même durée de fenêtre que la veille (trou = aucune position
à ± 60 s de l'horodatage rejeté) :

| Classe | Trames | Sans jumeau à ± 60 s | Part de trous |
|---|---|---|---|
| Doublon exact (Δt = 0) | 334 | 1 | 0,3 % |
| Retour ≤ 60 s | 94 | 46 | 48,9 % |
| Retour 1-60 min | **1412** | **569** | **40,3 %** |
| **Retour > 60 min** | **15** | **0** | **0 %** |
| **Total `stale_devicetime`** | **1855** | **616** | 33,2 % |

Les rejets pèsent **1,27 % du flux** (1855 sur 146 088 décisions d'échantillonnage) — proportion
stable depuis le 08/08 (1,4 % puis 1,55 %). Boîtiers les plus touchés : EP-047-TY (616 rejets),
FG-669-DQ (385), KSR370 (239) — les deux premiers sont ceux dont la fiche mesurait déjà les segments
de trajet manquants.

⚠️ **Aucune rafale.** La classe « retour > 60 min » compte 15 trames et **zéro trou**, contre 1646
le 08/08 et 60 le 09/08. Les deux épisodes documentés (HD-779-MA, GS-014-NY) n'ont pas de troisième.

⚠️ **Le taux de trous passe de 84,4 % à 33,2 % — ne pas y lire une amélioration.** Deux points ne
font pas une tendance (§4 bis), et une explication mécanique existe **sans qu'aucun défaut n'ait
changé** : le taux global est dominé par les classes de rafale, absentes ce jour. Le fait mesuré est
« 616 positions réelles écartées en 24 h » ; l'histoire « la perte diminue » n'est pas mesurée.

**La question ouverte prend un quatrième point, et un quatrième profil.** « Retour ≤ 60 s » : 94
trames dont 46 sans jumeau (**48,9 %**), après 37,7 % / 14,6 % / 18,4 %. Quatre mesures dispersées
sur toute la plage — la conclusion du 10/08 se renforce : **cette classe n'a pas un mécanisme
unique**. La fondre dans cette fiche serait faux ; l'instruire séparément quand le reste sera traité.

---

## TRK-016

**Signature** — `MapMatchingService | WARN | OSRM /match HTTP 400` → `trips.polylineMatched IS NULL`
— **en volume, et sans aucune alerte**
**Statut : 🔴 NON CORRIGÉ** · **89,8 % des trajets du 08/08 · 10 055 trajets sur 12 462 depuis le
15/04** · découvert 2026-08-09

> ### Une fonctionnalité qui échoue neuf fois sur dix depuis quatre mois n'est pas dégradée, elle est absente.

### Constat

`polylineMatched` est la trace du trajet recalée sur le réseau routier. Quand elle est nulle,
l'interface affiche la trace GPS **brute** — avec son bruit, ses angles droits et ses
allers-retours de stationnement.

| Jour | Trajets | Sans polyligne recalée | Part |
|---|---|---|---|
| 02/08 | 149 | 109 | 73,2 % |
| 03/08 | 145 | 131 | 90,3 % |
| 04/08 | 191 | 161 | 84,3 % |
| 05/08 | 202 | 188 | 93,1 % |
| 06/08 | 180 | 169 | 93,9 % |
| 07/08 | 199 | 183 | 92,0 % |
| 08/08 | 166 | 149 | **89,8 %** |
| **Depuis le 15/04** | **12 462** | **10 055** | **80,7 %** |

Sur la fenêtre de journaux mesurée (7,9 h) : **79 réponses HTTP 400 pour 79 replis en trace
brute**. Le rapport de 1 pour 1 montre que c'est le **premier** tronçon qui échoue et interrompt
tout le trajet.

### Cause racine — trois défauts distincts qui se composent

1. **Un tronçon en échec annule tout le trajet.** `map-matching.service.ts:36-40` découpe en
   tronçons de 100 points et fait `return null` à la première erreur. Un trajet de 400 points perd
   la totalité de son recalage à cause de 100 points.
2. **Le résultat n'est jamais réessayé.** `runMapMatchingAsync` persiste `polylineMatched` une fois
   ou pas du tout (`trips.service.ts:911-926`). Un échec transitoire devient **définitif**.
3. **Le fournisseur est l'instance de démonstration publique et gratuite** d'OSRM — valeur par
   défaut du code, `OSRM_BASE_URL` n'étant pas défini dans l'environnement du conteneur. Le
   commentaire du fichier l'assume comme un provisoire de V1.4 : *« demo gratuit, rate limite mais
   OK pour V1.4 sans hosting »*. Ce provisoire tient depuis avril.

### Famille — **brut**

Au sens du §7 de la procédure. Le code journalise `OSRM /match HTTP 400` et **jette le corps de la
réponse**, qui porte pourtant un `code` explicite. Le message ne nomme ni le trajet, ni le
véhicule, ni la conséquence — et il détruit l'information qui permettrait de conclure.

### Vérifié en direct, avec les paramètres exacts du code

Sondage avec des coordonnées **synthétiques** (aucune donnée client envoyée à un tiers) :

| Requête | Réponse |
|---|---|
| 4 points sur route, `radiuses=25` | **`Ok`** — le paramétrage du code fonctionne |
| Les mêmes 4 points, sans `radiuses` | `400` · `NoMatch` |
| 2 points seulement, `radiuses=25` | `400` · `NoSegment` |
| 4 points, **`radiuses=50`** | `400` · **`TooBig`** — *« Radius search size is too large for map matching »* |

> **Le correctif qui vient spontanément à l'esprit — élargir le rayon de recherche — est refusé par
> cette instance.** Il fallait le savoir avant d'écrire du code. *(Même leçon que TRK-012 correctif
> #3 : vérifier l'hypothèse d'infrastructure avant de coder.)*

Et ce n'est **pas** de la limitation de débit : le serveur répond 429 dans ce cas, pas 400.

### Ce qui n'est pas établi

Lequel des codes (`NoMatch`, `NoSegment`, autre) domine en production, et sur quel profil de trace.
Le savoir suppose de journaliser le corps de la réponse — une modification de code, hors du
périmètre de cet audit. **Ne pas conclure à sa place.**

### Correctifs proposés

1. **Journaliser le `code` du corps de la réponse**, pas seulement le statut HTTP. Une ligne, et
   elle transforme un compteur muet en diagnostic. **Préalable à tout le reste.**
2. **Ne pas annuler tout le trajet pour un tronçon.** Conserver les tronçons recalés, ne retomber
   en brut que sur celui qui échoue.
3. **Décider du provisoire.** Soit héberger une instance OSRM (`OSRM_BASE_URL` est déjà prévu,
   c'est une variable à poser), soit retirer la promesse de l'interface.

### ⚠️ Ne pas « corriger » en cachant le repli

La trace brute est un repli honnête : elle affiche une vérité bruitée plutôt qu'une jolie ligne
inventée. Le défaut n'est pas le repli — c'est qu'il soit devenu le cas **normal** sans que rien ne
le dise. *Le témoin n'est pas le défaut.*

### Vérification après correctif

La part de trajets sans polyligne recalée doit passer **sous 20 % sur une journée pleine**, **et**
les échecs restants doivent porter un `code` lisible dans les journaux. Si la part tombe sans
qu'aucun code n'apparaisse jamais, on n'a pas mesuré — on a espéré.

### Mise à jour du 2026-08-10 — septième jour au-dessus de 89 %

**92,7 % des trajets du 09/08** sans polyligne recalée (89 sur 96). Sept jours consécutifs entre
89,8 % et 93,9 % : la fonctionnalité est absente, pas dégradée. Rien n'a changé côté code ni côté
environnement (`OSRM_BASE_URL` toujours non défini, image inchangée depuis le 04/08).

### Mise à jour du 2026-08-11 — huitième jour consécutif

**90,4 % des trajets du 10/08** sans polyligne recalée (141 sur 156). Huit jours entre 89,8 % et
93,9 %, sur des volumes quotidiens allant de 96 à 199 trajets : ni le taux ni sa stabilité ne
dépendent de la charge. `OSRM_BASE_URL` reste non défini dans l'environnement du conteneur — le
provisoire de V1.4 tient depuis avril, et les correctifs #1 (journaliser le `code` de la réponse)
et #3 (décider du provisoire) n'ont pas bougé.

⚠️ Cette fiche est la seule des cinq ouvertes dont le correctif **ne dépend d'aucune autre** : ni
d'un test SMS, ni d'une rotation de clé, ni d'un accusé de remise. Une ligne de journalisation la
ferait avancer aujourd'hui.

---

## TRK-017

**Signature** — `sms-allowlist | ERROR | Allowlist SMS incomplète : <N> numéro(s) manquant(s)
rétabli(s) — le repli SMS (coupe-circuit, notifications) était inopérant pour ces destinataires.`
**Statut : 🔴 NON CORRIGÉ** · **25 numéros sur 41 effacés puis recréés en boucle, dont 24 SIM de
boîtier · 8 occurrences · découvert 2026-08-10** *(épisodes des 2026-08-09 20:25 / 22:25 et
2026-08-10 05:25 / 06:25 / 10:25 / 12:25 / 13:25 / 14:25 UTC)*

> ### Le repli du coupe-circuit se rouvre plusieurs fois par jour pour 24 boîtiers sur 43 — et rien, nulle part, ne peut nommer qui l'ouvre.

> 🔄 **Requalifié le 2026-08-10 au 2ᵉ passage.** La fiche décrivait d'abord un trou **historique** de
> treize jours rattrapé une fois. Le test daté (ci-dessous, exécuté avec 16 h d'avance) a montré
> l'inverse : la réconciliation **tourne bien**, et ce sont les entrées qui **disparaissent en
> boucle**. Un trou qui se rattrape et un trou qui se rouvre n'appellent pas le même correctif —
> c'est exactement pour ça que le premier passage a refusé de trancher.

### Constat — vérifié des deux côtés de la passerelle

| Fait | Où c'est mesuré |
|---|---|
| Numéros poussés par Tracky | **41** (43 boîtiers avec SIM + utilisateurs actifs, dédupliqués) |
| Absents au moment du rétablissement | **25**, dont **24 étiquetés `Tracker <imei>`** et 1 `User <email>` |
| Mode allowlist du tenant `tracky` | **actif** (`allowlistMode = true`) |
| Entrées `manual` (la reprise en main du 27/07) | 17, dont 10 SIM de boîtier — elles couvraient une partie du parc, pas l'autre |
| Envois SMS réels depuis le 27/07 | 44, tous « SUCCESS » — **sur les numéros présents uniquement** |

### Pourquoi ça ne pouvait produire aucune alerte

`tenants.service.ts:18-28`, côté passerelle :

```ts
async assertDestinationAllowed(tenant: Tenant, toE164: string): Promise<void> {
  if (!tenant.allowlistMode) return;
  const entry = await this.prisma.allowlistEntry.findUnique({ … });
  if (!entry) throw new ForbiddenException(`Destinataire ${toE164} hors allowlist …`);
}
```

Le refus est levé **avant** la création de la ligne `messages`. Conséquence directe : un SMS refusé
pour ce motif n'apparaît **ni** dans le journal de la passerelle (aucune ligne créée), **ni** au
centre d'alerte de Tracky. La table `messages` le confirme : 307 `queued`, 230 `received`,
29 `failed` — et **aucun refus d'allowlist**, par construction.

> Le seul chemin qui pouvait révéler ce trou est la réconciliation périodique elle-même. C'est
> exactement pour ça qu'elle a été écrite le 27/07 — et c'est la première fois qu'elle parle.

### Ce qui est démontré, et ce qui ne l'est pas

**Démontré — le trou était réel.** À 20:25, 25 numéros sur 41 manquaient. Les deux seuls chemins de
code qui écrivent une ligne `sms-allowlist` (`allowlist.service.ts:115` et `:124`) sont « j'ai
rétabli des numéros » et « la réconciliation a échoué ». Aucune ligne n'existe entre le 27/07 et le
09/08 20:25, et la rétention des erreurs est à 90 jours depuis [TRK-010](#trk-010). Une
réconciliation qui aurait tourné et abouti pendant cette période aurait produit l'une ou l'autre.

**Non démontré — pourquoi.** Les 25 entrées créées à 20:25 n'existent plus : celles présentes en
base portent toutes `createdAt = 2026-08-09 22:25:00.18`. Quelque chose les a supprimées entre les
deux passages — et **ce n'est pas la synchro de Tracky** :

- `syncAllowlist` (`tenants.service.ts:147-193`) ne supprime que les entrées `synced` **absentes de
  la liste poussée**, et Tracky journalise tout `removed > 0` au journal système ;
- `system_activity_logs` ne contient **que deux** `allowlist_synced` depuis le 27/07, toutes deux
  `+25 / -0`. Aucune suppression n'a jamais été rapportée.

Deux lectures étaient ouvertes, et elles menaient à des correctifs **opposés** :

| Lecture | Ce qu'elle implique | Verdict du 10/08 17:12 |
|---|---|---|
| **A — le cron ne tourne pas à la cadence déclarée** (`@Cron('0 25 * * * *')`, `allowlist.service.ts:106`) | Le trou datait du 27/07 et a duré 13 jours. Le correctif porte sur la **planification**. | ❌ **Écartée** — six exécutions de plus le 10/08. |
| **B — un tiers supprime les entrées `synced`** | Le cron fait son travail et répare un effacement qui recommence. Le correctif porte sur **qui appelle `DELETE /v1/allowlist/:phone`** ou `PUT /sync` avec une liste partielle. | ✅ **Retenue.** |

*Ne pas trancher sur un seul épisode* était la bonne consigne : un audit qui aurait choisi A le
09/08 aurait écrit une supervision de cron parfaitement inutile, sur un cron qui tournait déjà.
Il aura suffi d'un second passage — et d'une requête qui ne modifie rien — pour le savoir.

> ⚠️ **Ce qui reste faux dans le paragraphe ci-dessus.** « Aucune ligne n'existe entre le 27/07 et le
> 09/08 20:25 » reste vrai et vérifié, mais **n'autorise plus** à conclure que le trou datait du
> 27/07 : en régime B, une période sans ligne est une période où **rien ne manquait**. Le trou de
> treize jours était une inférence de la lecture A, et il tombe avec elle.

### ✅ Test daté — exécuté le 2026-08-10 à 17:12 UTC (2ᵉ passage), verdict : **lecture B**

Le test posé pour le 11/08 a été exécuté au passage supplémentaire du 10/08 au soir.

```sql
SELECT source, count(*), min("createdAt"), max("createdAt")
FROM allowlist_entries GROUP BY 1;
```

| `source` | n | `createdAt` min | `createdAt` max |
|---|---|---|---|
| `manual` | 17 | 2026-06-03 12:08 | 2026-07-27 13:37 |
| `synced` | **25** | **2026-08-10 14:25:00.78** | **2026-08-10 14:25:00.78** |

`createdAt` a bougé → **lecture B**. Et la lecture A est **écartée par un fait indépendant** : la
réconciliation a tourné **six fois de plus** le 10/08 (05:25, 06:25, 10:25, 12:25, 13:25, 14:25 UTC),
chaque fois `+25 / -0 (16 inchangés)`. Elle s'exécute, elle répare, et le trou revient.

**La suppression est mesurée, pas déduite** — `pg_stat_user_tables` sur `allowlist_entries` :
`n_dead_tup = 25` pour un `last_autovacuum = 2026-08-10 13:25:47 UTC`. Exactement 25 lignes
supprimées entre 13:25:47 et la lecture : le lot créé à 13:25, effacé avant celui de 14:25.
Suppression **en bloc**, de la taille exacte du lot `synced`, **jamais** sur les 17 `manual`.

⚠️ Les cumuls `n_tup_ins = 277` / `n_tup_del = 235` ne servent qu'à décrire une **forme** :
`stats_reset` est `NULL`, la date de départ des compteurs est inconnue. Aucune arithmétique de
cycles ne peut s'y appuyer.

### Fenêtres d'exposition — bornées par l'absence de ligne

L'alerte date la **fermeture** du trou, jamais son ouverture. Une heure sans ligne étant une heure
où rien ne manquait, les réouvertures du 10/08 se bornent ainsi :

| Trou ouvert dans… | Refermé à |
|---|---|
| (09/08 22:25 → 05:25] · (05:25 → 06:25] · (09:25 → 10:25] | 05:25 · 06:25 · 10:25 |
| (11:25 → 12:25] · (12:25 → 13:25] · (13:25 → 14:25] | 12:25 · 13:25 · 14:25 |

**Au moins six réouvertures en 19 h**, chacune jusqu'à 60 min. Rien entre 00:25 et 04:25, ni depuis
14:25 (intact 2 h 47 à la lecture). Le phénomène est **irrégulier**, pas horaire.

### Qui supprime ? Six pistes fermées — et l'angle mort EST le constat

| Piste | Pourquoi elle est écartée |
|---|---|
| La synchro de Tracky | 10 `allowlist_synced` depuis l'origine, **toutes en `-0`**. Ce chemin n'a jamais supprimé. |
| La route d'admin `DELETE /admin/sms/allowlist/:phone` | Passe par l'intercepteur d'audit. Sur 24 h : 22 `http_post`, 1 `http_patch`, **aucun `http_delete`**. |
| Une 2ᵉ instance de Tracky | Un seul `tracky-api` parmi les 29 conteneurs du VPS. |
| `vizyo-manager` | Une occurrence du mot dans un catalogue de services. Aucun code client. |
| Un ménage programmé côté passerelle | Seul minuteur de `vizyo-texto/src` : la relance des webhooks. Aucun `@Cron`. |
| Un tenant concurrent | La table `tenants` n'en contient qu'un. |

Reste l'angle mort, **et il est lui-même le défaut à corriger** :

| Instrument | État |
|---|---|
| Journal d'accès HTTP du reverse proxy | **absent** — il tourne sans `--accesslog` |
| Journal de requêtes de la passerelle | **inexistant** — 5 tables, aucune de trace d'appel |
| `docker logs` du relais | **ne rend pas la main** sur cet hôte |
| Exposition du point d'entrée | **publique** — l'appelant peut être hors du VPS (poste de dev inclus) |

*Tant qu'une mutation d'allowlist n'est pas attribuable, tout correctif viserait au jugé.*

### 🗓️ Nouveau test daté — au passage du 2026-08-11

1. Relire `allowlist_entries` : si `createdAt` des `synced` a **encore** bougé, le phénomène est
   confirmé sur un troisième jour → ce n'est plus un épisode, c'est un régime permanent.
2. Compter les lignes `sms-allowlist` du 10/08 18:00 au 11/08 03:00 UTC. **Zéro ligne la nuit**
   (comme entre 00:25 et 04:25 le 10/08) alors qu'il y en a le jour orienterait vers un appelant
   **actif aux heures ouvrées** — un poste de développement plutôt qu'un automate. C'est
   l'unique discriminant disponible sans toucher au code.
3. **Condition d'échec écrite** : si le passage se contente de recompter les réouvertures sans
   trancher le point 2, il n'aura rien appris de plus que celui-ci.

### ✅ 2026-08-10 19:25 UTC — **L'APPELANT EST NOMMÉ. Statut : cause racine trouvée.**

Le journal des appels a été déployé à 19:15. **Dix minutes plus tard, il avait la réponse** —
deux appels à `PUT /v1/allowlist/sync`, à quatre dixièmes de seconde d'écart :

| Heure | IP source | Numéros poussés | Effet | Verdict |
|---|---|---|---|---|
| 19:25:01.582 | **82.67.153.51** *(adresse publique, hors du VPS)* | **1** | aurait supprimé **25** entrées | 🛑 `removals_blocked` |
| 19:25:01.988 | `172.18.0.1` *(Tracky, sur le VPS)* | 41 | 0 ajout, 41 inchangés | ✅ `ok` |

**Les deux portent la MÊME clé d'API** (`apiKeyPrefix` identique), et **la même minute de cron**.
Ce n'est donc pas un tiers hostile : c'est **une seconde instance de Tracky**, exécutée hors du
VPS avec la clé de PRODUCTION de la passerelle SMS, dont la base ne contient qu'**un seul**
boîtier avec SIM. Son `@Cron('0 25 * * * *')` pousse sa liste d'un numéro ; la réconciliation
supprimait alors les 25 autres, et celle du VPS les recréait derrière. D'où :

- la cadence **exactement horaire à h:25** — même code, même minute ;
- le caractère **irrégulier** dans la journée — la machine n'est pas toujours allumée, ce qui
  colle au discriminant « appelant actif aux heures ouvrées » posé la veille ;
- l'**absence totale de trace** côté prod — c'est une autre instance, avec son propre journal ;
- la suppression des seules entrées `synced`, jamais des `manual`.

**La garde a tenu dès son premier passage** : `createdAt` des 25 entrées vaut toujours
`14:25:00.78`. Pour la première fois depuis le 09/08, elles ont survécu à un h:25.

> 🔐 **Ce qui reste à faire est une décision humaine, pas du code.** Une instance de
> développement détient la clé d'API de la passerelle SMS de production, et le point d'entrée
> est joignable depuis Internet. Le correctif durable est de **révoquer et rotationner cette
> clé**, puis de donner à l'environnement de développement **son propre tenant** (ou aucune
> clé). Tant que la clé est partagée, la garde empêche le dégât mais la cause demeure.

⚠️ **Ne pas conclure « c'est réglé » et retirer la garde.** Elle est ce qui transforme un
effacement silencieux en ligne de journal lisible. Elle reste utile après la rotation de clé.

### ✅ 2026-08-10 (soir) — correctifs DÉPLOYÉS

Sur demande du propriétaire. **En production depuis le 2026-08-10 19:15 UTC** (passerelle) et
19:39 UTC (Tracky, `main` @ `d5e5fb1`, `restarts=0`, API `healthy`). Migration
`20260810180000_allowlist_audit_log` appliquée.

| Où | Ce qui est écrit | Branche |
|---|---|---|
| `vizyo-texto` *(déployé)* | Table `allowlist_audit_logs` + migration ; **une ligne par appel** sur les 4 chemins de mutation, y compris à diff vide et y compris quand l'appel est retenu ; `trust proxy` + conservation du `X-Forwarded-For` **brut** ; **garde anti-suppression de masse** ; `GET /v1/allowlist/audit`. 11 tests (le dépôt n'en avait aucun). | `main` @ `80e04fe` |
| `tracky` *(déployé)* | Trace d'exécution inconditionnelle (`allowlist_reconciled`) ; alerte par **épisode** au lieu d'une ligne par réparation, avec rappel quotidien tant qu'il dure ; remontée d'une suppression retenue. 7 tests. | `main` @ `d5e5fb1` |

**Deux points de conception qui méritent d'être retenus :**

1. **`trust proxy` était absent du relais.** Sans lui, `req.ip` vaut l'IP de Traefik pour
   *tout le monde* : le journal aurait été écrit, aurait eu l'air de fonctionner, et
   n'aurait distingué personne. Le `X-Forwarded-For` brut est conservé **en plus**, pour
   qu'une erreur de configuration ne détruise pas la seule donnée qui identifie l'appelant.
2. **La garde retient les suppressions mais laisse toujours passer les ajouts.**
   L'asymétrie est voulue : un ajout élargit la couverture, une suppression la retire — et
   un refus d'allowlist ne laisse aucune trace côté envoi. En cas de doute, on penche du
   côté où les SMS partent. Un appelant qui veut vraiment supprimer en masse le déclare.

⚠️ **La garde ne remplace pas le journal** — et c'est bien le journal qui a nommé l'appelant
dix minutes après sa mise en ligne (voir plus haut). La garde, elle, a empêché le dégât dans
la même heure. Les deux étaient nécessaires : l'une protège, l'autre explique.

🔴 **Un piège payé pendant ce déploiement.** La migration a d'abord été générée avec
`prisma migrate diff --script > fichier 2>&1` : la bannière d'information de Prisma
(encadré semi-graphique) s'est retrouvée **dans le SQL**, et `migrate deploy` a échoué au
démarrage du conteneur. Sans le smoke-boot jetable, la passerelle SMS serait partie en
crash-loop — c'est-à-dire le repli du coupe-circuit moteur hors service. *Ne jamais rediriger
stderr dans un fichier destiné à être exécuté.* La migration en échec a dû être marquée
`--rolled-back` avant de rejouer (elle n'avait rien appliqué : `applied_steps_count = 0`).

### Correctifs proposés

0. 🔴 **Rendre attribuable toute mutation de l'allowlist, côté passerelle — LE préalable.**
   Journaliser l'auteur de `PUT /v1/allowlist/sync` et de `DELETE /v1/allowlist/:phone` : tenant, IP
   source, nombre d'entrées poussées, diff appliqué. **Une ligne par appel, y compris à diff vide.**
   Sans ça, « qui efface 25 numéros plusieurs fois par jour » restera sans réponse au prochain
   passage comme à celui-ci. *(Dépôt `vizyo-texto`, hors périmètre d'écriture de cet audit.)*
1. ⚪ **Rendre l'exécution de la réconciliation prouvable.** *Partiellement périmé au 10/08 : ce
   passage a prouvé qu'elle s'exécute.* Garde sa valeur pour distinguer « a tourné, rien à faire »
   de « n'a pas tourné », mais **n'est plus le préalable** — le nº 0 l'a remplacé.
2. **Alerter sur l'ÉTAT, pas seulement sur la RÉPARATION.** La ligne actuelle se déclenche quand la
   dérive est **déjà corrigée** : elle raconte le passé. Ce qui manque est une vérification
   d'inventaire — `AllowlistService.status()` expose déjà `missing[]` — remontée quand un numéro
   reste absent **entre deux réconciliations**. Un boîtier dont la SIM sort de l'allowlist doit être
   visible pendant qu'il l'est, pas une fois rentré.
3. **Refuser de couper un moteur dont le repli SMS n'est pas joignable.** Le repli existe parce que
   le canal TCP n'est pas fiable, et [TRK-014](#trk-014) prouve qu'aucun boîtier n'a jamais accusé
   réception d'une commande. Un coupe-circuit dont les deux voies sont muettes doit le **dire** au
   moment de la demande, pas être tenté dans le vide.
4. **Tracer le refus côté passerelle.** `assertDestinationAllowed` lève un `ForbiddenException` sans
   rien persister. Écrire une ligne `messages` en statut refusé (ou un compteur par tenant) donnerait
   à ce défaut la trace qu'il n'a pas — dans le dépôt `vizyo-texto`, hors périmètre de cet audit.

### ⚠️ Ne pas « corriger » en désactivant le mode allowlist

Passer `allowlistMode` à `false` ferait disparaître les 403 en une ligne — et ouvrirait l'envoi de
SMS à n'importe quel numéro, sur une passerelle facturée à l'envoi. L'allowlist est une garde de
dépense et d'abus, elle fait son travail. *Le témoin n'est pas le défaut : ce qui manque est la
synchro, pas la serrure.*

### ⚠️ Ne pas non plus se contenter d'un `PUT /sync` manuel

Il rétablirait l'état sans rien apprendre du mécanisme — et le régime B le rend en plus **inutile** :
le cron le fait déjà tout seul, six fois par jour, et l'effacement revient derrière. `createdAt` des
entrées `synced` reste la **mesure en cours** : ne pas la perturber par une synchro manuelle, c'est
le seul témoin de la prochaine suppression.

### Vérification après correctif

**Le vrai test porte sur l'attribution, pas sur le compteur.** Un correctif est acquis quand :

1. chaque `PUT /v1/allowlist/sync` et chaque `DELETE /v1/allowlist/:phone` laisse une ligne nommant
   son appelant, **y compris à diff vide** — c'est ce qui permettra de désigner le coupable ;
2. **puis seulement** `AllowlistService.status().missing` reste vide sur 7 jours consécutifs.

Faire (2) sans (1) est le piège : l'écran se viderait, le trou continuerait de se rouvrir entre deux
lectures, et on aurait reproduit exactement la cécité qu'on vient de mettre deux passages à percer.
*Un garde-fou dont on ne peut pas prouver qui le désarme ne garde rien.*

### 🔴 Mise à jour du 2026-08-11 — la garde tient, l'appelant tourne la nuit, la clé n'a pas bougé

**La garde a tenu six h:25 d'affilée.** `createdAt` des 25 entrées `synced` vaut toujours
`2026-08-10 14:25:00.78`, et `n_dead_tup` reste à 25 pour un `last_autovacuum` du 10/08 13:25 :
**aucune suppression depuis la veille**. Le correctif « exécution prouvable » fonctionne aussi —
5 `allowlist_reconciled` en base système (20:25 → 00:25), un par heure, y compris à zéro.

**L'appelant, lui, n'a pas cessé.** `allowlist_audit_logs`, 11 appels tracés en 6 h :

| Heure UTC | 19:25 | 20:25 | 21:25 | 22:25 | 23:25 | 00:25 |
|---|---|---|---|---|---|---|
| `172.18.0.1` (Tracky, VPS) — 41 numéros | ✅ `ok` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `82.67.153.51` (hors VPS) — **1** numéro | 🛑 `removals_blocked` | — | 🛑 | 🛑 | 🛑 | 🛑 |

**Cinq tentatives d'effacement de masse retenues**, motif identique : « 25 suppression(s) au-delà du
plafond ». Même préfixe de clé d'API dans les deux colonnes.

### 🔄 Le discriminant posé la veille est tranché — et il retourne l'hypothèse

Le test daté nº 2 proposait : *« zéro ligne la nuit orienterait vers un appelant actif aux heures
ouvrées — un poste de développement plutôt qu'un automate »*. L'appelant a frappé à **21:25, 22:25,
23:25 et 00:25 UTC**, soit 23:25 → 02:25 heure de Paris. **La machine tourne la nuit** ; un seul
créneau manque (20:25). L'irrégularité observée les 09 et 10/08 ne s'explique donc **pas** par des
horaires de bureau.

> ⚠️ **Et l'instrument proposé par cette fiche s'est périmé dans le même geste.** Compter les lignes
> `sms-allowlist` ne mesure plus rien : zéro ligne depuis le 10/08 14:25, mais **deux causes se
> superposent** — la garde empêche le trou, et l'alerte est passée par épisode. Un zéro qui a deux
> explications n'est pas une mesure. Lire `allowlist_audit_logs`, et rien d'autre.

### 🔴 Défaut résiduel, constaté ce jour — les blocages sont invisibles depuis Tracky

Les cinq suppressions retenues n'apparaissent **nulle part** dans Tracky : ni `error_logs`, ni
journal système, ni écran. Elles n'existent que dans `allowlist_audit_logs`, côté passerelle,
qu'aucune interface ne lit. La remontée « suppression retenue » livrée le 10/08 ne se déclenche que
sur la réponse à l'appel **de Tracky** — et Tracky n'est jamais bloqué, puisque c'est lui la
victime. *Un garde-fou qui protège en silence redevient invisible dès qu'on cesse de l'interroger
à la main.*

**Correctif à ajouter (nº 5) :** remonter à Tracky les blocages **subis par les autres appelants**.
Le plus simple sans coupler les deux dépôts : que la réponse de `PUT /v1/allowlist/sync` porte le
nombre de blocages survenus depuis le dernier appel du tenant, et que la réconciliation en fasse une
ligne d'alerte. Une garde dont on ne voit pas les déclenchements finit par être retirée comme
inutile.

### 🗓️ Test daté — au passage du 2026-08-12

**La clé a-t-elle été rotationnée ?** Relire `allowlist_audit_logs` : des appels depuis
`82.67.153.51` portant le même préfixe de clé signifient que la cause est intacte et que seule la
garde travaille.
**Condition d'échec écrite** : recompter les blocages sans dire si la clé a changé n'apprendrait
rien de plus que ce passage.

---

## TRK-018

**Signature** — *(absence de preuve, pas une ligne d'erreur)* `engine_control_commands | status =
SENT | ackedAt IS NULL | lastError = "Envoyé via SMS (TCP indisponible)"` + `messages | status =
queued` — **définitivement, des deux côtés**
**Statut : 🔴 NON CORRIGÉ** · **112 commandes moteur reparties en SMS depuis le 2026-06-03 ·
0 acquittée · 0 message jamais sorti de `queued` sur 310** · découvert 2026-08-11

> ### Un véhicule est immobilisé et redémarré chaque nuit par un canal dont personne, à aucun étage, ne peut dire s'il transmet.

### Constat — mesuré des deux côtés de la passerelle

| Mesure | Valeur | Où |
|---|---|---|
| Commandes moteur reparties en SMS | **112** depuis le 2026-06-03 | `engine_control_commands.lastError LIKE 'Envoyé via SMS%'` |
| …dont acquittées (`ackedAt`) | **0 — sans exception** | idem |
| Sur les 7 derniers jours | **24**, sur **12 véhicules** | idem |
| Statut final de ces commandes | `SENT`, **définitivement** | idem |
| Messages `engine-control-fallback` côté passerelle | **112**, tous en **`queued`** | `messages.context->>'source'` |
| Messages sortants ayant jamais dépassé `queued` (sur 310 depuis le 03/06) | **0** | `messages` |
| Seuls états terminaux jamais écrits | **29 `failed`**, tous le 2026-06-09 | `messages` |

**Les deux comptages concordent** sur la fenêtre de 7 jours — 24 côté Tracky, 24 côté passerelle.
Sur cette période, aucun SMS n'a donc été perdu **avant** la passerelle : le trou d'allowlist de
[TRK-017](#trk-017) n'a rien avalé ici. C'est un résultat négatif utile, et il vaut d'être écrit :
il évite d'attribuer à cette fiche ce qui appartient à l'autre.

### Ce qui est démontré, et ce qui ne l'est pas

**Démontré :** aucune des deux couches ne porte de preuve de remise. Tracky écrit `SENT` et n'y
revient jamais ; la passerelle écrit `queued` et n'y revient jamais. Le `providerId` est bien
renseigné — la passerelle a donc remis le message à un fournisseur — mais **aucun accusé de remise
n'a jamais été enregistré, pour aucun message, depuis la création de la table**.

**Non démontré :** que les SMS n'arrivent pas. Ce constat est une **cécité**, pas une panne. C'est
précisément ce qui l'a laissée passer dix semaines : un canal muet et un canal sain se ressemblent
exactement quand rien ne les mesure.

⚠️ **Piège écarté en cours d'enquête.** Le canal entrant de la passerelle est silencieux depuis le
2026-07-13 (dernier message `IN`, dernier `webhook_deliveries`). Tentant d'y voir une réception
cassée. **Faux :** les 230 entrants étaient les réponses à la campagne de provisionnement
(202 messages `provision`), qui s'est terminée **le même jour**. Rien ne prouve que la réception
soit en panne ; rien ne prouve qu'elle marche. *Une coïncidence de dates n'est pas un mécanisme.*

### Le cas le plus net — EY-613-MF, quatorze immobilisations par semaine sans confirmation

| | |
|---|---|
| Coupures nocturnes reparties en SMS (7 j) | **7 CUT + 7 RESTORE**, à 18:00 et 03:00 UTC |
| Acquittées | **0** |
| Pourquoi le TCP est indisponible | Le boîtier n'émet qu'**une trame par heure** à l'arrêt (heartbeat Coban ACC OFF) |
| `confirmationExpected` | `false` — le système **sait** qu'il n'attendra rien |

Ce véhicule est coupé chaque soir et redémarré chaque matin par un canal sans retour. Le
`confirmationExpected = false` est honnête sur l'intention, mais il transforme une absence de preuve
en état normal : plus rien ne distingue « le SMS est passé » de « le SMS est parti dans le vide ».

### Défaut aggravant — le champ qui porte l'information est un champ d'erreur

`lastError` contient « Envoyé via SMS (TCP indisponible) », qui n'est pas une erreur mais une
**information de routage**. Famille **mensonger** au sens du §7 : un lecteur qui trie sur
`lastError IS NOT NULL` compte 112 échecs qui n'en sont pas. C'est exactement le défaut du
`outcomeReason` dénoncé par [TRK-007](#trk-007) — le champ dont le nom annonce une chose et le
contenu en livre une autre.

### Défaut jumeau — une commande moteur n'a pas de fin de vie

Sur les 7 derniers jours, **49 commandes** restent `SENT` sans acquittement (31 `CUT`, 18 `RESTORE`),
dont 24 par le repli SMS et 25 par TCP. Depuis avril, **218** au total. C'est la même famille que
[TRK-007](#trk-007) sur `fix_continuous` : rien ne solde jamais ces lignes, et la file n'est plus une
file. La leçon de TRK-007 s'applique telle quelle — **l'échéance doit être purement temporelle**, et
surtout pas conditionnée à une confirmation qui, ici comme là, n'arrive jamais.

*(Sur ces 25 non-SMS, 20 concernent FZ-862-VY et FS-253-HR — les deux véhicules sans fix GPS de
[TRK-001](#trk-001), dont la chute d'ignition ne peut pas être observée. Ce n'est pas un défaut
supplémentaire : c'est la même cause matérielle, vue depuis une autre table.)*

### Correctifs proposés

1. **Faire remonter l'accusé de remise du fournisseur — LE préalable.** Tant qu'un message reste
   `queued` à vie, aucune des questions suivantes n'est décidable. Si le fournisseur n'expose aucun
   retour, l'écrire noir sur blanc et passer au nº 2 : ce qu'on ne peut pas mesurer, on doit au moins
   cesser de le présenter comme acquis. *(Dépôt `vizyo-texto`, hors périmètre d'écriture de cet
   audit.)*
2. **Donner une fin de vie aux commandes moteur.** Échéance **purement temporelle** (proposition :
   30 min), close en `SENT_UNCONFIRMED` — un état distinct de `FAILED`, parce que « nul ne sait » et
   « a échoué » ne sont pas la même information. Voir la leçon de [TRK-013](#trk-013) : le défaut
   n'était pas la clôture, c'était de conclure sans comparer.
3. **Sortir l'information de routage du champ d'erreur.** Un champ `channel` (`TCP` / `SMS`) dit ce
   que `lastError` raconte aujourd'hui, sans mentir sur sa nature.
4. **Rendre l'état lisible.** Une section « immobilisations non confirmées » — un compteur des
   commandes `SENT` de plus de 24 h, par véhicule. Aujourd'hui l'information existe en base et
   n'apparaît sur aucun écran.

### ⚠️ Ne pas « corriger » en marquant ces commandes acquittées d'office

Écrire `ackedAt` à l'envoi ferait disparaître les 112 lignes et supprimerait la seule trace de la
question. C'est le contraire d'un correctif : le coupe-circuit est une garde de sécurité, et une
garde qu'on croit armée sans preuve est plus dangereuse qu'une garde qu'on sait muette.
*Le témoin n'est pas le défaut.*

### ⚠️ Ne pas non plus conclure que le repli SMS est mort

Rien ici ne le montre. Trois canaux se cumulent pour rendre le coupe-circuit invérifiable — le TCP
sans ACK ([TRK-014](#trk-014), prouvé), l'allowlist qui refusait sans trace ([TRK-017](#trk-017)),
et l'absence d'accusé de remise (cette fiche) — mais **aucun des trois ne prouve qu'une coupure
n'a pas eu lieu.** Ce qui est établi est qu'aucun d'eux ne peut prouver qu'elle a eu lieu.

### Vérification après correctif

1. Au moins un message porte un état postérieur à `queued`, **ou** le journal montre des échecs de
   remise datés — les deux résultats sont utiles, et le second autant que le premier ;
2. **et** le nombre de commandes moteur `SENT` de plus de 24 h tend vers 0, **sans** que le nombre de
   coupures demandées ait baissé. Si les deux tombent ensemble, on a supprimé la fonctionnalité, pas
   le défaut.

### 🗓️ Test daté — au passage du 2026-08-12

Compter les `engine_control_commands` restées `SENT` au-delà de 24 h. Le chiffre doit être **stable
ou croissant** tant qu'aucune fin de vie n'existe. **Condition d'échec :** s'il baisse sans qu'aucun
correctif ait été livré, c'est qu'un autre chemin les efface — et il faut le trouver **avant** tout
le reste, parce qu'il rendrait toute mesure ultérieure fausse.

---

## TRK-009

**Signature** — `TRACKER_OFFLINE | lastSeenAt IS NULL | vehicleId IS NULL`
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04)* · 3 boîtiers sur 6 · 2026-08-03
*(Le comptage brut reste 6 dans la collecte, pour rester comparable ; l'écran, lui, en affiche 3.)*

### Constat
La section « Trackers OFFLINE > 1 h » du centre d'alerte comptait 6 boîtiers. Trois d'entre eux
(`864035054756027`, `864035054576169`, `864035054756197`) ont `lastSeenAt = NULL` et **aucun
véhicule rattaché** : ce sont des boîtiers en stock, **jamais mis en service**.

Ils ne sont pas *tombés* — ils ne se sont jamais levés. Les compter comme « hors ligne » gonfle
le compteur d'un tiers avec du matériel qui va parfaitement bien.

### Les 3 autres sont de vraies pannes terrain (🔵)
| IMEI | Plaque | Muet depuis |
|---|---|---|
| `864035053276839` | FV-941-LZ | 2026-04-28 — **connu**, planning actif, décision métier assumée |
| `863378070030776` | FL-787-KV | 2026-06-05 |
| `864035054756292` | *(aucune)* | 2026-07-01 |

### Correctif proposé
Exclure de l'alerte « hors ligne » les boîtiers jamais vus **et** non rattachés à un véhicule
(`lastSeenAt IS NULL AND vehicleId IS NULL`) dans `admin-alerts.controller.ts`. Les exposer
plutôt comme « en stock, jamais mis en service » — c'est une information d'inventaire, pas une
panne.

⚠️ Garder l'alerte pour un boîtier `lastSeenAt IS NULL` **rattaché à un véhicule** : là, c'est
une pose qui a échoué, et c'est un vrai signal.

---

## TRK-010

**Signature** — *(défaut de plateforme, pas une ligne d'erreur)*
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04 — `ERROR_LOGS_RETENTION_DAYS=90`)* · 2026-08-03

### Le centre d'alerte se vide tout seul
`ERROR_LOGS_RETENTION_DAYS` a pour défaut **30 jours** (`env.validation.ts`) et **n'est pas
défini** dans l'environnement du conteneur `tracky-api`. `log-cleanup.service.ts` supprime donc
chaque nuit tout ce qui dépasse 30 jours :

```ts
this.prisma.errorLog.deleteMany({ where: { createdAt: { lt: errorThreshold } } })
```

Conséquence directe : **une erreur jamais corrigée disparaît d'elle-même à J+30.** La consigne
« on ne clear pas tant que ce n'est pas corrigé » est contournée par le ménage automatique — et
sans bruit, puisque personne ne remarque une ligne qui s'efface.

### Parade déjà en place
Ce référentiel. Une fiche survit à la purge, garde la date de première apparition et le compteur
cumulé. C'est précisément pour ça qu'il existe.

### Correctif proposé (optionnel)
Si l'on veut aussi garder les *lignes* : porter `ERROR_LOGS_RETENTION_DAYS` à 90 dans
`deploy/vps/.env.prod`. Sans surprise de volume — 12 lignes en 6 jours, on est très loin d'un
problème de place.

---

## TRK-011

**Signature** — *(absence d'alerte)* `gps-integrity | AUCUNE LIGNE | perte GPS ≥ <DURÉE> dans une
zone morte `CONFIRMED_BENIGN``
**Statut : 🟢 CORRIGÉ** *(livré le 2026-08-04, vérifié en prod le 05/08)* · 2 véhicules qui étaient
définitivement muets · découvert 2026-08-04

> ### ⚠️ Rectification du 2026-08-06 — la dédup est par **24 h**, pas par épisode
>
> Cette fiche et le commentaire du détecteur annonçaient « une ligne par dépassement ». C'est
> faux : `alerts.service.ts:156` fixe `dedupWindowMs = 24 h`, et c'est **volontaire et
> documenté** — la dédup ignore l'acquittement, sinon acquitter l'alerte (le geste normal pour
> vider le centre) en ferait recréer une au tick suivant.
>
> Conséquence pratique : **un épisode qui dure produit une ligne par jour.** Les deux lignes des
> dernières 24 h (FS-253-HR le 05/08 à 13:10, FZ-862-VY à 19:45) sont les rappels quotidiens des
> deux premières, à 24 h et 5 min près — pas des doublons, et pas des épisodes nouveaux.
>
> Un audit qui aurait cru la fiche aurait ouvert une enquête pour rien. *Une fiche qui décrit un
> mécanisme doit être vérifiée sur le code, pas recopiée d'un passage à l'autre.*

> ### Ce défaut ne produit rien. C'est précisément le problème.

### Constat
`FS-253-HR` (`864035054757027`) est **vivant** — `lastSeenAt` et `lastNoFixAt` frais à la minute,
donc il émet activement des trames sans verrou GPS — et **sans position depuis 11,9 h**
(dernière position le 03/08 à 13:02). Il n'a produit :

- **aucune ligne `error_logs`** — jamais, sur les 30 jours de rétention ;
- **aucune alerte véhicule `GPS_LOST`** — aucune sur 10 jours pour cette plaque.

Il est passé sous tous les radars, alors qu'il coche exactement la définition du défaut que
[TRK-001](#trk-001) détecte pour d'autres véhicules.

### Cause racine
`gps-integrity.service.ts` interrompt le traitement **avant** toute création d'alerte dès que la
zone morte est confirmée bénigne :

```ts
if (zone && zone.status === GpsDeadZoneStatus.CONFIRMED_BENIGN) {
  suppressed++;
  continue;              // ← ni alerte flotte, ni ErrorLog
}
```

Il n'existe **aucun test sur la durée de la perte**. La confirmation opérateur porte sur un
**lieu** (« ce parking souterrain est normal »), mais elle est appliquée à un **épisode de durée
quelconque**.

> **En une phrase :** une antenne morte sur un véhicule garé dans son parking habituel serait
> strictement indistinguable d'un stationnement normal — et ne serait jamais signalée.

C'est le trou même que ce module a été écrit pour combler. Son en-tête cite l'incident **FS-253**
et le résume ainsi : « RIEN ne le signalait ». Le véhicule aujourd'hui silencieux est `FS-253-HR`.

### Périmètre — il s'élargit tout seul

| Zone | Véhicule | Statut | Étiquette | Épisodes | Depuis |
|---|---|---|---|---|---|
| `79a8d0f2…` | FS-253-HR | `CONFIRMED_BENIGN` | Parking souterrain (Toulouse) | 5 | 2026-07-15 |
| `879699a3…` | FZ-862-VY | `CONFIRMED_BENIGN` | Parking souterrain (Toulouse) | 1 | **2026-08-03 19:35** |

Le second verrou vient d'être posé : l'alerte de FZ-862-VY a été levée à 19:35:15 et **acquittée
à 19:36:32** — une minute plus tard, la zone était confirmée bénigne. Ce véhicule était à 7,4 h
sans fix au moment de la collecte, et **n'alertera plus jamais à cet endroit**.

Le nombre de véhicules muets **augmente d'un à chaque confirmation opérateur**. Or confirmer une
zone est précisément ce qu'on demande à l'opérateur de faire : le geste vertueux creuse le trou.

### Correctif proposé — borner la suppression, pas la supprimer
1. **Plafond de silence configurable** `GPS_DEADZONE_MAX_SILENCE_H` (défaut **24 h**). Au-delà,
   alerter malgré la zone bénigne. Calibrage vérifié sur les données du 2026-08-04 : un
   stationnement de nuit habituel (11,9 h) reste silencieux ; une perte de 26 h parle.
2. **Message distinct**, qui dit pourquoi il parle malgré la zone : « perte GPS de 26 h dans une
   zone pourtant confirmée normale (parking souterrain, 5 épisodes) — durée anormale, antenne à
   vérifier. » Un message qui ne dirait pas cela enverrait l'opérateur reconfirmer une zone déjà
   confirmée — et il la reconfirmerait, à raison.
3. **Dédup par épisode**, comme le reste du module : une ligne par dépassement, pas une par tick
   de 5 min.

### ⚠️ Pourquoi pas un seuil adaptatif tout de suite
La donnée n'existe pas. `GpsLossEvent` porte `lostAt` et `detectedAt`, **mais pas de
`recoveredAt`** : la durée réelle des épisodes passés n'est pas mesurable en l'état. Un seuil
calculé sur l'historique de la zone (plus fin que 24 h fixes) suppose d'abord d'enregistrer la
fin d'épisode. Le plafond fixe est le correctif applicable **aujourd'hui**.

### ⚠️ Ne pas retirer la suppression
C'est le cœur de la fonctionnalité « zones mortes » : ne plus re-signaler un parking habituel, ne
plus faire déplacer quelqu'un pour rien. *Corriger la borne, pas la garde.*

### Vérification après correctif
Une perte dépassant le plafond dans une zone bénigne produit une ligne — **et un stationnement de
nuit ordinaire n'en produit toujours aucune**. Le second point est le vrai test : un correctif qui
ferait re-crier la zone à chaque perte aurait annulé la fonctionnalité.

---

## Journal des passages

| Date | Lignes `error_logs` | Signatures connues | Nouvelles | Ajoutées par |
|---|---|---|---|---|
| 2026-08-11 | 31 (8 sur 24 h — **toutes antérieures aux correctifs du soir** ; **0 ligne** sur les 6 h qui les suivent) | 17 revues ; **TRK-014 tranché** (silence PROUVÉ, garde ACK vérifiée), 3 correctifs confirmés en prod, 2 en-têtes recalés sur `main` | 1 (TRK-018) | agent d'audit |
| 2026-08-10 *(2ᵉ passage, 17:12 UTC)* | 31 (10 sur 24 h — dont **6 fois la même** ligne `sms-allowlist`) | 17 revues ; **TRK-017 requalifié** (test daté tranché : lecture B), TRK-012 revoit un boîtier FAILING | 0 | agent d'audit *(passage supplémentaire demandé)* |
| 2026-08-10 | 23 (3 sur 24 h — 2 d'une signature inédite, 1 rappel GPS attendu) | 16 revues ; TRK-015 confirmé en rafale sur un 2ᵉ véhicule | 1 (TRK-017) | agent d'audit |
| 2026-08-09 | 20 (1 sur 24 h — l'alerte de plafond **attendue**, TRK-011 non régressé) | 15 revues ; TRK-015 étendu à la perte en rafale | 1 (TRK-016) | agent d'audit |
| 2026-08-08 | 19 (**0 sur 24 h** — les 2 épisodes GPS longs se sont refermés) | 14 revues ; TRK-001 clos sur ses deux épisodes | 1 (TRK-015) | agent d'audit |
| 2026-08-07 | 19 (2 sur 24 h, toutes deux des rappels à 24 h) | 13 revues, 2 fiches rectifiées sur le code (TRK-007, TRK-008) | 1 (TRK-014) | agent d'audit |
| 2026-08-06 | 17 (2 sur 24 h, toutes deux des rappels à 24 h) | 12 revues, 6 en-têtes de fiche recalés sur l'index | 1 (TRK-013) | agent d'audit |
| 2026-08-05 | 15 (3 sur 24 h) | 11 revues, 9 confirmées corrigées en prod | 1 (TRK-012) | agent d'audit |
| 2026-08-04 | 12 (0 nouvelle) | 10 revues | 1 (TRK-011) | agent d'audit (1er passage automatique) |
| 2026-08-03 | 12 | — | 10 (amorçage) | audit manuel (session de création) |
