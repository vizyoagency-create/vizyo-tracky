# Feuille de route — chantier « Rapports d'activité »

**3 septembre 2026** · périmètre : la page `/reports`, ses exports (PDF, Excel, CSV, rapport de vitesse), le rapport hebdomadaire envoyé par courriel, les blocs d'analyse de trajet et les replays.

---

## Résumé

Un audit croisé en 7 lectures indépendantes a produit **154 constats** (65 bugs, 26 manques fonctionnels, 63 améliorations). Les 65 bugs ont été rejoués contre le code par une vérification contradictoire : **56 confirmés** (3 bloquants, 29 majeurs, 24 mineurs), **9 réfutés**.

Au moment où ce document a été écrit, 22 de ces bugs étaient réparés, 6 partiellement, 28 ouverts. Deux lots livrés dans la foulée en ont refermé une grande partie : **chaque ligne de la section « Ce qui reste » a été relue une par une et porte la mention FAIT quand elle l'est**. Se fier aux lignes, pas à un total. Le réparé touche ce que le client voit le plus : les journées se comptent en jours civils de Paris partout, le PDF ne finit plus par une page blanche et annonce « du … au … inclus », le CSV respecte le véhicule filtré à l'écran, l'Excel et le PDF donnent la même vitesse moyenne, et le rapport hebdomadaire est réglable par société avec son PDF réellement joint.

> ⚠️ **3 septembre, en fin de matinée — un chantier plus grave a été ouvert.** Le propriétaire a
> signalé que les excès de vitesse sont faux, que les notifications n'arrivent pas et que le score de
> conduite ne veut rien dire. L'enquête sur les données de production lui donne raison sur tous les
> points, et en révèle d'autres. Voir **« Chantier prioritaire — les excès de vitesse et leurs
> alertes »** plus bas : c'est désormais la priorité devant tout le reste de ce document.

Le reste tient en trois familles : la **supervision** (un agent à l'arrêt ou un export refusé restent invisibles), la **lisibilité au doigt et en thème clair**, et la **transformation en outil de gestion** (coût carburant, alertes, taux d'utilisation — que l'API calcule déjà sans que la page les demande).

> **Livré et déployé en production le 3 septembre 2026 à 07:15** (`2f42801b`, `d00cd9ea`, `b36e8102`) — migrations `trk057` et `trk058` appliquées, 7 614 récits datés rétroactivement, routes de réglage du rapport hebdomadaire en ligne. Le lot 0 est donc clos, et une partie des lots 1 à 3, 4, 5 et 7 est partie avec : borne haute de période exclusive, en-têtes des CSV positions et commandes, périodes de la fiche véhicule alignées sur celles de la page Rapports, exports en échec tracés, analyses vides exclues du classement, datation du récit, compteur de reste à faire unifié, agents du poste qui journalisent leur passage. Les lots ci-dessous ont été relus en conséquence : ce qui reste marqué « à faire » l'est vraiment.
>
> ⚠️ **Conséquence à connaître** : le premier envoi automatique partira **lundi 8 septembre à 08:00, heure de Paris**, vers les administrateurs actifs de chaque société ayant roulé sur la semaine — y compris les sociétés d'essai (`Client test`, `cdef31`). Aucune n'a d'adresse dédiée renseignée. Pour en couper une, il suffit de basculer l'interrupteur de sa carte « Rapport hebdomadaire par e-mail » sur sa page Rapports.

### Recette du 3 septembre, 08:06 — premier passage des agents avec le nouveau code

| Contrôle | Résultat |
|---|---|
| Récits écrits par l'agent du poste dans les 10 dernières minutes | 30, dont **30 datés** (`narratedAt`) — la datation fonctionne |
| Récits écrits 10 à 40 minutes plus tôt | 70, dont 0 datés — passage encore en cours avec l'ANCIEN code au moment du déploiement, cas unique |
| Reste à écrire, toutes sociétés | 3 947, contre 4 099 au déploiement |
| Ligne de passage du rattrapage en base | pas encore : elle s'écrit à la FIN du passage, et celui-ci dure 100 minutes (fin vers 09:40) |

⚠️ **Limite assumée, à connaître** : un agent qui tourne 100 minutes ne prouve son passage qu'à la fin. C'est
volontaire — un marqueur posé au démarrage mentirait sur un agent mort en route — mais la supervision reste donc
aveugle pendant la durée du passage. La tolérance de la sonde (deux fois la cadence) absorbe ce trou ; si un jour
la cadence se resserre, il faudra une trace de DÉBUT distincte de la trace de FIN.

---

## 1. Ce qui est réparé

Corrections vérifiées dans le code, groupées par famille. Colonne de droite : ce que le client constate, pas le nom du correctif.

### Le temps

| Ce qui se passe maintenant | Où |
|---|---|
| Un trajet parti à 00 h 30 heure de Paris est compté le jour où le conducteur l'a fait — dans le tableau, dans le graphique d'activité, dans la carte de chaleur et dans le résumé quotidien, qui disent enfin la même chose. | `apps/api/src/common/utils/datetime.ts:36,62` (`parisDayKey`, `parisDayStart`), appliqué dans `trips.service.ts:614-615,755-756,773` |
| La pastille « 7 jours » couvre bien 7 jours et non 8 ; « 30 jours » en couvre 30. | `apps/web/.../reports/reports.component.ts:2068-2069` |
| Le calendrier « Personnalisé » ne décale plus tout d'un jour : « Hier » montre hier, « Ce mois-ci » inclut aujourd'hui. | `reports.component.ts:1876-1883` |
| Les noms de fichiers portent la vraie date de fin, pas le lendemain. | `reports.controller.ts:103`, `report-csv.service.ts:204`, `report-excel.service.ts:467` |

### Les fichiers envoyés au client

| Ce qui se passe maintenant | Où |
|---|---|
| Le PDF ne finit plus par une page blanche, et chaque page porte « Généré … — Page i / n ». | `apps/api/src/reports/report-pdf.service.ts:92-96,460-466` |
| L'en-tête du PDF dit « du 04/08/2026 au 02/09/2026 inclus » — plus de flèche imprimée « !' », plus de date de fin au lendemain. | `report-pdf.service.ts:147-153` |
| Le curseur « Top N » de la modale est respecté : demander 30 véhicules en affiche 30, plus 10. | `reports-stats.service.ts:466` |
| Le PDF et l'Excel donnent la même vitesse moyenne, calculée en kilomètres parcourus divisés par heures de conduite. | `reports-stats.service.ts:346-353` |
| Un CSV exporté après avoir filtré sur un véhicule ne contient plus que ce véhicule ; un export sans donnée sort avec sa ligne d'en-tête au lieu d'un fichier vide de 3 octets. | web `reports.service.ts:126-133`, API `report-csv.service.ts:40,49-50,128,171` |
| L'Excel affiche les heures de Paris, comme le PDF et l'écran, et une ligne « Période (au, inclus) ». | `report-excel.service.ts:228-229,317-318,366` |
| Les types d'alertes s'impriment en français (« Excès de vitesse » au lieu de `OVERSPEED`). | `report-pdf.service.ts:54-77` |
| Le rapport de vitesse ne retient que les points GPS valides, affiche des heures de Paris, porte le nom du véhicule, et affiche une bannière explicite quand les positions ont été purgées. | `speed-report.service.ts:83,97-99,149,172` ; web `reports.service.ts:177` |

### La liste des trajets

| Ce qui se passe maintenant | Où |
|---|---|
| Le tri d'une colonne porte sur toute la période, pas sur la page affichée ; la suite se charge par curseur ; la charge réseau est allégée (`light=1`) quand le détail n'est pas nécessaire. | `apps/api/src/trips/dto/list-trips.dto.ts:26,36,48` ; `reports.component.ts:2528,2532-2536` |

### L'analyse d'un trajet

| Ce qui se passe maintenant | Où |
|---|---|
| Le bloc d'analyse a été redessiné : une note lettrée A–E cohérente avec le classement `/scores`, les faits d'un côté, les estimations marquées « ≈ » de l'autre, et **une** action claire (« Lire le récit », « Voir l'analyse » ou « Analyser maintenant »). | `apps/web/.../trip-analysis/trip-analysis-badges.component.ts:22,84-144,405,425-431` |
| Une analyse sans aucune position GPS n'est plus présentée comme une conduite parfaite : elle affiche « Aucune position exploitable pour ce trajet ». | `trip-analysis-badges.component.ts:71` |
| L'étincelle de recalcul, ambiguë, est devenue une action nommée « Recalculer les chiffres » dans la modale, réservée aux gestionnaires. | `trip-analysis-badges.component.ts:226` |
| Plus aucun bouton ne déclenche une génération de récit facturée depuis l'application. | vérifié : aucun appel `narrate` dans le composant |
| Quand une société n'a pas l'option IA, ses récits ne lui sont plus montrés — alors que l'agent local continue de les écrire pour toutes les sociétés. | API `trip-analysis.service.ts:65,87,105,141,155` ; agent `outils/agent-recit-trajet.cjs:34-37` |

### Le rapport hebdomadaire

