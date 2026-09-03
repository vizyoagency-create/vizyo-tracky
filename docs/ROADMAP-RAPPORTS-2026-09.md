# Feuille de route — chantier « Rapports d'activité »

**3 septembre 2026** · périmètre : la page `/reports`, ses exports (PDF, Excel, CSV, rapport de vitesse), le rapport hebdomadaire envoyé par courriel, les blocs d'analyse de trajet et les replays.

---

## Résumé

Un audit croisé en 7 lectures indépendantes a produit **154 constats** (65 bugs, 26 manques fonctionnels, 63 améliorations). Les 65 bugs ont été rejoués contre le code par une vérification contradictoire : **56 confirmés** (3 bloquants, 29 majeurs, 24 mineurs), **9 réfutés**.

Sur ces 56 bugs, **22 sont entièrement réparés, 6 partiellement, 28 restent ouverts**. Le réparé touche ce que le client voit le plus : les journées se comptent en jours civils de Paris partout, le PDF ne finit plus par une page blanche et annonce « du … au … inclus », le CSV respecte le véhicule filtré à l'écran, l'Excel et le PDF donnent la même vitesse moyenne, et le rapport hebdomadaire est réglable par société avec son PDF réellement joint.

Le reste tient en trois familles : la **supervision** (un agent à l'arrêt ou un export refusé restent invisibles), la **lisibilité au doigt et en thème clair**, et la **transformation en outil de gestion** (coût carburant, alertes, taux d'utilisation — que l'API calcule déjà sans que la page les demande).

> **Livré et déployé en production le 3 septembre 2026 à 07:15** (`2f42801b`, `d00cd9ea`, `b36e8102`) — migrations `trk057` et `trk058` appliquées, 7 614 récits datés rétroactivement, routes de réglage du rapport hebdomadaire en ligne. Le lot 0 est donc clos, et une partie des lots 1 à 3, 4, 5 et 7 est partie avec : borne haute de période exclusive, en-têtes des CSV positions et commandes, périodes de la fiche véhicule alignées sur celles de la page Rapports, exports en échec tracés, analyses vides exclues du classement, datation du récit, compteur de reste à faire unifié, agents du poste qui journalisent leur passage. Les lots ci-dessous ont été relus en conséquence : ce qui reste marqué « à faire » l'est vraiment.
>
> ⚠️ **Conséquence à connaître** : le premier envoi automatique partira **lundi 8 septembre à 08:00, heure de Paris**, vers les administrateurs actifs de chaque société ayant roulé sur la semaine — y compris les sociétés d'essai (`Client test`, `cdef31`). Aucune n'a d'adresse dédiée renseignée. Pour en couper une, il suffit de basculer l'interrupteur de sa carte « Rapport hebdomadaire par e-mail » sur sa page Rapports.

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
| L'entrée « rapport hebdomadaire » du catalogue des traitements de fond et de la sonde des tâches planifiées a été corrigée. | `background-tasks.service.ts:184`, `scheduled-task-heartbeat.service.ts:144` |

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
| **R09 / EXP-04** — la modale PDF repart sur « Tous » à chaque ouverture et propose au super-administrateur des véhicules d'autres sociétés (l'export échoue alors en erreur). Pré-cocher le périmètre de l'écran et n'offrir que les véhicules visibles | `reports.component.ts:879,895-897` ; `pdf-export-modal.component.ts:460-471` | S |
| Remplacer les curseurs « Max N trajets » et « Top N » par des choix nommés et chiffrés (« tous : 391 trajets, ≈ 13 pages », « 5 par véhicule ») | `pdf-export-modal.component.ts` | M |
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
| **MOB-01** — les conteneurs de graphiques portent `role="img"`, ce qui rend invisibles aux lecteurs d'écran les tableaux de données construits pour eux, et rend présentationnels les boutons de la carte de chaleur | `charts/heatmap-chart.component.ts:61`, `line-bar-chart.component.ts:65`, `histogram-chart.component.ts:52` (et `error-timeline-chart.component.ts:40`, hors page Rapports) | S |
| **MOB-02** — à 375 px, l'étiquette de jour à 44 px étire chaque rangée de la carte de chaleur : les cellules restent à 11 px et le motif disparaît. Faire de la rangée entière la cible tactile | `heatmap-chart.component.ts:222` | M |
| **MOB-04** — les couleurs de la carte de chaleur sont codées en dur pour le thème sombre : en thème clair, une cellule vide est blanche sur blanc et les deux premiers paliers passent sous le seuil de contraste. Les composer avec les jetons | `heatmap-chart.component.ts:307` | S |
| **MOB-03** — l'infobulle est rognée sur la rangée du lundi et sur les colonnes 0 h et 23 h ; au doigt elle s'ouvre sur la mauvaise cellule et ne se referme pas | `heatmap-chart.component.ts:148` | S |
| **MOB-09** — le vert de marque sert de couleur de **texte** sur le véhicule sélectionné et le raccourci de période actif : sous le seuil de lisibilité en thème clair, précisément là où l'utilisateur vérifie ce qu'il regarde. Passer à `--texte-succes`, lavis en `color-mix` | `reports.component.ts:1160,1372` | S |
| **MOB-10** — l'ambre du bouton « Recalculer » et de l'alerte « vitesse moyenne ≥ 50 km/h » est illisible en thème clair. Passer à `--texte-attente` et ajouter un glyphe pour ne pas dépendre de la couleur seule | `reports.component.ts:313,508` | S |
| **MOB-06** — Échap ne ferme pas les menus Groupe et Véhicule, les déclencheurs n'annoncent pas leur état, et le focus retombe sur le corps de page à la fermeture | `reports.component.ts:2532` | S |
| **MOB-13 / MOB-15** — le texte dit « cliquez "Voir" » alors qu'aucun contrôle nommé « Voir » n'existe ; la plaque, seul accès à la fiche véhicule depuis une carte, fait 24 px de haut | `reports.component.ts:473,732` | S |
| **MOB-16** — une note de trajet est tronquée à 180 px et son texte complet n'est accessible qu'au survol : un conducteur ou un lecteur ne peut pas la lire sur son téléphone | `reports.component.ts:787` | S |
| Boutons d'export et « Personnalisé » coupés à 375 px ; menu véhicule en feuille basse avec recherche au-delà de 8 véhicules ; annonce vocale du tri et du nombre de trajets chargés | `reports.component.ts` | M |

