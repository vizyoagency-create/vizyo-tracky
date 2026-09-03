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

#### Lot V3 — Rejouer l'analyse quand la limite arrive après coup · **M**

| Item | Fichier et ligne |
|---|---|
| Marquer les analyses dont des points n'ont pas obtenu de limite, avec le taux de couverture réel (aujourd'hui `limitsKnown` est un booléen vrai dès **un seul** point résolu) | `trip-analysis.preprocessor.ts:118, 134-135` |
| Rejouer ces analyses une fois les cellules OSM renseignées par l'agent du poste | `trip-automation.service.ts`, `outils/agent-limites-vitesse.cjs` |
| Signaler la troncature à 5 000 positions et le plafond de 1 600 cellules au lieu de rendre une analyse partielle muette | `trip-analysis.service.ts:17, 179` ; `speed-limit.service.ts:63, 135-141` |
| Rendre réversibles les cellules gravées « sans limite » : une fois écrites à NULL elles ne sont plus jamais réinterrogées | `speed-limit.service.ts:126, 130`, `outils/agent-limites-vitesse.cjs:242-248` |

**Recette** : le trajet de référence, réanalysé, fait apparaître le passage à 110 km/h que la limite du
30 août rend désormais calculable.

#### Lot V4 — Un score qu'on peut défendre devant un client · **M**

| Item | Fichier et ligne |
|---|---|
| Pénaliser le **temps passé** en excès et sa **gravité**, pas le nombre de segments — deux valeurs déjà calculées et jamais lues | `trip-analysis.preprocessor.ts:188` (utiliser `speedingSec` et `maxOverKmh`, calculés `:169-170`) |
| Ajouter un garde-fou de vitesse absolue, indépendant d'OSM : aucune route française n'autorise plus de 130 | `trip-analysis.preprocessor.ts:185-190` |
| Plafonner la note quand la couverture des limites est faible, au lieu d'accorder un A par ignorance | idem, avec le taux du lot V3 |
| Pondérer le classement par les kilomètres, pas par le nombre de trajets | `driving-score.service.ts:298, 314, 367-369, 412-414` |
| Ne plus écrire 100/100 sur une analyse sans aucune position | `trip-analysis.preprocessor.ts:223` |
| Corriger le libellé : la note ne mesure pas « la souplesse des accélérations et freinages » | `trip-analysis-badges.component.ts:197` |

**Recette** : le trajet à 131 km/h de moyenne ne peut plus obtenir A ; chaque point perdu s'énonce en une
phrase lisible par le conducteur.

#### Lot V5 — Alerter sur ce que Tracky mesure, et prévenir vraiment · **L**