| Ce qui se passe maintenant | Où |
|---|---|
| Chaque société règle son jour, son heure (Paris), ses destinataires, ses sections et son périmètre de véhicules depuis sa page Rapports. | `apps/web/.../reports/report-schedule-card.component.ts`, API `reports.controller.ts:288-347` |
| Le PDF annoncé « en pièce jointe » est réellement joint. | `report-schedule.service.ts:290` |
| Un bouton envoie le rapport immédiatement, pour vérifier avant de s'engager. | `reports.controller.ts:318-334` |
| Chaque passage laisse une trace consultable, y compris quand il a été sauté et pourquoi (aucun destinataire, aucun trajet). | `report-schedule.service.ts:238-256,316-324` ; modèles `FleetReportSchedule` / `FleetReportDispatch`, `schema.prisma:4266,4294` |
| Le déclencheur passe toutes les heures et n'envoie que ce qui est dû, au lieu d'un tir unique le lundi à 08:00 UTC (soit 10:00 à Paris l'été). | `reports-cron.service.ts:25-31` |
| La carte suit le sélecteur de société du haut : un super-admin règle chaque société en la choisissant, et « toutes les sociétés » invite à en choisir une au lieu d'afficher un refus. | `reports.component.ts` (`scheduleNeedsFleetChoice`), `report-schedule-card.component.ts` (`needsFleetChoice`) |
| Les **gestionnaires de flotte** règlent le rapport de leur société, comme les administrateurs — le droit d'export reste exigé, et le périmètre société est verrouillé côté serveur. | API `reports.controller.ts` (`@Roles` du `PUT /schedule`), `report-schedule.service.ts` (`resolveFleetId`) |
| Sans le droit d'export, la carte reste LISIBLE (prochaine échéance, contenu, destinataires) mais sans aucune commande : plus de bouton qui répondrait 403. | `report-schedule-card.component.ts` (`editable`, `verrouille`) |
| Toute modification du réglage, et tout envoi immédiat, apparaissent dans **l'activité utilisateur** avec la société et le détail de ce qui a changé — pas seulement un clic sur « Enregistrer ». | `report-schedule-card.component.ts` (`resumeReglage`), en plus du Journal Système côté API |
| Un tout premier passage enregistré sans envoi ne s'affiche plus comme un échec sans raison. | `report-schedule-card.component.ts` (branche `lastStatus` nulle) |
| L'entrée « rapport hebdomadaire » du catalogue des traitements de fond et de la sonde des tâches planifiées a été corrigée. | `background-tasks.service.ts:184`, `scheduled-task-heartbeat.service.ts:144` |

---

## ⚠️ Chantier prioritaire — les excès de vitesse et leurs alertes

*Ouvert le 3 septembre 2026, sur signalement du propriétaire, avec l'accord de MH Cars pour travailler
sur leurs données réelles. C'est le cœur du produit : une flotte achète Tracky pour savoir qui roule
trop vite et être prévenue. Aujourd'hui, aucun des trois maillons — mesurer, juger, prévenir — ne tient.*

### A. Ce qui est PROUVÉ sur les données de production

Tout ce qui suit est mesuré, pas supposé. Trajet de référence : `75e8d5bf-4177-4ff5-9d44-ba493923b929`,
EY-613-MF, MH Cars, 29 août 14:20, 22,5 km, affiché « V. MAX 180 km/h · 8 excès ».

**1. Le pic à 180 km/h n'a jamais eu lieu.** Les positions se contredisent d'elles-mêmes :

| Heure | Vitesse annoncée par le boîtier | Distance réellement parcourue | Vitesse déduite |
|---|---|---|---|
| 14:22:18 | 126 km/h | 684 m en 20 s | 123 km/h |
| 14:22:38 | **180 km/h** | 727 m en 20 s | **131 km/h** |
| 14:22:58 | 122 km/h | 702 m en 20 s | 126 km/h |

Le véhicule a couvert 727 m en 20 secondes. Aucun contrôle ne confronte la vitesse annoncée à la
distance parcourue : `gps-sanity.ts:369-390` ne teste que la validité du point et la plausibilité du
saut, **jamais `speedKmh`**. Le seul garde-fou est un plafond absolu de 200 km/h à l'ingestion
(`gps-sanity.ts:104`). Le chiffre est ensuite affiché en rouge, sans réserve, et sert de « vitesse max »
partout.

**2. Pourquoi le 180 n'est pas dans la liste des excès — et c'est pire qu'un oubli.** La cellule OSM de
ce point (`43.5895,1.2728`) porte bien une limite de **110 km/h**… enregistrée le **30 août à 06:30**,
soit **le lendemain du trajet**. Au moment de l'analyse, la limite n'était pas connue, donc
`trip-analysis.preprocessor.ts:141` a fermé le segment sans rien émettre. L'analyse n'est jamais
rejouée : l'excès n'apparaîtra donc **jamais**, alors que la donnée qui permettrait de le voir existe
depuis le lendemain.

**3. Le faux excès en zone 30 est un rattachement raté, pas une faute du conducteur.** L'événement
« Limite 30 · dépassement +72 » porte les coordonnées `43.61009, 1.38539`. La cellule correspondante est
bien en cache à 30 km/h. Sur deux minutes de rocade, les limites retenues sautent de 90 à 30 puis 50
puis 90. `speed-limit.resolution.ts:143-158` choisit **la voie la plus proche en 2D, un point à la
fois** : ni `layer`, ni `bridge`, ni `tunnel`, ni classe de voie, ni cap du véhicule, ni altitude, ni
continuité du tracé. Un pont qui franchit la rocade est souvent plus proche du point GPS que l'axe de la
rocade. Autour de cette portion, la base contient **2 149 cellules à 30 km/h** contre 53 à 110 : le
terrain est un piège permanent.

Les tags qui trancheraient sont **déjà dans la réponse Overpass** (`out tags geom`,
`speed-limit.resolution.ts:193-196`) et ne sont jamais lus. Le cap du véhicule est **déjà lu en base**
(`trip-analysis.service.ts:177`) et **jeté** à la ligne 203.

**4. Un excès est bâti sur un seul point.** `trip-analysis.preprocessor.ts:121-126` n'impose ni durée
minimale, ni nombre de points minimal : les huit excès de ce trajet ont une durée de 0 ou 20 secondes.
Un point mal rattaché suffit à produire un « excès confirmé ».

**5. Le score de conduite ne regarde pas la vitesse.** Formule unique,
`trip-analysis.preprocessor.ts:183-190` :

```
ecoScore = 100 − min(30 ; à-coups × 100/km × 2)
               − min(35 ; NOMBRE d'excès × 100/km × 3)
               − min(20 ; minutes de ralenti × 1,5)
```

Ni `maxSpeedKmh`, ni `avgSpeedKmh`, ni `maxOverKmh`, ni `speedingSec` n'entrent dans le calcul. Les deux
trajets signalés se reproduisent au point près : celui à **131 km/h de moyenne et 168 de pointe** perd
4,3 points et obtient **96/100**, celui à 22,5 km avec 8 excès plafonne à 65 dès le troisième excès —
le dépassement de +72 km/h ne coûte rien. À conduite identique, 22 km donnent 69 et 164 km donnent 96 :
**27 points d'écart pour le seul effet de la distance**. Le classement moyenne ensuite ces notes sans
pondérer par les kilomètres (`driving-score.service.ts:298, 314`).

Et l'écran affirme au client que la note mesure « la souplesse des accélérations et freinages »
(`trip-analysis-badges.component.ts:197`) : c'est faux dans les deux sens.

**6. Aucune alerte d'excès n'est produite par Tracky.** Les 7 031 alertes `OVERSPEED` des 60 derniers
jours viennent **toutes du bit d'alarme du boîtier** (`tcp-server.service.ts:328`,
`coban.parser.ts:34`). Leur contenu porte la trame brute du traceur. L'analyse de trajet, elle, ne crée
aucune alerte : aucune référence à `AlertsService` dans tout `apps/api/src/trip-analysis/`. Les deux
mécanismes ne se parlent nulle part. **3 392 trajets contenant un excès n'ont aucune alerte** (cdef31
1 776, MH Cars 1 140, A2R 453, Ahmed 23).

**7. Il n'existe aucun réglage d'alerte de vitesse.** Ni sur la société, ni sur le véhicule : aucune
colonne de seuil dans `schema.prisma`. Le seuil vit dans le firmware du boîtier et ne se pose que par
SMS (`coban.catalog.ts:266-289`). La condition « si l'utilisateur a activé les alertes de vitesse »
demandée par le propriétaire **n'est pas exprimable en base aujourd'hui**.

**8. Pourquoi aucune notification n'arrive.** Sur 30 jours, pour les excès :

| Issue | Motif enregistré | Nombre |
|---|---|---|
| Étouffée | `no_device` — le destinataire n'a **aucun appareil abonné** | 4 866 |
| Regroupée | `cooldown` — 15 minutes par véhicule et par type | 3 186 |
| **Envoyée** | — | **78** |

Le rollout push est bien ouvert en production (`PUSH_ROLLOUT=ALL`, vérifié sur le VPS) et les clés VAPID
sont présentes. La cause majoritaire est donc ailleurs : **le destinataire n'a pas d'abonnement push
valide, et rien ne le lui dit**. Un compte sans appareil abonné ne reçoit rien, en silence, pour
toujours.

**9. Le clic sur une notification ne peut pas ouvrir le trajet.** L'URL est écrite en dur
(`notification-dispatch.service.ts:1178`, `url: '/alerts'`), et le rattachement est impossible : la table
`alerts` n'a **aucune colonne `tripId`** (`schema.prisma:1758-1793`). Le format de lien profond existe
pourtant déjà : `/vehicles/<id>?tab=reports&trip=<tripId>&tripDate=<date>`
(`driving-scores.component.ts:136`).

**10. L'acquittement existe mais n'a jamais servi.** Les colonnes, l'API et les boutons sont là
(`alerts.controller.ts:47-67`, `alerts.service.ts:788-817`). Sur **7 148 alertes de tous types en base,
zéro n'a jamais été acquittée**. Et le repli hors application est cassé : le service worker ouvre
`/alerts?ack=<id>` (`sw.js:180`), paramètre qu'aucun écran ne lit.

**11 bis. Des excès structurellement invisibles.** Seuls les points au-dessus de **33 km/h** sont soumis
à la résolution de limite (`SPEEDING_CANDIDATE_KMH`, `trip-analysis.service.ts:15`). Un excès en zone 20
(voie partagée) ou en zone piétonne ne peut donc **jamais** être détecté. Le seuil a été posé pour
« couvrir les zones 30 avec marge » et exclut tout ce qui est en dessous.

**11 ter. Les longs trajets ne sont analysés qu'en partie.** L'analyse lit au plus **5 000 positions**
(`trip-analysis.service.ts:17, 179`), triées du début à la fin, sans échantillonnage : au-delà, **la fin
du trajet est absente de l'analyse**, alors que la vitesse maximale du trajet, elle, est calculée sur la
totalité. Rien ne signale cette troncature à l'écran.

**11 quater. Le plafond de résolution OSM est atteint en silence.** Une analyse ne peut interroger que
**1 600 cellules** (`speed-limit.service.ts:63`, 8 lots de 200). Au-delà, les cellules restantes sont
traitées comme « sans limite » **et ne sont pas mémorisées** : elles ne seront ni réessayées, ni
signalées.

**11. Quatre définitions concurrentes d'un « excès » cohabitent** : le bit du boîtier ; l'analyse de
trajet (limite OSM + 5 km/h) ; le rapport de vitesse, qui utilise un seuil **fixe à 90 km/h** sans
aucune limite légale (`speed-report.service.ts:102`) alors qu'il sert de pièce disciplinaire ; et les
trois plafonds de vitesse maximale, à 200 (ingestion), 220 (analyse) et 250 (trajet).

### B. Les lots de correction

Ordre imposé par les dépendances : on ne peut pas alerter juste tant qu'on ne mesure pas juste.

#### Lot V1 — Ne plus affirmer une vitesse que le trajet contredit · **FAIT le 3 septembre** (`ef7518a5`)

| Item | Fichier et ligne |
|---|---|
| ~~FAIT~~ `vitesseEstCorroboree` compare la vitesse annoncée aux intervalles voisins ; le point non corroboré ne fait ni la vitesse maximale ni un excès | `packages/shared/src/utils/gps-sanity.ts:369-390`, `apps/api/src/trips/trips.service.ts:231, 941-947` |
| ~~FAIT en partie~~ L'analyse utilise désormais le plafond de l'ingestion (200). Reste le clamp à 250 du trajet | `gps-sanity.ts:104`, `trip-analysis.preprocessor.ts:77`, `trips.service.ts:45` |
| Aligner le filtre `valid` entre le recalcul de trajet et l'analyse | `trips.service.ts:941-947` vs `trip-analysis.preprocessor.ts:101` |
| ~~FAIT~~ La fenêtre d'analyse affiche « pointe écartée : N km/h annoncés, la distance parcourue ne les soutient pas » | `reports.component.ts:711`, `trip-replay.component.ts:734-756` |