**Comment on saura que c'est bon** : `pnpm verif:contraste` au vert sur les quatre couples signalés ; à 375 px la carte de chaleur fait environ 220 px de haut avec des cellules pleines et une légende ; au lecteur d'écran, les menus s'annoncent ouverts/fermés/sélectionnés et le tableau de données de chaque graphique est lu.

---

### Lot 6 — Robustesse : ne plus tromper quand ça casse · **M**

**Objectif** : qu'une panne partielle se voie, au lieu d'être effacée par le geste suivant.

| Item | Fichier et ligne | Effort |
|---|---|---|
| **R10** — le bandeau « données incomplètes » disparaît dès qu'on trie une colonne, alors que les indicateurs restent à zéro : plus rien ne dit que la vue est fausse. Séparer l'erreur de liste de l'erreur de résumé | `reports.component.ts:2832,2842,2936` | S |
| **R24** — un échec du chargement des véhicules est avalé : plaques vides et filtres absents, la flotte semble vide. Afficher un bandeau et un bouton « Réessayer » | `reports.component.ts:3142-3148` | S |
| **R22** — la minuterie de garde de 3 s du replay période n'est pas annulée : fermer puis rouvrir en moins de 3 s affiche « la carte n'a pas pu se charger » sur une carte qui vient d'arriver | `period-replay.component.ts:905,938` | S |
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