| Item | Fichier et ligne |
|---|---|
| Créer l'alerte d'excès **depuis l'analyse de trajet** : le maillon n'existe pas du tout aujourd'hui | `trip-analysis/` (aucune référence à `AlertsService`), producteurs existants `alerts.service.ts:127, 417, 507, 581, 686` |
| Ajouter le réglage manquant : seuil et activation des alertes de vitesse par société, surchargeables par véhicule | `schema.prisma` (aucune colonne de seuil aujourd'hui) |
| Rattacher l'alerte au trajet (`tripId`) pour que le clic ouvre le trajet | `schema.prisma:1758-1793`, `notification-dispatch.service.ts:1178-1187` |
| Construire l'URL au format déjà supporté `/vehicles/<id>?tab=reports&trip=<id>&tripDate=<date>` | `driving-scores.component.ts:136`, `vehicle-reports-tab.component.ts:994-996` |
| Réparer l'acquittement depuis la notification quand l'application est fermée | `sw.js:180` puis lecture du paramètre dans `alerts.component.ts` |
| Dire à l'utilisateur qu'il n'a **aucun appareil abonné** au lieu d'étouffer 4 866 notifications en silence | motif `no_device`, `notification-dispatch.service.ts` |
| Revoir la déduplication de 6 h et le regroupement de 15 min une fois l'alerte devenue « par trajet » | `alerts.service.ts:44, 70, 326`, `notification-guardrails.ts:96, 106` |

**Recette** : un trajet avec un excès réel produit une alerte, une notification arrive sur un appareil
abonné, le clic ouvre le trajet, et l'acquittement fonctionne application fermée.

#### Lot V6 — Des sentinelles qui remontent les incohérences · **M**

Demandé explicitement : que le centre d'alerte signale les incohérences au lieu de les laisser dormir.
Le point d'entrée existe et est trivial à appeler — `ErrorLogger.record(message, source, { fleetId,
vehicleId, tripId }, 'ERROR')` (`error-logger.service.ts:95`), sur le modèle de
`backup-health.service.ts:66-76`, avec le refroidissement de `refroidissement-alerte.service.ts:104`
pour ne pas écrire une ligne par trajet.

| Sentinelle | Ce qu'elle signale |
|---|---|
| Excès sans alerte | Un trajet contient un excès, la société a les alertes de vitesse activées, aucune alerte n'existe sur la fenêtre du trajet. **Dépend des lots V5 et de son réglage** — sans eux elle signalerait 100 % des trajets |
| Vitesse non corroborée | La vitesse annoncée dépasse nettement celle que permet la distance parcourue |
| Limite invraisemblable | Un excès s'appuie sur une limite ≤ 30 km/h avec une vitesse relevée au-delà de 80 |
| Analyse à couverture faible | Une part importante des points rapides n'a obtenu aucune limite |
| Destinataire sans appareil | Des notifications sont étouffées en `no_device` pour un compte censé être prévenu |
| Alerte jamais acquittée | Des alertes anciennes non acquittées s'accumulent, signe que personne ne les lit |

**Recette** : chaque sentinelle sait produire une ligne de test à partir d'un cas réel de production, et
le centre d'alerte reste lisible — une ligne par incohérence et par jour, pas une par trajet.

#### Lot V7 — Une seule définition de l'excès dans tout le produit · **M**

Quatre définitions cohabitent aujourd'hui (cf. constat 11). Tant qu'elles coexistent, deux écrans
donneront toujours deux réponses à la même question.

| Item | Fichier et ligne |
|---|---|
| Le rapport de vitesse, présenté comme pièce disciplinaire, retient un seuil **fixe à 90 km/h** sans aucune limite légale | `speed-report.service.ts:102` |
| Faire dériver ce rapport des excès réellement établis par l'analyse, une fois les lots V1 à V3 livrés | idem |
| Partager une seule fonction « ceci est-il un excès ? » entre l'analyse, le rapport de vitesse et l'affichage | à extraire vers `packages/shared` |

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
| Les périodes sont calculées en millisecondes (`− N × 86 400 000`) : aux week-ends de changement d'heure, « 30 jours » en fait 29 ou 31 | `reports.component.ts:2068-2069`, `vehicle-reports-tab.component.ts:1069-1070` | S |
| Avant un export, `refreshPeriodIfStalePreset` réaligne la période en silence sans recharger : le fichier exporté peut couvrir une autre période que celle affichée | `reports.component.ts:2599-2612` | S |
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
| **T04** — le catalogue décrit un rattrapage (1 500 h / 70 min) qui n'existe plus ; le script réel couvre toute la rétention | `background-tasks.service.ts:496` | S |
| Journaliser le recalcul de trajets : combien de trajets supprimés, recréés, et combien de récits perdus | `trips.service.ts` (après les suppressions du recalcul) | S |

| Vue d'ensemble des rapports hebdomadaires : aujourd'hui un super-admin doit changer de société dans le sélecteur pour lire chaque réglage. Un tableau unique (société · actif · jour et heure · destinataires · dernier envoi) éviterait de découvrir un rapport coupé par hasard | nouvel écran admin, alimenté par `GET /api/reports/schedule/dispatches` sans `fleetId` (déjà multi-sociétés) | M |

**Comment on saura que c'est bon** : poste éteint 25 heures → `/admin/background-tasks` affiche « à l'arrêt — dernier passage il y a 25 h » et le centre d'alerte remonte un incident ; un export refusé pour cause de droits apparaît en échec dans le Journal Système, avec le nom de la société.

---

### Lot 3 — Une analyse de trajet qui ne ment pas · **M** · contient le reste du bloquant A01

**Objectif** : que les chiffres d'un trajet soient les mêmes partout et qu'aucune analyse vide n'entre dans une moyenne.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT côté classement (A01)~~ Les analyses sans position sont exclues de la moyenne ; reste à refuser de PRODUIRE l'analyse. L'écran refuse déjà d'afficher une analyse sans position, mais l'API la produit toujours et le score de conduite l'intègre à 100/100 : un trajet dont on ne sait rien peut hisser un véhicule au podium. Refuser l'analyse sur un trajet de plus de 500 m sans position, et exclure `gpsPoints = 0` de la moyenne | `apps/api/src/trip-analysis/trip-analysis.service.ts:171` ; `driving-score.service.ts` (le champ n'y est même pas sélectionné) | S |
| ~~FAIT en partie (A11)~~ Le récit porte sa date (`narratedAt`) et l'écran signale un texte antérieur au recalcul ; reste à faire reprendre ces récits périmés par l'agent. Avant : : les badges disent « 0 excès » pendant que le texte parle de deux excès. Dater le récit (`narratedAt`, migration Prisma) et l'effacer quand un chiffre cité change, pour que l'agent local le réécrive | `trip-analysis.service.ts:229` | M |
| **A09** — trois calculs de distance et de vitesse maximale coexistent avec des seuils différents (tableau, analyse, récit). Une constante partagée, le même filtre de sauts GPS, et une mention « analyse partielle » quand le trajet dépasse le plafond de positions | `trip-analysis.preprocessor.ts:77` | M |
| **A05** — indiquer d'où vient la consommation affichée (valeur du véhicule ou valeur par défaut de 7 L/100), avec un lien vers la fiche véhicule quand elle n'est pas renseignée | DTO `trip-analysis.dto.ts` | S |
| **A23** — un lien profond depuis `/scores` ouvre une modale vide quand l'analyse n'est pas encore chargée : afficher « Chargement… » puis « Ce trajet n'a pas encore été analysé » | `trip-analysis-badges.component.ts:307` | S |
| ~~FAIT~~ Le recalcul est réservé aux rôles de gestion (super-admin, admin, gestionnaire de flotte) | `trip-analysis.controller.ts:145-167` | S |

**Comment on saura que c'est bon** : un recalcul demandé sur un trajet sans position renvoie un refus explicite ; la moyenne de `/scores` ne bouge plus quand on supprime les analyses vides ; recalculer un trajet narré dont les chiffres changent fait disparaître le récit, qui revient au passage nocturne de l'agent local — sans aucun appel de modèle facturé côté API.

---

### Lot 4 — Une seule modale « Exporter », compréhensible · **L** · *une grande partie livrée le 3 septembre*

**Objectif** : remplacer quatre boutons et des curseurs abstraits par un choix en trois blocs — Format, Périmètre, Contenu — dont le client comprend le résultat avant de cliquer.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (R09 / EXP-04)~~ La modale s'ouvre sur le périmètre de l'écran et ne propose que les véhicules de la société. Avant : elle repartait sur « Tous » et proposait au super-administrateur des véhicules d'autres sociétés (l'export échoue alors en erreur). Pré-cocher le périmètre de l'écran et n'offrir que les véhicules visibles | `reports.component.ts:879,895-897` ; `pdf-export-modal.component.ts:460-471` | S |
| ~~FAIT en partie~~ Les curseurs sont chiffrés et raccrochés aux données réelles (« 30 des 78 trajets »), avec un bouton « Prendre les 78 » ; il reste à remplacer les curseurs eux-mêmes par des choix nommés (« tous : 391 trajets, ≈ 13 pages », « 5 par véhicule ») | `pdf-export-modal.component.ts` | M |
| Rendre l'Excel disponible sur une flotte ou un groupe, pas seulement sur un véhicule, avec une feuille de synthèse par véhicule | `report-excel.service.ts`, `GenerateExcelDto` | M |
| Ajouter au CSV des colonnes de date en heure locale lisibles par Excel FR, en plus de l'horodatage technique | `report-csv.service.ts` | S |
| Partager la table de libellés d'alertes entre le PDF, le CSV et l'écran (aujourd'hui seul le PDF l'a) | `report-pdf.service.ts:54` → `packages/shared` | S |
| Feuille d'impression : `Ctrl+P` doit donner un document lisible, sans menus déroulants ni tableau tronqué | `reports.component.ts` | S |

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
| Boutons d'export et « Personnalisé » coupés à 375 px ; menu véhicule en feuille basse avec recherche au-delà de 8 véhicules ; annonce vocale du tri et du nombre de trajets chargés | `reports.component.ts` | M |

**Comment on saura que c'est bon** : `pnpm verif:contraste` au vert sur les quatre couples signalés ; à 375 px la carte de chaleur fait environ 220 px de haut avec des cellules pleines et une légende ; au lecteur d'écran, les menus s'annoncent ouverts/fermés/sélectionnés et le tableau de données de chaque graphique est lu.

---

### Lot 6 — Robustesse : ne plus tromper quand ça casse · **M**

**Objectif** : qu'une panne partielle se voie, au lieu d'être effacée par le geste suivant.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (R10)~~ Les deux pannes sont distinctes : un tri n'efface plus l'avertissement de l'autre requête. Avant : le bandeau « données incomplètes » disparaissait dès qu'on trie une colonne, alors que les indicateurs restent à zéro : plus rien ne dit que la vue est fausse. Séparer l'erreur de liste de l'erreur de résumé | `reports.component.ts:2832,2842,2936` | S |
| ~~FAIT (R24)~~ Un échec de chargement des véhicules affiche un bandeau et un « Réessayer ». Avant : il était avalé : plaques vides et filtres absents, la flotte semble vide. Afficher un bandeau et un bouton « Réessayer » | `reports.component.ts:3142-3148` | S |
| ~~FAIT (R22)~~ Toutes les minuteries du replay sont suivies et annulées. Avant : la garde de 3 s n'était pas annulée : fermer puis rouvrir en moins de 3 s affiche « la carte n'a pas pu se charger » sur une carte qui vient d'arriver | `period-replay.component.ts:905,938` | S |
| Le bouton « Réinitialiser » reste grisé après un accès par indicateur, le graphique d'activité tronque en silence au-delà de 90 jours, les analyses sont rechargées en double, et le replay période garde ses tracés en mémoire après fermeture | `reports.component.ts` | M |
| Le recalcul supprime puis recrée les trajets sans reprendre les **notes** ni le **conducteur affecté** : un travail de saisie manuelle est perdu sans que le dialogue de confirmation le dise (il annonce bien le nombre de trajets et la perte des récits, mais pas celle-là). Recopier notes et conducteur par recouvrement temporel, et compléter le texte du dialogue | `apps/api/src/trips/trips.service.ts:926-930,994` ; `reports.component.ts:3102-3106` | M |

**Comment on saura que c'est bon** : couper le résumé journalier puis trier une colonne laisse le bandeau ambre en place ; couper la liste des véhicules affiche un bandeau avec « Réessayer » ; fermer et rouvrir le replay en moins de trois secondes n'affiche plus d'erreur.

---

### Lot 7 — Replays cohérents avec l'analyse · **M** · *livré le 3 septembre pour le replay d'un trajet ; le replay de période attend encore ses analyses*

**Objectif** : que l'écran où l'on regarde le trajet montre ce que l'on sait de ce trajet.

| Item | Fichier et ligne | Effort |
|---|---|---|
| ~~FAIT (A06 / A21)~~ Le replay d'un trajet affiche récit, conseils et fiabilité, et reprend les fonctions du tableau. Avant : le replay recevait l'analyse mais n'affichait ni récit, ni conseils, ni fiabilité, et résume le trajet autrement que le tableau. Réutiliser le composant de badges en lecture seule et ajouter une section « Récit » | `trip-replay.component.ts:73-83,239-269` | M |
| ~~FAIT pour le replay d'un trajet (A07)~~ La vitesse vient des relevés horodatés ; à défaut, l'écran affiche la moyenne EN LE DISANT. Le replay de PÉRIODE, lui, ne reçoit pas les analyses : il annonce « V. moyenne » sans mentir, mais reste à brancher. Avant : la « Vitesse » était la moyenne du trajet, constante du début à la fin : pendant un excès à 124 km/h, le bandeau affiche 62 km/h. Interpoler depuis la trace horodatée de l'analyse, ou renommer « V. moyenne » et griser | `period-replay.component.ts:794` | M |
| ~~FAIT (A08)~~ La lecture est pilotée par le temps ; cliquer un événement place curseur, marqueur et caméra au même point | `trip-replay.component.ts:493` | M |
| Le total kilométrique du replay période est calculé sur la trace simplifiée et ne correspond pas à l'indicateur Distance | `period-replay.component.ts:1057-1093` | S |

**Comment on saura que c'est bon** : ouvrir le replay d'un trajet avec récit affiche récit et conseils dans le panneau latéral, les mêmes badges qu'au tableau, une vitesse supérieure à 90 km/h pendant l'excès, et un marqueur posé sous la pastille rouge quand on clique dessus.

---

### Lot 8 — État dans l'URL et liens partageables · **M**

**Objectif** : pouvoir envoyer « regarde ce véhicule sur août » à un collègue — impossible aujourd'hui, la page n'a aucun état d'URL.

| Item | Fichier et ligne | Effort |
|---|---|---|
| **F08** — aucun `Router` ni `ActivatedRoute` n'est injecté : un rafraîchissement ramène à « 7 jours / tous véhicules ». Synchroniser véhicule, groupe, dates, tri et sens avec les paramètres d'URL | `reports.component.ts` (vérifié : aucune occurrence) | M |
| **F10** — accepter `/reports?trip=<id>` et ajouter « Copier le lien » dans l'en-tête du replay | `reports.component.ts`, `trip-replay.component.ts` | S |
| **F18** — chaque indicateur est une impasse : les cartes Trajets, Distance et Durée doivent trier la liste, et une ligne du récapitulatif par véhicule doit pouvoir filtrer la page au lieu de la quitter | `reports.component.ts`, `reports.utils.ts:365-378` | S |
| **F09** — enregistrer une vue (nom + filtres) et proposer de reprendre la dernière à l'ouverture | `preferences.service.ts:121` | S |

**Comment on saura que c'est bon** : copier l'URL après avoir filtré un véhicule sur août et l'ouvrir dans un autre navigateur restitue les mêmes filtres et le même tri ; le lien du courriel hebdomadaire ouvre la page sur la semaine du rapport.

---

### Lot 9 — De page de trajets à page de gestion · **L**

**Objectif** : brancher ce que l'API calcule déjà et que la page ne demande pas. Détail des gains en section 3.

| Item | Fichier et ligne | Effort |
|---|---|---|
| **F04** — le récapitulatif « Par véhicule » agrège la page chargée, pas la période : sur 391 trajets avec une page de 100, il est faux dès l'ouverture, et il porte lui-même la mention « Sur les N trajets chargés ». L'alimenter depuis l'agrégat serveur | `reports.component.ts:445,459,485` | M |
| **F02** — brancher `GET /reports/stats` (aucun appelant côté web à ce jour) pour afficher coût carburant, litres et CO2 de la période | `reports.service.ts:71` | S |
| **F05** — bloc « Alertes de la période » par type et sévérité, déjà calculé côté serveur | `reports-stats.service.ts:446` | S |
| **F11** — parc actif et taux d'utilisation, via un point d'entrée existant et jamais appelé | `agenda/fleet-insights.controller.ts:67` | S |
| **F06** — colonne « Excès » par véhicule, et conditionner le rapport de vitesse aux excès réels plutôt qu'à un seuil fixe de 90 km/h | `reports.component.ts:689` | S |
| **F03** — comparaison avec la période précédente et écart en pourcentage sous chaque indicateur | `reports.component.ts:2043` | M |
| **F12 / F13** — ralenti moteur agrégé, et dimension conducteur (filtre + récapitulatif) | `schema.prisma:2380`, `list-trips.dto.ts:19` | M |

**Comment on saura que c'est bon** : les indicateurs « Carburant estimé » et « CO2 » de l'écran sont identiques à l'en-tête du PDF sur la même période ; le récapitulatif par véhicule est complet dès l'ouverture, sans mention « sur les N trajets chargés ».

---

## 3. Manques fonctionnels à forte valeur

Fonctions absentes repérées par l'audit. La plupart sont des raccords vers des calculs qui existent déjà côté serveur — la valeur est haute et le coût faible. Le dix-huitième constat de cette lecture, le rapport planifié réglable par le client (F14), a été livré : voir la section 1.

| # | Ce qui manque | Ce que le client y gagne |
|---|---|---|
| F02 | Coût carburant, litres et CO2 de la période | Répond à sa première question — « combien m'a coûté la flotte ce mois-ci ? » — sans générer un PDF pour y lire un chiffre déjà calculé. |
| F04 | Récapitulatif par véhicule portant sur toute la période | Le tableau qu'il lit en premier pour comparer ses véhicules cesse d'être faux dès l'ouverture. |
| F05 | Compteurs d'alertes de la période, par type et par sévérité | Il prépare son point mensuel depuis l'écran (« 14 excès, 3 sorties de zone ») au lieu d'ouvrir un fichier brut. |
| F11 | Parc actif, kilométrage moyen et taux d'utilisation | Il voit quels véhicules ne roulent pas — l'information qui justifie une mutualisation ou une restitution. |
| F06 | Excès de vitesse agrégés par véhicule | Il sait quel véhicule dépasse le plus, et le rapport de vitesse se déclenche sur un excès réel (85 km/h en zone 50) plutôt que sur un seuil fixe qui rate les uns et déclenche à tort sur les autres. |
| F07 | Podium des conducteurs et lien vers le classement | La fonction la plus « gestion de flotte » du produit devient accessible depuis le rapport, au lieu de n'exister que dans le menu latéral. |
| F03 | Comparaison avec la période précédente | Il lit une tendance (« +12 % ce mois-ci ») au lieu de comparer de tête ou dans un tableur. |
| F08 | Filtres portés par l'URL | Il peut envoyer un rapport pré-filtré à un collègue, le mettre en favori, et un rafraîchissement ne perd plus son travail. |
| F10 | Lien profond vers un trajet et « copier le lien » | Il cite un trajet précis dans un courriel ou un ticket, au lieu de demander à son interlocuteur de le retrouver dans un tableau paginé. |
| F12 | Ralenti moteur agrégé | Premier poste de gaspillage carburant maîtrisable par simple consigne ; aujourd'hui calculé par trajet et agrégé nulle part. |
| F13 | Dimension conducteur (filtre et récapitulatif) | « Combien de kilomètres a fait tel conducteur ce mois-ci, avec combien d'excès ? » trouve enfin une réponse sur un seul écran. |
| F16 | Trajets hors horaires signalés | L'usage privé ou nocturne d'un véhicule de société — motif classique d'installation d'un traceur — ressort du rapport au lieu de rester enfoui dans les alertes. |
| F17 | Export Excel d'une flotte ou d'un groupe | Le mois complet du parc tient dans un classeur mis en forme, au lieu de quarante exports ou d'un fichier brut. |
| F09 | Vues enregistrées | Un suivi récurrent (« groupe Livraisons / mois en cours ») se retrouve en un clic. |
| F15 | Impression de la page | `Ctrl+P` donne un document présentable en réunion, pas une capture de menus déroulants. |
| F18 | Ponts entre les chiffres et la liste | Chaque nombre affiché devient un point d'entrée vers son détail, au lieu d'une impasse. |

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