**Recette** : sur le trajet de référence, la vitesse maximale affichée est cohérente avec la distance
parcourue, ou porte une réserve visible.

#### Lot V2 — Rattacher le bon morceau de route · **FAIT le 3 septembre** pour la part déterministe

| Item | Fichier et ligne |
|---|---|
| ~~FAIT~~ `malusVoie` pénalise le hors-sol, la desserte et le résidentiel, plafonné pour rester un départage. Même règle dans l'agent du poste | `speed-limit.resolution.ts:143-158, 193-196` ; même score dans `outils/osm-index.cjs:204-217` |
| Réinjecter le cap du véhicule, lu puis jeté, et écarter les voies dont l'azimut s'écarte de plus de 40° | `trip-analysis.service.ts:203` (le `heading` est perdu ici), `speed-limit.resolution.ts:143-158` |
| ~~FAIT~~ Compris dans `malusVoie` | `speed-limit.resolution.ts:129-158` |
| ~~FAIT~~ Au-delà de +40 km/h sur une voie à 50 ou moins, la pointe passe en « à vérifier » et s'affiche comme telle dans le replay | `trip-analysis.preprocessor.ts:136` |
| ~~FAIT~~ Un dépassement vu sur un seul point rejoint les pointes à vérifier | `trip-analysis.preprocessor.ts:121-126` |
| Abaisser le seuil de candidature à la résolution : à 33 km/h, un excès en zone 20 est indétectable | `trip-analysis.service.ts:15` |
| À terme : appariement de la trace entière plutôt que point par point — le service existe déjà et n'est pas utilisé pour cela | `apps/api/src/trips/map-matching.service.ts:50` |

> **Reste ouvert dans V2** : le cap du véhicule, qui trancherait le mieux, ne peut pas entrer dans la
> sélection tant que le cache des limites est indexé par cellule sans direction — une même cellule sert
> des véhicules qui la traversent dans tous les sens. Il faudra soit un cache par (cellule, cap), soit
> une résolution non cachée pour les points litigieux. L'appariement de la trace entière (map-matching)
> reste la vraie réponse.

**Recette** : sur la portion de rocade du trajet de référence, plus aucune limite à 30 km/h ; le nombre
d'excès de MH Cars sur 30 jours est comparé avant/après et l'écart est expliqué véhicule par véhicule.

#### Lot V3 — Rejouer l'analyse quand la limite arrive après coup · **FAIT le 3 septembre** pour l'essentiel

| Item | Fichier et ligne |
|---|---|
| ~~FAIT~~ `limitsCoverage` mesure la part des points RAPIDES ayant obtenu une limite, persistée et indexée. `null` quand aucune résolution n'a été tentée — on ne confond pas « rien trouvé » et « pas cherché » | `trip-analysis.preprocessor.ts:118, 134-135` |
| ~~FAIT~~ L'automatisation reprend, après les trajets neufs, les analyses les moins couvertes de plus de 12 h, 25 par passage au maximum | `trip-automation.service.ts`, `outils/agent-limites-vitesse.cjs` |
| Signaler la troncature à 5 000 positions et le plafond de 1 600 cellules au lieu de rendre une analyse partielle muette | `trip-analysis.service.ts:17, 179` ; `speed-limit.service.ts:63, 135-141` |
| Rendre réversibles les cellules gravées « sans limite » : une fois écrites à NULL elles ne sont plus jamais réinterrogées | `speed-limit.service.ts:126, 130`, `outils/agent-limites-vitesse.cjs:242-248` |

**Recette** : le trajet de référence, réanalysé, fait apparaître le passage à 110 km/h que la limite du
30 août rend désormais calculable.

#### Lot V4 — Un score qu'on peut défendre devant un client · **FAIT le 3 septembre**

| Item | Fichier et ligne |
|---|---|
| ~~FAIT~~ La note pénalise la part du temps de conduite passée en excès et la gravité du pire dépassement. Le nombre de segments, qui mesurait surtout la fragmentation d'OpenStreetMap, n'entre plus dans le calcul | `trip-analysis.preprocessor.ts:188` (utiliser `speedingSec` et `maxOverKmh`, calculés `:169-170`) |
| ~~FAIT~~ Une pointe au-dessus de 130 coûte jusqu'à 25 points, sans consulter la moindre carte | `trip-analysis.preprocessor.ts:185-190` |
| ~~FAIT~~ Sous 50 % de couverture, la note est plafonnée à 69 avec sa raison écrite ; un trajet lent n'est pas concerné | idem, avec le taux du lot V3 |
| ~~FAIT~~ Note de ligne, moyenne de flotte, score de classement et moyenne affichée : tous pondérés par les kilomètres | `driving-score.service.ts:298, 314, 367-369, 412-414` |
| ~~FAIT~~ La note vaut désormais `null` — non calculable. La reprise a effacé les 100 inventés de l'existant | `trip-analysis.preprocessor.ts:223` |
| ~~FAIT~~ Le libellé mensonger est remplacé par le détail réel : « −25 · pointe à 168 km/h, aucune route française n'autorise plus de 130 » | `trip-analysis-badges.component.ts:197` |

> **Reste ouvert dans V4** : les paliers de couleur du replay (trois niveaux) ne suivent pas encore
> les cinq notes lettrées, contrairement à la fiche d'entité, désormais alignée.

**Recette** : le trajet à 131 km/h de moyenne ne peut plus obtenir A ; chaque point perdu s'énonce en une
phrase lisible par le conducteur.

#### Lot V5 — Alerter sur ce que Tracky mesure, et prévenir vraiment · **FAIT le 3 septembre**

| Item | Fichier et ligne |
|---|---|
| ~~FAIT~~ `SpeedAlertService` évalue chaque analyse écrite (première comme ré-analyse) et crée l'alerte `OVERSPEED` rattachée au trajet, dédupliquée par trajet ; un trajet de plus de 48 h n'est pas notifié | `trip-analysis/` (aucune référence à `AlertsService`), producteurs existants `alerts.service.ts:127, 417, 507, 581, 686` |
| ~~FAIT~~ Réglage par société (activation, dépassement minimal, plafond absolu 130) surchargeable par véhicule, depuis Alertes › Réglages en suivant le sélecteur de société ; auteur et date conservés, activité utilisateur tracée. **OPT-IN : à activer société par société** | `schema.prisma` (aucune colonne de seuil aujourd'hui) |
| ~~FAIT~~ Colonne `alerts.tripId` (TRK-061), lien « Voir le trajet » dans le centre d'alertes | `schema.prisma:1758-1793`, `notification-dispatch.service.ts:1178-1187` |
| ~~FAIT~~ `urlDuTrajet` partagé serveur/écran ; la notification ouvre le trajet et propose « Marquer comme vue » sur place. **Constat en passant** : sous ngsw (la prod), un clic sur une notification n'ouvrait RIEN — `onActionClick` manquait au payload ; corrigé pour toutes les notifications | `driving-scores.component.ts:136`, `vehicle-reports-tab.component.ts:994-996` |
| ~~FAIT~~ `/alerts?ack=<id>` est lu au chargement de la page des alertes | `sw.js:180` puis lecture du paramètre dans `alerts.component.ts` |
| ~~FAIT~~ Réglages › Notifications affiche « N notifications n'ont pas pu vous être remises ces 7 derniers jours » quand aucun appareil n'est abonné | motif `no_device`, `notification-dispatch.service.ts` |
| ~~FAIT~~ pour la partie déterministe : les alertes de trajet se dédupliquent par trajet, et la fenêtre de 6 h du boîtier ne les voit plus (`tripId: null`) — deux chaînes indépendantes. Le regroupement push de 15 min par (utilisateur, type, véhicule) est conservé tel quel | `alerts.service.ts:44, 70, 326`, `notification-guardrails.ts:96, 106` |

> **Reste ouvert dans V5** : les alertes ne naissent que des trajets analysés APRÈS l'activation ;
> l'existant n'est pas rejoué. Et le bit d'alarme du boîtier continue de produire ses propres
> alertes `OVERSPEED`, sans limite légale — les retirer relève du lot V7.

**Recette** : un trajet avec un excès réel produit une alerte, une notification arrive sur un appareil
abonné, le clic ouvre le trajet, et l'acquittement fonctionne application fermée.

#### Lot V6 — Des sentinelles qui remontent les incohérences · **FAIT le 4 septembre**

Demandé explicitement : que le centre d'alerte signale les incohérences au lieu de les laisser dormir.
Le point d'entrée existe et est trivial à appeler — `ErrorLogger.record(message, source, { fleetId,
vehicleId, tripId }, 'ERROR')` (`error-logger.service.ts:95`), sur le modèle de
`backup-health.service.ts:66-76`, avec le refroidissement de `refroidissement-alerte.service.ts:104`
pour ne pas écrire une ligne par trajet.

| Sentinelle | Ce qu'elle signale |
|---|---|
| ~~FAIT~~ Excès sans alerte | Applique la MÊME fonction que le producteur (`decideAlerteExces`), et les mêmes bornes : réglage en vigueur au moment de l'analyse, trajet de moins de 48 h. Une ligne par société |
| ~~FAIT~~ Vitesse non corroborée | Déclenche sur la RÉCURRENCE (au moins 3 analyses touchées ET 10 % du jour), pas sur un point isolé. Niveau `DEGRADATION` : le garde-fou a fait son travail. Nomme les véhicules |
| ~~FAIT~~ Limite invraisemblable | Compte les pointes que le lot V2 a refusées pour rattachement douteux ; au-delà de 10 par jour, c'est une zone à corriger dans la carte. Ignore le motif « point unique », qui n'est pas un défaut de carte |
| ~~FAIT~~ Analyse à couverture faible | Au moins 30 % des analyses du jour sous 50 % de couverture, sur 5 analyses minimum. Même seuil que le plafonnement de la note (lot V4) |
| ~~FAIT~~ Destinataire sans appareil | Rappel HEBDOMADAIRE nommant les comptes actifs et le nombre de notifications perdues. Relevé du 3 septembre : deux comptes à 21 notifications étouffées chacun |
| ~~FAIT~~ Alerte jamais acquittée | Au-delà de 10 alertes de plus de 7 jours par société, rappel hebdomadaire. Calibré sur la production, qui en compte UNE |

> **Comment les éprouver sans attendre** : `POST /api/admin/logs/sentinelles/run` (super-admin)
> lance le passage tout de suite. La réponse rend les constats trouvés ET ceux que le
> refroidissement a retenus — « rien d'écrit » ne se confond jamais avec « rien à dire ».
>
> **Reste ouvert dans V6** : ~~les quatre sentinelles de l'analyse ne verront rien tant que V1 à V5
> ne sont pas déployés~~ — déployé le 4 septembre. Elles restent aveugles sur l'HISTORIQUE tant
> que la reprise (ci-dessous) ne l'a pas rattrapé.

#### Lot V8 — Les zones lentes, et la reprise de l'historique · **FAIT le 4 septembre**

| Item | Ce qui a changé |
|---|---|
| ~~FAIT~~ **Les zones 20 et les voies à 10 étaient hors du champ de vision.** Une limite n'était demandée qu'au-dessus de 33 km/h : un véhicule à 30 dans une rue à 20 dépassait de dix km/h sans qu'aucune limite ne soit seulement DEMANDÉE. Un second palier à 15 km/h les couvre — `EXCES_CANDIDAT_LENT_KMH` |
| ~~FAIT~~ **Sans une seule requête cartographique de plus.** Les points lents sont résolus DEPUIS LE CACHE SEUL : on gagne les excès des rues qu'une flotte emprunte régulièrement, et on n'ajoute rien au trafic d'un miroir public déjà signalé comme dégradé. Prix nommé : sur une rue jamais rencontrée, l'excès en zone 20 reste invisible |
| ~~FAIT~~ Le taux de couverture continue de porter sur la population RAPIDE seule : y verser les points lents ferait chuter la couverture de tout trajet urbain et déclencherait des rejeux sans objet |
| ~~FAIT~~ **Reprise de l'historique.** 8 442 analyses portent des segments d'excès, **4 036 n'en portent QUE des faux**. L'automatisation reprend 25 analyses par passage, les faux excès d'abord, bornée par le même budget de temps que les trajets neufs — l'historique mesuré se résorbe en une quinzaine de jours, et le compte figure dans le détail du passage |
| ~~FAIT~~ Une analyse d'avant le 4 septembre se reconnaît à l'absence de `detail.vitesse`, écrit à CHAQUE analyse depuis le lot V1 — et non au taux de couverture, qui reste nul pour un trajet entièrement lent et ferait boucler la reprise |

**Recette** : 30 km/h dans une rue à 20 produit un excès quand la cellule est connue ; le passage
de l'automatisation annonce ses reprises, et le nombre d'analyses sans réserve de vitesse baisse
d'un passage à l'autre.

**Recette** : chaque sentinelle sait produire une ligne de test à partir d'un cas réel de production, et
le centre d'alerte reste lisible — une ligne par incohérence et par jour, pas une par trajet.

#### Lot V9 — Ne pas faire couper un administrateur · **FAIT le 4 septembre**

Demandé après avoir dû couper les alertes de vitesse en urgence : « il ne faut pas spammer les
administrateurs, sinon ils désactivent les notifications, et là on est pour les faire réactiver ».
C'est le risque le plus cher du produit, et le plus discret : un client saturé ne se plaint pas, il
coupe — et le jour où un SOS part, il ne le reçoit pas non plus.

| Garde | Ce qu'elle surveille, et son étalon |
|---|---|
| ~~FAIT~~ **Destinataire saturé** | Plus de 15 notifications remises en 24 h à une même personne. Étalon mesuré sur 30 jours : le pire jour d'un administrateur client vaut **10**, sa moyenne **2**, et le défaut du produit est calibré sur ≈ 2,3. Le seuil de vitesse à +20, lui, en aurait produit **29 par jour**. La ligne nomme le type dominant et compte ce que le regroupement a déjà absorbé |
| ~~FAIT~~ **Le disjoncteur a sauté** | Le plafond horaire (12 par heure et par personne) n'est **jamais** intervenu en 30 jours. Un seul cas suffit donc à écrire la ligne : ce n'est pas un régulateur du quotidien, c'est un disjoncteur, et qu'il saute EST l'information |
| ~~FAIT~~ **Quelqu'un vient de couper** | Un réglage MODIFIÉ dans les 24 h qui coupe le push, un type ou une famille. Ne lit que les réglages récents : répéter chaque matin une coupure ancienne et assumée reproduirait, sur l'instrument de surveillance, le défaut qu'il surveille |
| ~~FAIT~~ **Essai à blanc** | `GET /api/alerts/speed-settings/simulation` : ce qu'un seuil produirait, sans rien créer ni envoyer. Né du même jour, où trois notifications sont parties chez des clients pendant un essai |

**Recette** : sur les volumes actuels, les trois gardes se taisent ; un seuil trop bas les fait parler
avant que le client ne coupe.

#### Lot V7 — Une seule définition de l'excès dans tout le produit · **FAIT le 4 septembre**

Quatre définitions cohabitent aujourd'hui (cf. constat 11). Tant qu'elles coexistent, deux écrans
donneront toujours deux réponses à la même question.

| Item | Fichier et ligne |
|---|---|
| ~~FAIT~~ Le seuil fixe a disparu du document, jusqu'à la ligne pointillée du graphique. Le rapport cite désormais la limite légale de CHAQUE excès, et une colonne « limite voie » accompagne chaque mesure |
| ~~FAIT~~ Le rapport dérive de `detail.speeding` et ajoute un chapitre « Excès établis, un par un ». Il porte les réserves : pointe non corroborée, pointes écartées du décompte, couverture des limites trop faible. **Sans analyse, il n'affirme RIEN** au lieu d'inventer un seuil |
| ~~FAIT~~ `packages/shared/src/utils/exces-vitesse.ts` : `estEnExces`, `ecartCredible`, `excesEtabli`, `resumeExces`, `excesDuTrajet`, `excesContenant`. Le préprocesseur, le rapport, les badges et le replay l'appellent — l'écran lisait `speedingCount`, qui diverge du détail sur les analyses antérieures au lot V2 |

| ~~FAIT~~ Le quatrième plafond de vitesse a été aligné : le trajet clampait à 250 là où l'ingestion et l'analyse clampent à 200. **81 trajets sur 14 364** (90 jours) portaient une vitesse maximale que l'analyse du même trajet refuse d'affirmer. Le seuil de téléportation de `isPlausibleJump` reste à 250, et c'est volontaire — il mesure une trajectoire, pas un champ de trame |
| ~~FAIT~~ Le recalcul de trajet et l'analyse travaillent sur la MÊME population de points : le fix invalide est écarté des deux côtés. Mesuré : zéro position invalide sur 716 240 en trente jours, la porte d'ingestion les refuse déjà — l'alignement ne change rien aujourd'hui, et c'est pourquoi il fallait le poser maintenant |

**Recette** : pour un même trajet, le nombre d'excès est identique dans le replay, dans le rapport de
vitesse et dans le PDF.

### C. Points annexes remontés le même jour

| Constat | État |
|---|---|
| La page « Couverture vie privée » affiche 44 véhicules et des plaques d'une autre société alors que le filtre est sur MH Cars, qui n'en a que 7 | à corriger — la page ignore le filtre société |
| La page Rapports n'affiche aucune liste d'excès ni d'alertes, alors que l'API les calcule | rejoint le manque F05 du lot 9 |
| La modale du récit passe sous l'en-tête | signalé sur la version d'avant le 3 septembre ; **non reproduit** sur la version actuelle en local, où la modale couvre bien l'en-tête. À revérifier sur la production d'aujourd'hui |

---

## 2. Ce qui reste

Lots ordonnés par valeur pour le client, puis par risque. Effort : **S** = moins d'une demi-journée, **M** = une à trois journées, **L** = au-delà.

---

### Lot 0 — Livrer ce qui est écrit · **FAIT le 3 septembre 2026**

**Objectif** : rien de ce qui précède n'existe pour un client tant que ce n'est pas compilé, testé et livré.

| Item | Issue |
|---|---|
| Compiler l'API, relancer, exécuter les jeux d'essai | 197 suites, 2 860 tests au vert ; `ng build` sans erreur ni avertissement |
| Adapter les jeux devenus faux (vitesse pondérée, pied de page numéroté, borne exclusive, sonde des tâches) | fait, plus un test instable réparé (`tracker-fix-mode`, course sur l'horloge à 2 ms) |
| Livrer par thème | `2f42801b` API et migrations · `d00cd9ea` web · `b36e8102` agents du poste et documentation |

**Vérifié après livraison** : un export CSV filtré sur un véhicule renvoie ce véhicule seul ; le PDF d'un véhicule s'appelle `tracky-rapport-EP-047-TY-2026-08-27_2026-09-02.pdf`, avec la vraie date de fin.

---

### Lot 1 — Finir la reprise des dates et des exports · **M**

**Objectif** : supprimer les six résidus qui font qu'un même trajet compte encore différemment selon l'endroit où on le regarde.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT~~ La borne haute de période est devenue exclusive (`lt`) partout — trajets, résumé, graphiques, CSV, Excel. Reste à extraire un `buildTripPeriodWhere` unique pour empêcher la divergence de revenir : un trajet de minuit pile est compté dans deux périodes voisines. Extraire un `buildTripPeriodWhere(from, to)` unique (`gte from`, `lt to`) et l'utiliser partout | `apps/api/src/trips/trips.service.ts:615,756` | S |
| ~~FAIT~~ Le PDF retient désormais les trajets qui DÉMARRENT dans la période, comme l'écran, l'écran ceux qui y démarrent : un trajet parti à 23 h 50 la veille apparaît dans l'un et pas dans l'autre | `apps/api/src/reports/reports-stats.service.ts:277-284` | S |
| ~~FAIT~~ La fiche véhicule utilise la même définition que la page Rapports (J−6 / J−29) : « 7 jours » y couvre 8 jours, « 30 jours » en couvre 31 | `apps/web/.../vehicles/vehicle-reports-tab.component.ts:1069-1070` | S |
| ~~FAIT~~ Les CSV positions et commandes sortent avec leur en-tête même sans une seule ligne sans en-tête quand la période ne contient rien | `apps/api/src/reports/report-csv.service.ts:87,199` | S |
| ~~FAIT le 4 septembre~~ Les périodes se calculent en JOURS CIVILS (`ajouterJours`, qui s'appuie sur `setDate`), sur les deux écrans. Une journée de 23 ou 25 heures ne décale plus la date : le décalage d'une heure traversait minuit, donc il changeait de jour. Le seul endroit où la division par 86 400 000 subsiste est le DÉCOMPTE de jours, où l'arrondi absorbe l'heure — et c'est écrit sur place | `reports.component.ts`, `vehicle-reports-tab.component.ts` | S |
| ~~FAIT~~ `refreshPeriodIfStalePreset` passe par `setPeriod`, qui RECHARGE : le fichier exporté couvre la période affichée | `reports.component.ts` | S |
| ~~FAIT~~ Les libellés de période ne sont plus lus en UTC, interprété en UTC : décalés d'un jour pour une flotte aux Antilles ou en Guyane | `reports.component.ts:1811` | S |

**Comment on saura que c'est bon** : sur une même journée, le nombre de trajets est identique dans le tableau, le CSV, l'Excel et le PDF ; l'onglet Rapports d'une fiche véhicule annonce « 7 jours » dans la modale comme sur `/reports` ; un jeu d'essai avec le fuseau forcé à Paris passe les 30 mars et 20 avril sans écart.

---

### Lot 2 — Rendre visible ce qui est en panne · **L** · contient le bloquant T01

**Objectif** : qu'un traitement à l'arrêt, un export refusé ou un recalcul destructeur laisse une trace lisible dans l'espace admin, au lieu de passer pour sain.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (T01)~~ `/admin/background-tasks` affiche le dernier passage, l'ancienneté et l'état de chaque agent du poste ; `/admin/background-tasks` promettait « si le poste est éteint, ça se voit ici », mais n'affiche ni le dernier passage ni l'arrêt d'un agent local : la condition d'arrêt est gardée par `configurable`, donc jamais vraie pour un agent de poste. Afficher `lastRunAt` sur chaque ligne, un badge « à l'arrêt » dès `enabled === false`, et « jamais vu » quand aucun passage n'est enregistré | `apps/web/.../observability/background-tasks/background-tasks.component.html:164,175` | S |
| ~~FAIT~~ L'agent de récits et celui des limites de vitesse écrivent leur passage à chaque exécution, issue comprise, y compris quand il sort sur session expirée — sans quoi l'écran n'a rien à lire | `outils/agent-recit-trajet.cjs` | M |
| ~~FAIT (T03)~~ Le compteur suit la requête exacte de l'agent, et sa définition est affichée sous le tableau : il ignore la segmentation et le fait que l'agent narre désormais toutes les sociétés. L'agent est déclaré en panne précisément quand il n'a plus rien à faire | `apps/api/src/background-tasks/background-tasks.service.ts:742` | S |
| ~~FAIT (T08)~~ Un export en échec inscrit une trace FAILURE avec sa raison : `recordExport` inscrit toujours `SUCCESS`. Entourer les trois routes d'export d'un `try/catch` et enregistrer `FAILURE` avec le code HTTP | `apps/api/src/reports/reports.controller.ts:79,138,204,239` | S |
| ~~FAIT (T10)~~ L'Excel et le rapport de vitesse portent la société du véhicule ou du trajet : le filtre par flotte du Journal Système ne les retrouve pas | `reports.controller.ts:273,366` | S |
| ~~FAIT le 4 septembre (T04)~~ Le catalogue annonce la vraie fenêtre (9 000 h, ~375 j) et la vraie durée (100 min). Avant : il promettait 1 500 h, soit 62 jours — au 2026-09-02, 552 analyses de MH Cars et 205 d'A2R restaient sans récit pour cette seule raison, sur une rétention de douze mois. `outils/rattrapage-recits.cmd` reste la source (`--heures=9000 --minutes=100`) | `background-tasks.service.ts:546,935` | S |
| ~~FAIT le 4 septembre~~ Le recalcul inscrit au **Journal Système** (catégorie `MUTATION`, action `trips_recompute`) qui l'a demandé, sur quel véhicule et quelle période, combien de trajets supprimés et recréés, et combien de notes reprises ou perdues. Avant : une seule ligne dans les journaux du conteneur — c'est-à-dire nulle part, pour qui enquête depuis l'espace admin ; « mes trajets d'août ont changé » ne pouvait être ni confirmé ni démenti. ⚠️ `notesPerdues` est écrit **même à zéro** : une absence s'interprète toujours dans le sens qui arrange | `trips.service.ts` (fin de `recompute`), `recalcul-travail-manuel.spec.ts` | S |

| ~~FAIT le 4 septembre~~ `GET /reports/schedule/overview` (super-administrateur) rend le réglage de TOUTES les sociétés, et le tableau s'affiche exactement là où l'information manquait : sur la carte « Rapport hebdomadaire », quand aucune société n'est choisie — c'est-à-dire au moment où elle n'avait rien à montrer. Société · actif (et « par défaut ») · jour et heure · destinataires · dernier envoi ou échec. ⚠️ DEUX requêtes, pas deux par société : les destinataires par défaut sont chargés d'un coup. ⚠️ Une société **active dont personne ne reçoit le rapport** s'affiche « personne » en rouge — le cas se produit dès qu'aucun administrateur actif n'existe et qu'aucun destinataire n'est choisi ; vérifié en production : les cinq sociétés ont bien au moins un destinataire | `report-schedule.service.ts`, `reports.controller.ts`, `report-schedule-card.component.ts` (+ 4 jeux d'essai) | M |

**Comment on saura que c'est bon** : poste éteint 25 heures → `/admin/background-tasks` affiche « à l'arrêt — dernier passage il y a 25 h » et le centre d'alerte remonte un incident ; un export refusé pour cause de droits apparaît en échec dans le Journal Système, avec le nom de la société.

---

### Lot 3 — Une analyse de trajet qui ne ment pas · **M** · contient le reste du bloquant A01

**Objectif** : que les chiffres d'un trajet soient les mêmes partout et qu'aucune analyse vide n'entre dans une moyenne.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT côté classement (A01)~~ Les analyses sans position sont exclues de la moyenne ; reste à refuser de PRODUIRE l'analyse. L'écran refuse déjà d'afficher une analyse sans position, mais l'API la produit toujours et le score de conduite l'intègre à 100/100 : un trajet dont on ne sait rien peut hisser un véhicule au podium. Refuser l'analyse sur un trajet de plus de 500 m sans position, et exclure `gpsPoints = 0` de la moyenne | `apps/api/src/trip-analysis/trip-analysis.service.ts:171` ; `driving-score.service.ts` (le champ n'y est même pas sélectionné) | S |
| ~~FAIT en partie (A11)~~ Le récit porte sa date (`narratedAt`) et l'écran signale un texte antérieur au recalcul ; reste à faire reprendre ces récits périmés par l'agent. Avant : : les badges disent « 0 excès » pendant que le texte parle de deux excès. Dater le récit (`narratedAt`, migration Prisma) et l'effacer quand un chiffre cité change, pour que l'agent local le réécrive | `trip-analysis.service.ts:229` | M |
| ~~FAIT le 4 septembre (A09)~~ Les trois volets. **Le même filtre de sauts** : l'analyse passe désormais par `sanitizePositions`, comme le segmenteur. Elle ne le faisait pas, donc elle comptait les téléportations dans sa distance — le tableau annonçait un chiffre, l'analyse un autre, et rien n'expliquait l'écart ; les points écartés sont COMPTÉS (`detail.vitesse.pointsInvraisemblables`) et affichés, pas effacés. **Une seule formule** : trois implémentations du haversine coexistaient (ici, le détecteur d'arrêts, le paquet partagé) — mathématiquement équivalentes, donc rien ne signalait la divergence, ce qui est exactement ce qui la rendait durable ; les deux copies deviennent des alias du partagé. **Analyse partielle** : au-delà du plafond de lecture, seules les premières positions sont analysées ; l'analyse porte maintenant `detail.partielle` et la modale ouvre sur un bandeau — une analyse partielle affichée comme complète est pire qu'une analyse absente, ses chiffres sont plausibles, cohérents entre eux, et faux | `trip-analysis.preprocessor.ts`, `trip-analysis.service.ts`, `common/utils/haversine.ts`, `trip-analysis-badges.component.ts` (+ 3 jeux d'essai) | M |
| ~~FAIT le 4 septembre (A05)~~ L'analyse porte désormais `detail.carburant` (`l100km`, `source`, `typeVehicule`) et l'écran dit LAQUELLE des deux valeurs a servi, avec un lien « La renseigner » vers la fiche quand c'est le défaut de type. Avant : la phrase affirmait « d'après la consommation du véhicule » **dans tous les cas** — y compris quand aucune consommation n'était renseignée : le client lisait une phrase qui désignait une donnée qu'il n'avait jamais fournie, et n'avait donc aucune raison d'aller la fournir | `trip-analysis.preprocessor.ts`, `trip-analysis.dto.ts`, `trip-analysis-badges.component.ts` | S |
| ~~FAIT le 4 septembre (A23)~~ La modale s'ouvre TOUJOURS et va chercher l'analyse elle-même (`GET`, pas un calcul) : « Chargement… », puis les chiffres, ou « Ce trajet n'a pas encore été analysé » avec le bouton d'analyse pour qui en a le droit. ⚠️ Le constat d'origine était en deçà de la réalité : le lien n'ouvrait pas une modale **vide**, il n'ouvrait **rien du tout** — la condition exigeait l'analyse. L'utilisateur recliquait, puis concluait que le lien était cassé | `trip-analysis-badges.component.ts` | S |
| ~~FAIT~~ Le recalcul est réservé aux rôles de gestion (super-admin, admin, gestionnaire de flotte) | `trip-analysis.controller.ts:145-167` | S |

**Comment on saura que c'est bon** : un recalcul demandé sur un trajet sans position renvoie un refus explicite ; la moyenne de `/scores` ne bouge plus quand on supprime les analyses vides ; recalculer un trajet narré dont les chiffres changent fait disparaître le récit, qui revient au passage nocturne de l'agent local — sans aucun appel de modèle facturé côté API.

---

### Lot 4 — Une seule modale « Exporter », compréhensible · **L** · *une grande partie livrée le 3 septembre*

**Objectif** : remplacer quatre boutons et des curseurs abstraits par un choix en trois blocs — Format, Périmètre, Contenu — dont le client comprend le résultat avant de cliquer.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (R09 / EXP-04)~~ La modale s'ouvre sur le périmètre de l'écran et ne propose que les véhicules de la société. Avant : elle repartait sur « Tous » et proposait au super-administrateur des véhicules d'autres sociétés (l'export échoue alors en erreur). Pré-cocher le périmètre de l'écran et n'offrir que les véhicules visibles | `reports.component.ts:879,895-897` ; `pdf-export-modal.component.ts:460-471` | S |
| ~~FAIT en partie~~ Les curseurs sont chiffrés et raccrochés aux données réelles (« 30 des 78 trajets »), avec un bouton « Prendre les 78 » ; il reste à remplacer les curseurs eux-mêmes par des choix nommés (« tous : 391 trajets, ≈ 13 pages », « 5 par véhicule ») | `pdf-export-modal.component.ts` | M |
| ~~FAIT le 4 septembre~~ `POST /reports/excel` accepte `fleetId` + `groupId` en plus de `vehicleId` : le classeur ouvre sur une feuille **« Synthèse par véhicule »** (une ligne par véhicule, plus gros rouleurs en tête, total en bas), puis liste tous les trajets avec une colonne « Véhicule ». Obtenir le mois d'un parc demandait jusqu'ici quarante exports recollés à la main. ⚠️ Pas de vitesse moyenne dans la ligne TOTAL — une moyenne de moyennes n'a pas de sens, et un chiffre plausible à cet endroit se lirait comme la vitesse du parc : la cellule porte un tiret. ⚠️ Les véhicules en **mode vie privée** sont retirés (un seul ne peut pas bloquer le rapport de toute la société) **et la feuille le dit, plaques comprises** : un total silencieusement amputé est un total faux. Vérifié en recette : `tracky-MH-Cars-recette-2026-08-01_2026-09-04.xlsx`, 30 909 octets | `report-excel.service.ts`, `generate-excel.dto.ts`, `reports.controller.ts` (+ 5 jeux d'essai) | M |
| ~~FAIT le 4 septembre~~ **Toutes** les dates des quatre CSV ont leur colonne en heure de Paris à côté de l'ISO : acquittement d'alerte, envoi et accusé de commande, date de note de trajet. Les dates principales l'avaient déjà ; les secondaires restaient en UTC technique, donc décalées de deux heures en été pour qui les lisait dans Excel | `report-csv.service.ts` | S |
| ~~FAIT le 4 septembre~~ La table vit dans `packages/shared/src/dto/libelles-alerte.ts` (`libelleTypeAlerte`, `libelleGraviteAlerte`) : le PDF n'en garde que deux alias, le CSV d'alertes gagne `type_label` et `severity_label` **à côté** des codes (qui restent triables), et la page Rapports s'en sert pour son bloc « Alertes de la période ». Avant : le PDF disait « Excès de vitesse » là où le CSV écrivait `OVERSPEED` — un client qui ouvrait les deux pouvait légitimement se demander s'il s'agissait de la même chose | `packages/shared`, `report-pdf.service.ts`, `report-csv.service.ts`, `reports.component.ts` | S |
| ~~FAIT le 4 septembre (F15)~~ `Ctrl+P` donne un document : fond blanc, menus / boutons / barre de tri retirés (un menu déroulant sur papier ne veut rien dire), en-tête de tableau RÉPÉTÉ à chaque page, lignes et cartes qui ne se coupent plus en deux, un graphique par bloc. ⚠️ Une ligne d'identité n'apparaît QU'À L'IMPRESSION — société, périmètre, période, **date d'édition** : l'écran porte ces informations sur les pastilles et les menus, que l'impression masque, et la feuille sortait donc sans société ni dates. Un rapport papier circule et ressort d'un classeur six mois plus tard ; sans la date d'édition, personne ne peut dire s'il décrit encore la réalité | `reports.component.ts` | S |

**Comment on saura que c'est bon** : après avoir filtré sur un véhicule, ouvrir « Exporter » montre ce véhicule déjà coché et la période « du … au … inclus (N jours) » ; choisir « tous les trajets » sur 391 trajets produit bien un PDF de treize pages.

---

### Lot 5 — Mobile 375 px, thème clair, clavier · **L** · *l'essentiel livré le 3 septembre (MOB-01 à MOB-15)*

**Objectif** : que la page reste utilisable au doigt, en thème clair et au lecteur d'écran — aujourd'hui elle échoue aux trois.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (MOB-01)~~ Les tableaux de secours des graphiques sont de nouveau lus par les lecteurs d'écran. Avant : les conteneurs portaient `role="img"`, ce qui rend invisibles aux lecteurs d'écran les tableaux de données construits pour eux, et rend présentationnels les boutons de la carte de chaleur | `charts/heatmap-chart.component.ts:61`, `line-bar-chart.component.ts:65`, `histogram-chart.component.ts:52` (et `error-timeline-chart.component.ts:40`, hors page Rapports) | S |
| ~~FAIT (MOB-02)~~ La carte de chaleur est un aplat continu au doigt, la rangée entière étant la cible. Avant : à 375 px, l'étiquette de jour étirait chaque rangée : les cellules restent à 11 px et le motif disparaît. Faire de la rangée entière la cible tactile | `heatmap-chart.component.ts:222` | M |
| ~~FAIT (MOB-04)~~ Les paliers de la carte de chaleur sont composés à partir des jetons, donc lisibles dans les deux thèmes. Avant : couleurs codées en dur pour le thème sombre : en thème clair, une cellule vide est blanche sur blanc et les deux premiers paliers passent sous le seuil de contraste. Les composer avec les jetons | `heatmap-chart.component.ts:307` | S |
| ~~FAIT (MOB-03)~~ L'infobulle n'est plus rognée et ne reste plus collée au doigt. Avant : elle était rognée sur la rangée du lundi et sur les colonnes 0 h et 23 h ; au doigt elle s'ouvre sur la mauvaise cellule et ne se referme pas | `heatmap-chart.component.ts:148` | S |
| ~~FAIT (MOB-09)~~ Le vert de marque ne sert plus de couleur de texte. Avant : il servait de couleur de **texte** sur le véhicule sélectionné et le raccourci de période actif : sous le seuil de lisibilité en thème clair, précisément là où l'utilisateur vérifie ce qu'il regarde. Passer à `--texte-succes`, lavis en `color-mix` | `reports.component.ts:1160,1372` | S |
| ~~FAIT (MOB-10)~~ L'ambre passe par son jeton de texte, lisible en thème clair. Avant : l'ambre du bouton « Recalculer » et de l'alerte « vitesse moyenne ≥ 50 km/h » est illisible en thème clair. Passer à `--texte-attente` et ajouter un glyphe pour ne pas dépendre de la couleur seule | `reports.component.ts:313,508` | S |
| ~~FAIT (MOB-06)~~ Les menus se ferment avec Échap, annoncent leur état et rendent le focus. Avant : Échap ne fermait pas les menus Groupe et Véhicule, les déclencheurs n'annoncent pas leur état, et le focus retombe sur le corps de page à la fermeture | `reports.component.ts:2532` | S |
| ~~FAIT (MOB-13 / MOB-15)~~ La légende décrit le vrai geste et la plaque atteint la taille tactile. Avant : le texte disait « cliquez "Voir" » alors qu'aucun contrôle nommé « Voir » n'existe ; la plaque, seul accès à la fiche véhicule depuis une carte, fait 24 px de haut | `reports.component.ts:473,732` | S |
| ~~FAIT en partie (MOB-16)~~ La note se déplie au doigt ; une lecture en plein écran reste à faire. Avant : la note était tronquée à 180 px et son texte complet n'est accessible qu'au survol : un conducteur ou un lecteur ne peut pas la lire sur son téléphone | `reports.component.ts:787` | S |
| ~~FAIT le 4 septembre (2 sur 3)~~ **Boutons coupés** : sous 430 px, les exports et les pastilles de période reviennent au retour à la ligne (deux rangées de deux) au lieu d'une rangée défilante — le quatrième bouton et « Personnalisé » étaient coupés en plein mot au bord de l'écran, sans ombre ni flèche : rien ne disait qu'il restait quelque chose à droite, et l'utilisateur concluait que la fonction n'existait pas sur téléphone. ⚠️ Seuil à 430 px et non 375 : entre les deux (iPhone Pro Max, Pixel) la même coupure se produit, un cran plus loin. **Annonce vocale** : une zone `aria-live` polie dit le tri et le nombre de trajets chargés sur le total — trier ou charger une page ne produisait aucune annonce, le tableau changeait en silence. **Reste** : le menu véhicule en feuille basse avec recherche au-delà de 8 véhicules | `reports.component.ts` | S |

**Comment on saura que c'est bon** : `pnpm verif:contraste` au vert sur les quatre couples signalés ; à 375 px la carte de chaleur fait environ 220 px de haut avec des cellules pleines et une légende ; au lecteur d'écran, les menus s'annoncent ouverts/fermés/sélectionnés et le tableau de données de chaque graphique est lu.

---

### Lot 6 — Robustesse : ne plus tromper quand ça casse · **M**

**Objectif** : qu'une panne partielle se voie, au lieu d'être effacée par le geste suivant.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (R10)~~ Les deux pannes sont distinctes : un tri n'efface plus l'avertissement de l'autre requête. Avant : le bandeau « données incomplètes » disparaissait dès qu'on trie une colonne, alors que les indicateurs restent à zéro : plus rien ne dit que la vue est fausse. Séparer l'erreur de liste de l'erreur de résumé | `reports.component.ts:2832,2842,2936` | S |
| ~~FAIT (R24)~~ Un échec de chargement des véhicules affiche un bandeau et un « Réessayer ». Avant : il était avalé : plaques vides et filtres absents, la flotte semble vide. Afficher un bandeau et un bouton « Réessayer » | `reports.component.ts:3142-3148` | S |
| ~~FAIT (R22)~~ Toutes les minuteries du replay sont suivies et annulées. Avant : la garde de 3 s n'était pas annulée : fermer puis rouvrir en moins de 3 s affiche « la carte n'a pas pu se charger » sur une carte qui vient d'arriver | `period-replay.component.ts:905,938` | S |
| ~~FAIT le 4 septembre~~ Les quatre, un par un. **Réinitialiser** : le TRI fait désormais partie de l'état qu'il rend, et de la définition de « les filtres ont bougé » — cliquer un indicateur trie le tableau, et le seul bouton capable de revenir en arrière était refusé, précisément après le geste qui en avait fait sortir. **Graphique d'activité** : le plafond de 90 jours reste (au-delà, les barres sont des traits d'un pixel) mais il s'ANNONCE — « les 90 derniers jours seulement, 156 jours plus anciens non affichés » ; les mois manquants passaient pour vides. **Analyses en double** : les identifiants EN VOL sont exclus du prochain lot, la table n'étant écrite qu'à la fin — deux chargements qui se chevauchaient redemandaient les mêmes analyses. **Mémoire du replay** : la timeline est relâchée même quand l'écran ferme la modale sans passer par son bouton — pour un mois de trajets, plusieurs mégaoctets de points GPS restaient retenus par une modale que personne ne regardait | `reports.component.ts`, `period-replay.component.ts` | M |
| ~~FAIT le 4 septembre~~ Le recalcul reprend désormais **notes, auteur de la note, conducteur affecté, origine de l'affectation et mission**, rattachés au nouveau trajet dont la période recouvre le mieux l'ancienne. Un ancien trajet ne sert qu'une fois : une note ne peut pas apparaître sur deux trajets. Ce qu'aucun trajet ne peut porter — deux anciens fondus en un seul — est COMPTÉ et rendu à l'appelant (`notesPerdues`) au lieu d'être effacé en silence. Le dialogue de confirmation dit ce qui est conservé et ce qui peut se perdre | `trips.service.ts` (relevé avant suppression, `ancienLeMieuxRecouvert`) ; `reports.component.ts` (texte du dialogue) | M |

**Comment on saura que c'est bon** : couper le résumé journalier puis trier une colonne laisse le bandeau ambre en place ; couper la liste des véhicules affiche un bandeau avec « Réessayer » ; fermer et rouvrir le replay en moins de trois secondes n'affiche plus d'erreur.

---

### Lot 7 — Replays cohérents avec l'analyse · **M** · *livré le 3 septembre pour le replay d'un trajet ; le replay de période attend encore ses analyses*

**Objectif** : que l'écran où l'on regarde le trajet montre ce que l'on sait de ce trajet.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (A06 / A21)~~ Le replay d'un trajet affiche récit, conseils et fiabilité, et reprend les fonctions du tableau. Avant : le replay recevait l'analyse mais n'affichait ni récit, ni conseils, ni fiabilité, et résume le trajet autrement que le tableau. Réutiliser le composant de badges en lecture seule et ajouter une section « Récit » | `trip-replay.component.ts:73-83,239-269` | M |
| ~~FAIT pour le replay d'un trajet (A07)~~ La vitesse vient des relevés horodatés ; à défaut, l'écran affiche la moyenne EN LE DISANT. Le replay de PÉRIODE, lui, ne reçoit pas les analyses : il annonce « V. moyenne » sans mentir, mais reste à brancher. Avant : la « Vitesse » était la moyenne du trajet, constante du début à la fin : pendant un excès à 124 km/h, le bandeau affiche 62 km/h. Interpoler depuis la trace horodatée de l'analyse, ou renommer « V. moyenne » et griser | `period-replay.component.ts:794` | M |
| ~~FAIT (A08)~~ La lecture est pilotée par le temps ; cliquer un événement place curseur, marqueur et caméra au même point | `trip-replay.component.ts:493` | M |
| ~~FAIT le 4 septembre~~ Le bandeau du replay affiche la somme des distances **enregistrées**, celle qu'additionne l'indicateur « Distance ». Il re-mesurait la trace SIMPLIFIÉE : quelques points suffisent à dessiner un trajet, pas à en compter les kilomètres. Le compteur qui défile pendant la lecture est mis à l'ÉCHELLE de la distance enregistrée — la forme vient de la trace, la grandeur vient du trajet — pour qu'il atterrisse exactement sur le total. ⚠️ Les trajets sans trace exploitable ne sont plus escamotés : ils sont comptés et annoncés (« 2 trajets, 14,3 km sans trace GPS, non rejoués »), sans quoi l'écart avec l'indicateur redeviendrait inexplicable | `period-replay.component.ts` | S |

**Comment on saura que c'est bon** : ouvrir le replay d'un trajet avec récit affiche récit et conseils dans le panneau latéral, les mêmes badges qu'au tableau, une vitesse supérieure à 90 km/h pendant l'excès, et un marqueur posé sous la pastille rouge quand on clique dessus.

---

### Lot 8 — État dans l'URL et liens partageables · **M**

**Objectif** : pouvoir envoyer « regarde ce véhicule sur août » à un collègue — impossible aujourd'hui, la page n'a aucun état d'URL.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT le 4 septembre (F08)~~ Véhicule, groupe, période, tri et sens vivent dans l'URL : un rafraîchissement les conserve, un favori les retrouve, un lien les transporte. Les paramètres lus sont VALIDÉS (`estJourIso`, colonnes de tri connues) — « 2026-02-31 » passe une expression régulière et donne un 3 mars, et un rapport affiché sur des dates que personne n'a demandées ne se voit pas. ⚠️ L'écriture passe par `history.replaceState`, PAS par le routeur : un clic de filtre n'est pas un changement de page, et le faire naviguer relançait la résolution de route en fondant la page entière (`withViewTransitions`), avec un « Transition was aborted » dès que deux clics se suivaient. Les valeurs par défaut ne sont pas écrites — une URL qui porte tout est illisible et se périme | `reports.component.ts`, `reports.utils.ts` (+ 3 jeux d'essai sur `estJourIso`) | M |
| ~~FAIT le 4 septembre (F10)~~ `/reports?trip=<id>` ouvre le replay de ce trajet, et l'en-tête du replay porte « Copier le lien ». ⚠️ Le trajet est demandé au SERVEUR, jamais cherché dans la liste affichée : celle-ci est plafonnée à cent lignes, et un lien pointe le plus souvent sur un trajet qu'on a justement dû aller chercher — le chercher dans la page en aurait fait un lien qui marche une fois sur quatre. Le paramètre est posé à l'ouverture et RETIRÉ à la fermeture, sinon un lien copié plus tard rouvrirait un replay que l'expéditeur avait quitté depuis longtemps | `reports.component.ts`, `trip-replay.component.ts` | S |
| ~~FAIT le 4 septembre (F18)~~ Les quatre cartes mènent à leurs lignes (`kpiToSortColumn('tripCount')` rend désormais la date au lieu de `null` : un compte n'a pas de colonne à trier, mais il a une destination), et chaque ligne du récapitulatif porte un bouton « Filtrer » qui ramène TOUT le rapport sur ce véhicule — jusqu'ici, regarder un véhicule de plus près obligeait à quitter le rapport. ⚠️ Le bouton arrête la propagation : la ligne entière reste un lien vers la fiche | `reports.component.ts`, `reports.utils.ts` | S |
| ~~FAIT le 4 septembre (F09)~~ La dernière vue consultée est retenue (`reportsLastView`, les paramètres d'URL seuls — jamais l'URL absolue, qui survivrait à un changement de domaine et proposerait un lien mort) et l'écran PROPOSE de la reprendre, en une ligne qu'on peut ignorer. ⚠️ Jamais appliquée d'office : ouvrir un rapport sur une période d'il y a trois semaines parce que c'est la dernière regardée serait une surprise, et le lecteur ne verrait pas forcément que les dates ne sont pas celles du jour. ⚠️ Une vue VIDE n'écrase pas la mémoire — sinon la première visite ordinaire l'effacerait et la proposition ne serait jamais offerte | `preferences.service.ts`, `reports.component.ts` | S |

**Comment on saura que c'est bon** : copier l'URL après avoir filtré un véhicule sur août et l'ouvrir dans un autre navigateur restitue les mêmes filtres et le même tri ; le lien du courriel hebdomadaire ouvre la page sur la semaine du rapport.

---

### ⚠️ Constat du 4 septembre — « +11 925 % » n'est pas une mesure

Vu en recette juste après la mise en place de F03 : sous le nombre de trajets, la tendance
affichait **« +11 925 % vs période précédente »**. Arithmétiquement exact (481 contre 4) et
parfaitement illisible — personne ne se représente onze mille pour cent, et le chiffre occupe
la place d'une information.

**Corrigé le jour même** : à partir du triplement, la tendance passe au MULTIPLE (« ×120 »),
qui se lit d'un coup d'œil et dit la même chose. En dessous, le pourcentage reste la forme la
plus parlante. Le refus de calculer un taux **depuis zéro** était déjà en place ; ce cas-ci
est son voisin, et il ne se voyait qu'à l'écran.

---

### ⚠️ Constat du 4 septembre — `GET /reports/stats` est MONO-SOCIÉTÉ, et ne le dit pas

Découvert en recette en branchant F02/F05/F11 : la route retient **une** flotte — celle passée
en paramètre, à défaut celle de l'appelant, à défaut **la plus ancienne de la base**
(`reports.controller.ts`, `parseRange`). Un super-administrateur qui regarde « toutes les
sociétés » recevait donc la synthèse d'une société tirée au sort, sans un mot : **62 trajets là
où le reste de l'écran en comptait 481**, et « 0 véhicule actif sur 7 » sous un indicateur
annonçant 65 trajets.

Ce n'est pas neuf — le récapitulatif par véhicule (F04, livré la veille) en héritait déjà.
Ce qui est neuf, c'est qu'on le voit.

**Parade posée le jour même** : l'écran ne demande la synthèse que lorsqu'une société est
réellement désignée, et l'écrit (« Coût carburant, parc actif et alertes se calculent société
par société. Choisissez une société… ») ; le récapitulatif retombe sur les trajets chargés en
le disant. Mieux vaut ne rien afficher que la mauvaise société.

**Reste à faire** : rendre `compute()` multi-sociétés pour un super-administrateur, ou dire
côté serveur quelle flotte a été retenue plutôt que de la choisir en silence. Le PDF, l'Excel
et le rapport hebdomadaire passent par la même route et ont le même angle mort. **M**

---

### Lot 9 — De page de trajets à page de gestion · **L**

**Objectif** : brancher ce que l'API calcule déjà et que la page ne demande pas. Détail des gains en section 3.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT le 4 septembre~~ **F04** — le récapitulatif vient de l'agrégat SERVEUR, calculé sur toute la période. La route `/reports/stats` expose enfin `vehicleIds` et `topN`, que le service acceptait déjà : c'est parce qu'elle les taisait que l'écran additionnait lui-même sa page. `topVehicles` gagne `durationHours` et `avgSpeedKmh` — cette dernière en km ÷ heures, et non plus en moyenne des moyennes. Le repli client demeure et s'ANNONCE (`recapPartiel`) : un tableau vide ferait croire à une flotte à l'arrêt | `reports-stats.service.ts`, `reports.controller.ts`, `reports.component.ts` | M |
| ~~FAIT le 4 septembre (F02)~~ Bloc « Carburant estimé sur la période » : coût, litres, CO₂, **et le prix réellement constaté en station** quand des passages ont été captés — le serveur le calculait depuis toujours, l'écran ne le demandait pas, et le client comparait donc son coût à un prix qu'il avait lui-même paramétré. La table des facteurs CO₂ a rejoint le contrat partagé (`utils/co2`) : elle ne vivait que dans le préprocesseur, donc le CO₂ n'existait qu'au trajet. ⚠️ Le CO₂ est cumulé **par véhicule**, avec le facteur de son énergie — un total de litres multiplié par un facteur unique est faux dès qu'un parc mêle diesel et essence | `reports-stats.service.ts`, `packages/shared/src/utils/co2.ts`, `reports.component.ts` | S |
| ~~FAIT le 4 septembre (F05)~~ Bloc « Alertes de la période » : total, puis les cinq types les plus fréquents en clair (libellés du contrat partagé), le reste **compté** sous « et N d'autres types » plutôt que tu. ⚠️ Les deux blocs ne s'affichent que lorsque l'agrégat serveur est là : les déduire des trajets chargés donnerait un coût calculé sur cent trajets sur 391 — le défaut qu'on venait justement de retirer du récapitulatif | `reports.component.ts` | S |
| ~~FAIT le 4 septembre (F11)~~ Bloc « Parc actif sur la période » : N véhicules sur M, le taux, et surtout **les plaques de ceux qui n'ont fait aucun trajet** — l'information qui décide d'une mutualisation ou d'une restitution, et que le récapitulatif par véhicule ne pouvait structurellement pas montrer (un véhicule immobile n'y a aucune ligne). ⚠️ Servi par `/reports/stats`, PAS par `agenda/optimization/utilization` : cette route-là est gardée par la permission `reservations_view`, sans rapport avec les rapports, et le bloc aurait disparu pour la moitié des lecteurs. ⚠️ « Boîtier muet » est distingué de « n'a pas servi » : le premier se répare, le second se mutualise — les confondre ferait rendre un véhicule qui roule | `reports-stats.service.ts`, `reports.component.ts` | S |
| ~~FAIT le 4 septembre (F06)~~ Colonne « Excès » au récapitulatif par véhicule : nombre d'excès **établis** et pire dépassement. Le rapport de vitesse, lui, était déjà passé à la règle réelle au lot V7. ⚠️ Le compte relit le DÉTAIL des analyses (SQL brut sur le tableau JSON, seuil pris dans la constante partagée) et non `speedingCount` : au 2026-09-04, 4 036 analyses de production ne portent que des segments de durée nulle, et les compter accuserait des véhicules de ce que le rapport disciplinaire refuse d'affirmer. ⚠️ Quand l'agrégat n'est pas là, la cellule affiche « — », jamais « 0 » : un zéro inventé innocente un véhicule sans l'avoir regardé. Mesuré en production : 188 ms sur 30 jours de la plus grosse société ; un test de sécurité vérifie que cette requête écrite à la main porte bien le périmètre véhicule | `reports-stats.service.ts`, `reports.component.ts`, `reports-scope.security.spec.ts` | S |
| ~~FAIT le 4 septembre (F03)~~ « −13 % vs période précédente » sous Trajets, Distance et Durée. La période de référence est la fenêtre PRÉCÉDENTE de même durée, calculée en jours civils (`periodePrecedente`, jeux d'essai aux deux changements d'heure). ⚠️ Elle passe par le RÉSUMÉ JOURNALIER, pas par `/reports/stats` : le résumé couvre le périmètre réel de l'écran, y compris « toutes les sociétés », là où l'agrégat est mono-société — comparer un mois toutes sociétés à un mois d'UNE société donnerait une tendance parfaitement fausse et parfaitement crédible. ⚠️ **Aucun pourcentage n'est calculé depuis zéro** : passer de 0 à 65 trajets n'est pas « +6 500 % », l'écran écrit « aucun trajet sur la période précédente ». Un taux qui impressionne sans informer se lit pourtant comme une mesure | `reports.utils.ts` (+ 8 jeux d'essai), `reports.component.ts` | M |
| ~~FAIT le 4 septembre (F12)~~ **Ralenti moteur agrégé** : cumul de la période dans la carte Carburant (« dont 4h12 moteur tournant à l'arrêt, 9 % du temps de conduite »), et par véhicule dans l'agrégat. Il était calculé PAR TRAJET depuis toujours et agrégé nulle part — personne ne pouvait dire « ce parc a passé onze heures moteur tournant à l'arrêt ce mois-ci », alors que c'est le gaspillage qu'une simple consigne réduit. ⚠️ Rapporté à la DURÉE DE CONDUITE, pas à la durée de la période : un parc qui roule deux heures par jour aurait un « ralenti » de 2 % du mois, chiffre exact et sans usage. ⚠️ Requête SÉPARÉE de celle des excès — celle-ci fait un LATERAL sur les segments, donc y additionner le ralenti le compterait autant de fois qu'un trajet porte d'excès | `reports-stats.service.ts`, `reports.component.ts` | M |
| **F13** — dimension conducteur : filtre dans la liste et récapitulatif par conducteur. **RESTE À FAIRE** — `Trip.driverId` et son index existent, `ListTripsDto` ne l'expose pas | `list-trips.dto.ts`, `trips.service.ts`, `reports.component.ts` | M |

**Comment on saura que c'est bon** : les indicateurs « Carburant estimé » et « CO2 » de l'écran sont identiques à l'en-tête du PDF sur la même période ; le récapitulatif par véhicule est complet dès l'ouverture, sans mention « sur les N trajets chargés ».

---

## 3. Manques fonctionnels à forte valeur

Fonctions absentes repérées par l'audit. La plupart sont des raccords vers des calculs qui existent déjà côté serveur — la valeur est haute et le coût faible. Le dix-huitième constat de cette lecture, le rapport planifié réglable par le client (F14), a été livré : voir la section 1.

**Au 4 septembre 2026 au soir : treize des seize sont livrées.** Restent F07 (podium des
conducteurs), F13 (dimension conducteur) et F16 (trajets hors horaires) — les trois qui
demandent une agrégation nouvelle plutôt qu'un raccord vers un calcul existant.

| # | État | Ce qui manque | Ce que le client y gagne |
|---|---|---|---|
| F02 | **fait** | Coût carburant, litres et CO2 de la période | Répond à sa première question — « combien m'a coûté la flotte ce mois-ci ? » — sans générer un PDF pour y lire un chiffre déjà calculé. |
| F04 | **fait** | Récapitulatif par véhicule portant sur toute la période | Le tableau qu'il lit en premier pour comparer ses véhicules cesse d'être faux dès l'ouverture. |
| F05 | **fait** | Compteurs d'alertes de la période, par type et par sévérité | Il prépare son point mensuel depuis l'écran (« 14 excès, 3 sorties de zone ») au lieu d'ouvrir un fichier brut. |
| F11 | **fait** | Parc actif, kilométrage moyen et taux d'utilisation | Il voit quels véhicules ne roulent pas — l'information qui justifie une mutualisation ou une restitution. |
| F06 | **fait** | Excès de vitesse agrégés par véhicule | Il sait quel véhicule dépasse le plus, et le rapport de vitesse se déclenche sur un excès réel (85 km/h en zone 50) plutôt que sur un seuil fixe qui rate les uns et déclenche à tort sur les autres. |
| F07 | à faire | Podium des conducteurs et lien vers le classement | La fonction la plus « gestion de flotte » du produit devient accessible depuis le rapport, au lieu de n'exister que dans le menu latéral. |
| F03 | **fait** | Comparaison avec la période précédente | Il lit une tendance (« +12 % ce mois-ci ») au lieu de comparer de tête ou dans un tableur. |
| F08 | **fait** | Filtres portés par l'URL | Il peut envoyer un rapport pré-filtré à un collègue, le mettre en favori, et un rafraîchissement ne perd plus son travail. |
| F10 | **fait** | Lien profond vers un trajet et « copier le lien » | Il cite un trajet précis dans un courriel ou un ticket, au lieu de demander à son interlocuteur de le retrouver dans un tableau paginé. |
| F12 | **fait** | Ralenti moteur agrégé | Premier poste de gaspillage carburant maîtrisable par simple consigne ; aujourd'hui calculé par trajet et agrégé nulle part. |
| F13 | à faire | Dimension conducteur (filtre et récapitulatif) | « Combien de kilomètres a fait tel conducteur ce mois-ci, avec combien d'excès ? » trouve enfin une réponse sur un seul écran. |
| F16 | à faire | Trajets hors horaires signalés | L'usage privé ou nocturne d'un véhicule de société — motif classique d'installation d'un traceur — ressort du rapport au lieu de rester enfoui dans les alertes. |
| F17 | **fait** | Export Excel d'une flotte ou d'un groupe | Le mois complet du parc tient dans un classeur mis en forme, au lieu de quarante exports ou d'un fichier brut. |
| F09 | **fait** | Vues enregistrées | Un suivi récurrent (« groupe Livraisons / mois en cours ») se retrouve en un clic. |
| F15 | **fait** | Impression de la page | `Ctrl+P` donne un document présentable en réunion, pas une capture de menus déroulants. |
| F18 | **fait** | Ponts entre les chiffres et la liste | Chaque nombre affiché devient un point d'entrée vers son détail, au lieu d'une impasse. |

---

## 4. Bugs écartés

Constats du premier passage d'audit **réfutés** par la vérification contradictoire, avec la raison. À ne pas re-signaler.

| Réf. | Constat | Pourquoi il est écarté |
|---|---|---|
| R02 | Tableau estompé à vie si un tri est supplanté par un changement de filtre | Faux : le dernier chargement relâche les deux verrous, dans `loadTrips` comme dans `loadData`. |
| R03 | Rouet infini si on clique un indicateur pendant un chargement | Même mécanisme que R02 : le verrou `loading` est relâché symétriquement. |
| R04 | Boucle « Charger plus » → erreur → « Charger plus » | Faux : un drapeau de mise en pause coupe la sentinelle dès le premier échec. |
| R11 | Surlignage armé qui se pose sur un chargement suivant | Faux : le drapeau est désarmé dans le `catch`, avant même la vérification de séquence. |
| R13 | Échec du rapport de vitesse avalé en silence | L'intercepteur d'authentification affiche déjà un message pour les codes 0, 403 et ≥ 500. |
| R20 | Graphiques masqués dès que la liste est vide | Corrigé : la condition porte sur l'agrégat de la période, pas sur la page chargée. |
| EXP-10 | Rapport de vitesse sans aucune position sur un trajet à 180 km/h | Reproduit sur un trajet de jeu d'essai créé sans traceur ni positions ; en production, tout trajet porte un traceur. |
| EXP-25 | « 30 jours » couvre 31 jours | Déjà corrigé : les bornes sont J−29 → J. |
| A10 | Deux durées différentes entre la ligne et le récit | Le mécanisme existe, mais aucun récit examiné ne cite de durée ; le bug n'est pas démontré. |

---

## 5. Règles à ne pas casser

1. **Les récits sont écrits par l'agent local, jamais par l'API.** L'agent tourne sur un poste et narre pour toutes les sociétés ; la visibilité côté client est tranchée à la lecture par l'option IA de la société. Le réglage `narrateEnabled` reste à `false` : le rallumer coûterait environ 386 $ par an.
2. **Aucun appel de modèle facturé depuis l'API ni depuis l'interface.** Aucun bouton ne doit déclencher une génération de récit. Si une telle action devait revenir un jour, elle serait réservée aux administrateurs, derrière un droit dédié et une confirmation explicite.
3. **Le schéma de base ne se modifie que par migration Prisma.** Jamais de DDL manuel en production : l'entrée du conteneur exécute `migrate deploy`, et une divergence bloque l'API en boucle.
4. **Tout texte coloré passe par les jetons de texte** — `--texte-succes`, `--texte-attente`, `--texte-alerte`. Ni `--tracky-light` ni `--danger` bruts, illisibles en thème clair. Les fonds teintés se fabriquent en `color-mix(in srgb, var(--jeton) N%, transparent)`.
5. **Les journées se comptent en jours civils d'Europe/Paris**, via `parisDayKey` et `parisDayStart` — pour les listes, les agrégats, les bornes de rapport, les noms de fichiers, le CSV et l'Excel. Jamais `toISOString()` sur une date construite en heure locale.
6. **Cibles tactiles d'au moins 44 px, aucune information accessible par le seul survol, aucun débordement horizontal** — la page se conçoit d'abord à 375 × 812.
7. **Textes visibles et commentaires en français**, et un commentaire dit *pourquoi*, pas *quoi*.
