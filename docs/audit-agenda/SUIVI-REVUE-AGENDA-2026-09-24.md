# Suivi de la revue Agenda — ce qui a été fait, et ce que la recette a trouvé en plus

**Date :** 2026-09-24 · **Échéance :** mise en service chez cdef31 le **lundi 2026-09-28**
**Point de départ :** [`AUDIT-CRITIQUE-AGENDA-2026-09-22.md`](./AUDIT-CRITIQUE-AGENDA-2026-09-22.md)
(audit daté — il reste le compte rendu de ce qui était vrai le 22/09 ; ce document-ci dit ce qui a
changé depuis).
**Version visuelle**, tenue à jour du même contenu :
<https://claude.ai/artifact/3pEq4crDmu3G1SrQ5eihuM> (tableau de bord — les trois gestes y sont
cochés, les sept défauts de recette détaillés).

---

## Verdict au 24/09

**Les trois bloquants sont levés. Le module est en production et éprouvé à l'écran.**

Mais la leçon du 22/09 se répète, en plus fort : **quatre défauts supplémentaires sont sortis en se
SERVANT de l'écran, aucun en le lisant.** Deux campagnes d'audit statique sur ce module ne les
avaient pas vus — dont le plus dangereux de toute la revue (voir R-4).

| Mesure (prod) | 22/09 | 24/09 | **27/09** |
|---|---|---|---|
| Comptes cdef31 qui ne verront rien dans l'agenda | **5 sur 6** | **0** | **0** |
| Travaux d'agent local bloqués | **7** | **0** (file vide) | **0** (file vide) |
| Réservations **fermes** à venir posées par la machine | **119** | **0** | **0** — 3 nuits de plus |
| Courriels d'exploitation (14 j) | **81** | **0 depuis la coupure** | **0** |
| Destinataires de l'avis « demande à valider » chez cdef31 | *tous les valideurs* | `standard@` seul | **`standard@` + `j.hendriks@`** |
| Objets de recette laissés en production | — | **12** | **0** |
| Lignes `CRITICAL` ouvertes nées de ce chantier | — | **8** | **0** |

> 🗓️ **Ce document a été relu en production le 27/09, la veille de la mise en service.** Deux de ses
> affirmations étaient devenues fausses et sont barrées ci-dessous. Le détail — dont un courriel de
> recette parti chez le vrai client, et l'inventaire complet des envois — est dans la section
> [2026-09-27](#2026-09-27--la-veille-de-la-mise-en-service).

---

## Les trois P0 — levés

### P0-1 — Les comptes ouvraient un agenda vide ✅

Les 4 comptes `FLEET_MANAGER` ont reçu `agenda_view`, `agenda_manage`, `reservations_view`,
`reservations_request`, `reservations_manage` et `ai_optimize`. `emu@` (veilleur) est resté fermé,
conformément à D5. L'état d'avant est conservé en base (`_sauvegarde_perms_cdef31_20260923`).

🔑 **Aucune reconnexion n'est nécessaire** : le front rappelle `/api/users/me` au montage du shell
**et au retour de focus de l'onglet** (`refreshMe`). Le prochain chargement de page suffit.

⚠️ **Le piège de lecture, qui a failli nous tromper deux fois.** Lire `users.permissions` seul fait
disparaître le fleet-admin, dont le JSON est souvent VIDE : une clé absente ne vaut pas `false`,
elle vaut le **défaut du rôle**. `j.hendriks@` ressort « agenda : non » sur une requête naïve alors
qu'il a tout par héritage.

### P0-2 — Les agents locaux étaient à l'arrêt ✅

Cause exacte, écrite en base : une pause posée le **17/09 à 08:50**, motif
*« session Claude Code non authentifiée : 401 OAuth access token has expired »*, `jusqua` vide,
jamais levée — **5 j 23 h**. Levée le 23/09, puis rattrapage lancé à la main :
**11 travaux livrés, 0 reposé, 0 en échec**, coût équivalent API ~1,67 $ **absorbé par
l'abonnement du poste** (donc 0 €, conforme à la politique « récurrent = local »).

La sentinelle qui surveille désormais **la file elle-même** (et plus seulement les passages
manqués) a crié pendant l'opération : `agents-locaux CRITICAL` à 09:50, « File des agents du poste
bouchée : 8 travaux en attente ». Elle fonctionne.

### P0-3 — L'agenda était rempli à 99 % par la machine ✅

**L'agent ne réserve plus fermement**, quel que soit le réglage `autonomy` en base
(`AUTONOMIE_FERME_AUTORISEE = false`, un seul endroit à rebrancher si la calibration s'améliore).

Les **116 réservations fermes à venir** ont été reprises depuis la feuille « Réorganiser »
(simulation d'abord — son compte était identique à une sauvegarde SQL faite séparément, deux
sources concordantes), puis l'agent a été relancé : **107 propositions, 0 réservation ferme**.
Filet conservé : `_sauvegarde_resa_auto_cdef31_20260923`.

🔴 **La mesure qui a renversé la décision, et qu'il faut connaître : `confidence` est sur 0→1
quand `confidenceThreshold` est sur 0→100.** Les propositions `pending` sont donc celles que
l'agent a jugées **PAS assez sûres** (0,40–0,70), pas une réserve de bonnes prévisions
(`auto_applied` : 0,80–1,00). J'allais conclure « annuler les fermes, les fantômes prendront le
relais » : c'était faux, ça aurait retiré les meilleures pour ne garder que les plus faibles.
La bonne manœuvre était **annuler PUIS relancer l'agent** — il ne peut pas poser de proposition
sur un créneau occupé (`isVehicleFree`).

---

## Les décisions tranchées

| | Décision | Résultat |
|---|---|---|
| **D1** | L'agent garde-t-il le droit de réserver seul ? | **Non** — suggestions seules, pour tout le monde |
| **D2** | Que fait-on des réservations automatiques ? | **Reprises** (116) puis rendues en propositions |
| **D3** | Qui voit quoi chez cdef31 ? | Les 4 managers en complet ; veilleur inchangé |
| **D5** | Le veilleur voit-il l'agenda ? | **Non**, inchangé |
| **D6** | Le lien public reste-t-il actif ? | **Oui** — éprouvé de bout en bout |
| **D7** | Seuil d'alerte sur la file ? | 12 h (avertissement) / 36 h (critique), exercé |

---

## R — ce que la recette a trouvé, et que l'audit n'avait pas vu

> Ces quatre défauts sont sortis **en se servant de l'écran**. Aucun n'était visible en lisant le
> code. C'est la leçon centrale de cette revue.

### 🔴 R-4 — Créer un évènement proposait les véhicules de TOUS les clients

Le plus dangereux de toute la revue. Bandeau société réglé sur « Client test », la liste déroulante
du formulaire « Nouvel évènement » proposait **51 véhicules** — dont ceux du cdef31 (`HD-292-SH`,
`FV-941-LZ`, `DZ-034-CA`) et de mh cars (`EZ-259-DB`).

Poser une maintenance, **ou un incident IMMOBILISANT**, sur le véhicule d'un autre client tenait à
un choix dans une liste. Et **le serveur l'aurait accepté** : un super-admin a bien le droit sur
ces véhicules. Rien ne l'arrêtait en aval.

Le composant exposait déjà `scopedVehicles()` ; le gabarit itérait `vehicles()`. Corrigé
(`908d20a0`) : après correctif, **8 véhicules**, Client test seulement.

🔑 **Réflexe à garder : chercher `of vehicles()` dans tout gabarit qui propose une liste.**
N'affecte que les super-admins — c'est-à-dire exactement le compte depuis lequel on administre
plusieurs clients.

### 🔴 R-2 — Valider ou refuser une demande ne laissait aucune trace

Le **dépôt** d'une demande publique était journalisé (`public_booking_submitted`) ; la **décision**
ne l'était pas. C'est l'inverse de ce qu'il faut : chez un client dont le standard valide les
demandes des conducteurs, c'est la décision qui engage.

Découvert parce que deux demandes de « Client test » étaient passées à `CONFIRMED` et que **rien ne
permettait de dire qui les avait validées**.

Trois actions distinctes depuis — `reservation_validee`, `reservation_refusee`,
`reservation_annulee`. Refuser une demande en attente et annuler une réservation déjà ferme passent
par le même appel : c'est le statut d'AVANT qui les sépare, et les confondre raconterait une
histoire fausse.

### 🔴 R-3 — Le glisser-déposer était inerte au doigt

Sous **640 px**, la grille masque les pilules texte au profit de pastilles de couleur (décision
d'espace : une cellule de 44 px ne tient pas trois libellés). Or le geste était attaché aux
**pilules**. Sur un téléphone, il n'y avait littéralement **rien à saisir**.

⚠️ **La fonction avait été livrée la veille sous le titre « au doigt comme à la souris ».** Elle ne
marchait pas sur l'appareil qu'elle visait en premier — le standard traverse son dépôt avec un
téléphone, c'était l'argument même de son existence.

🔑 **Un test qui n'a pas pu tourner n'est pas un test réussi.** La fenêtre Chrome maximisée refuse
`resize_window` (viewport bloqué à 1920 px) : le tactile n'avait été vérifié que sur la page
publique, qui n'a pas ce seuil. Le défaut ne s'est vu qu'en **lisant les règles CSS**.

### R-1 — Le motif saisi n'apparaissait nulle part

On tape « Ramassage scolaire secteur nord » — le formulaire le propose lui-même en exemple — et le
calendrier affiche « Réservation ». Le texte était enregistré dans `metadata.reason`, mais toutes
les surfaces lisent `title`. Corrigé **à la source** (`title ← reason` quand aucun titre explicite),
plutôt qu'à l'affichage : patcher chaque endroit aurait garanti d'en oublier un.

### R-5 — Les annulations à venir encombraient l'agenda

Défaut **créé par la reprise en masse elle-même** : les 116 annulations se sont affichées **barrées**
sur les deux semaines suivantes. L'outil censé désencombrer l'agenda le rendait moins lisible
qu'avant de s'en servir.

Une annulation dont le créneau n'a pas encore commencé n'aura pas lieu : on ne l'affiche plus. Le
**passé** garde sa trace barrée — là, l'annulation explique un trou dans l'activité.

### R-6 — La carte QR imprimait un domaine qui n'existe pas

Le pied affichait `tracky.vizyoagency.com` (défaut hérité de la carte de déverrouillage) alors que
l'application est servie sur **`app-tracky.vizyoagency.com`**. Le QR encodait la bonne URL — le scan
marchait —, mais cette carte est faite pour être **imprimée et affichée au dépôt** : un conducteur
qui ne peut pas scanner retape ce qu'il lit, et tombait sur un 404.

### R-7 — « À venir & en retard » dépendait du mois affiché

Les trois compteurs viennent de `/agenda/summary` (en retard + 30 jours) ; la liste juste en dessous
se servait dans les événements du **mois affiché**. D'où « 1 À VENIR (30J) » au-dessus d'une liste
vide, et une liste qui changeait de sens en feuilletant les mois.

---

## Hors agenda — traité en chemin

### 🔴 Le compte admin du cdef31 était injoignable depuis le 27/07

`admin@cdef31.org` : **7 `FAILED` (code `suppressed`), 1 rebond dur, 1 courriel bloqué en file —
zéro remis en 8 semaines**, pendant que `mh cars` en recevait 9.

🔑 **La liste de suppression Resend était le SYMPTÔME, pas la cause.** Après l'avoir vidée, un envoi
de test a **rebondi immédiatement** : la boîte elle-même n'existait plus. Le compte a été basculé sur
`j.hendriks@cdef31.org` (Vizyo Auth **et** Tracky, `authUserId` préservé donc rôle, flotte et
permissions intacts ; `AuditLog` laissé tel quel — c'est l'historique). Mot de passe réinitialisé
par l'intéressé, 5 sessions révoquées.

⚠️ **Contrôle à faire avant toute mise en service client** :
`SELECT "toAddress", status, count(*) FROM email_logs WHERE "toAddress" ILIKE '%<domaine>%' GROUP BY 1,2`.
Chez cdef31 : `standard@` **DELIVERED**, `admin@` injoignable, et les **3 autres managers n'ont
jamais reçu un seul courriel** — donc joignabilité **inconnue**, ce qui n'est pas « bon ».

### Valider et être prévenu étaient le même réglage

Ouvrir la validation à quatre gestionnaires leur envoyait mécaniquement **quatre courriels par
demande**, aux boîtes du client, sans qu'aucun réglage ne puisse l'en empêcher.

Séparé : le **droit** reste `reservations_manage`, l'**avis** est `users.reservationNoticeEnabled`,
réglable depuis « Paramètres de l'agenda » sous le lien public. ⚠️ **Le serveur refuse de couper le
dernier destinataire** — une demande qui n'atteint personne resterait en plan sans que quiconque le
sache.

Chez cdef31 : **`standard@` seul est prévenu** ; les cinq autres valident sans recevoir d'avis.

### Les alertes d'exploitation passent au push

**81 courriels en 14 jours** (dont 65 « erreur critique ») partaient sans interrupteur. Les trois
émetteurs **poussent d'abord**, puis consultent le réglage — couper l'e-mail ne peut donc pas rendre
sourd. Un garde refuse de fermer les deux canaux. Résultat mesuré : **0 courriel d'exploitation**
depuis la coupure.

### Deux défauts de `deploy.sh`

1. **Il sortait en code 0 sans avoir déployé** — un appelant automatisé l'aurait cru réussi.
2. **Il détruisait sa propre source** : l'élagage des vieux repères passait AVANT la pose du
   nouveau ; quand l'image en service n'était nommée que par un de ces repères, le `docker tag`
   suivant visait un fantôme et `set -e` tuait le déploiement.

⚠️ Et un troisième, évité de justesse en corrigeant : un conteneur peut tourner sur une image
**supprimée sous lui** (`docker inspect` rend toujours un ID). Se rabattre sur `latest` dans ce cas
poserait le repère sur **l'image qu'on s'apprête à déployer** — le repli ramènerait exactement à la
version qu'on voulait quitter. Le script le dit et ne pose rien. 131 → **137 contrôles**, l'ordre
prouvé **par mutation**.

---

## Ce qui reste

| | Sujet | Pourquoi ce n'est pas bloquant |
|---|---|---|
| ✅ | ~~**Le tactile réel n'a pas pu être éprouvé**~~ | La fenêtre Chrome refuse tout redimensionnement ; c'était la seule case qu'on ne pouvait pas cocher d'ici — et le terrain où R-3 s'est produit. **Validé par le propriétaire sur un vrai téléphone le 27/09 au soir.** |
| ⚠️ | Joignabilité des 3 managers cdef31 | ~~Décision prise de ne rien leur envoyer.~~ **Tranché malgré nous le 24/09** — voir la section du 27/09 : `r.garrigue@` et `t.boulay@` sont **joignables**, `astreinte@` est une **boîte morte**. |
| 🟡 | Rattrapage des tracés | ~~9 871 restants, 364/jour, ≈ 27 jours.~~ **8 798 au 27/09, 367/jour mesurés, ≈ 24 jours.** Voir ci-dessous. |
| ✅ | ~~Compteur « EN RETARD » ≠ liste~~ | Le compteur ne comptait que les `PLANNED`, la liste incluait `OPEN`/`IN_PROGRESS`. **Corrigé le 27/09 au soir** (`e030e80c`) : une seule règle des deux côtés, `estUneEcheance`. Voir la section *27/09 au soir*. |
| ✅ | ~~P1-4, P1-5, P2-1 de l'audit du 22/09~~ — et P2-3 → P2-7 | **Corrigés le 27/09 au soir** (`7e104eef`, `b7bf1b74`, `e030e80c`), **pas déployés**. Voir la section *27/09 au soir*. |
| 🧹 | 11 objets de recette sur « Client test » | ~~Marqués `seed-agenda-2026-09-23`, à supprimer.~~ **Supprimés le 27/09**, avec un 12ᵉ resté chez cdef31. |

### Le rattrapage des tracés — pourquoi on ne l'accélère pas

**Le recalage tape `router.project-osrm.org`, le serveur de DÉMONSTRATION gratuit d'OSRM.**
L'enveloppe de 15 par passage est une limite de **courtoisie**, pas une limite technique — le
commentaire du code le dit : « sans jamais bousculer le service public d'OSRM ».

La monter à 50 (le plafond) donnerait ~8 jours au lieu de 27, mais quadruplerait la charge sur le
service de quelqu'un d'autre. ⚠️ **L'IP de ce VPS s'est déjà fait bannir d'`overpass-api.de`
exactement comme ça** — c'est pourquoi l'agent des limites de vitesse tourne depuis le poste.

Deux vraies pistes, **après lundi** :

1. **Un agent de recalage sur le poste**, sur le patron de l'agent des limites de vitesse. Le code
   note que depuis le poste « la même requête passe et **répond trois fois plus vite** ». Chantier
   balisé : outil, tâche planifiée, journal de passages. *Aucun outil de ce type n'existe encore.*
2. **Auto-héberger OSRM** (`OSRM_BASE_URL`). Lève toute limite, mais plusieurs Go de RAM sur un VPS
   2 vCPU que l'hébergeur a déjà bridé une fois. **Déconseillé.**

🔑 **Et une erreur de mesure à ne pas refaire : un compteur n'est pas un débit.** Estimer le rythme
en comparant deux comptages à 24 h d'écart **soustrait silencieusement les nouveaux arrivants** —
ça donnait « 97/jour ». Mesurer ce qui a été **traité** (`polylineMatchedAt > now() - 24h`, en
écartant les trajets recalés à leur création) donne **364/jour**. Presque quatre fois plus.

---

---

## 2026-09-27 — la veille de la mise en service

> Relecture complète de la production, trois jours après. **`origin/main` n'a pas bougé** depuis le
> 24/09 : aucun code d'agenda n'a été touché. Ce qui suit est mesuré, pas déduit — et **deux
> affirmations de ce document étaient devenues fausses**.

### 🔴 Un courriel de recette est parti chez le vrai client — et ce n'était pas le 21

L'évènement créé le **24/09 à 00:53:48** est `cdef31` / « Demande publique », métadonnée
`freeText: "J'ai besoin d'une voiture pour demain"` : **la demande de recette a été déposée par le
lien public du vrai client**, pas par celui de « Client test ». Elle a expédié
`reservation_request_pending` à **5 adresses de cdef31** — `j.hendriks@`, `r.garrigue@`,
`t.boulay@`, `standard@` remis, `astreinte@` **rebondi**. La séparation avis/droit a été déployée
**trois minutes plus tard**, à 00:56.

🔑 **La règle qui manquait, et qui manque encore dans le code : toute recette du lien public se fait
sur « Client test ».** Il n'existe **aucun garde-fou** — pas de liste blanche, pas de mode test, pas
de redirection dans `email.service.ts` : un envoi part vers la vraie boîte du vrai client, toujours.
C'est la cause racine, et elle n'est pas corrigée.

⚠️ **Effet secondaire : l'erreur a répondu à la question que ce document laissait ouverte.**
`r.garrigue@` et `t.boulay@` sont `DELIVERED`, donc **joignables**. `astreinte@cdef31.org` a
**rebondi dur** : c'est une **boîte morte**, comme `admin@` l'était. Il faut la vraie adresse auprès
du client — sans elle, ce compte ne peut recevoir ni avis ni réinitialisation de mot de passe.

### Les destinataires de l'avis : `standard@` **et** `j.hendriks@`

Décision du propriétaire le 27/09, qui remplace le « `standard@` seul » du 24/09.

| Compte | Rôle | Peut valider | Reçoit l'avis |
|---|---|---|---|
| `standard@` | FLEET_MANAGER | ✅ | ✅ |
| `j.hendriks@` | FLEET_ADMIN | ✅ | ✅ |
| `astreinte@` · `r.garrigue@` · `t.boulay@` | FLEET_MANAGER | ✅ | ❌ |
| `emu@` | NIGHT_WATCHMAN | ❌ (explicite, D5) | ❌ |

### 🔑 L'adresse du rapport hebdomadaire n'est écrite nulle part — et la bascule l'a réparée

`fleets.weeklyReportEmail` est **vide pour toutes les sociétés** et
`fleet_report_schedules.recipients` est **`{}`** partout. `report-schedule.service.ts:308` retombe
donc sur `adminEmails()` — **les FLEET_ADMIN actifs de la société**. C'est pour cela que le rapport
partait vers `admin@cdef31.org` : c'était l'adresse du fleet-admin.

**La bascule du 23/09 a donc corrigé TRK-094 sans qu'on le sache** : le seul FLEET_ADMIN de cdef31
est désormais `j.hendriks@`, adresse prouvée `DELIVERED`. ⚠️ Le centre d'alerte prédisait encore un
rebond le 28/09 — **cette prédiction était périmée**, elle avait été écrite sans savoir que le
propriétaire du compte avait changé d'adresse. *Une prédiction datée doit être relue quand son
support a bougé.*

Conséquence à connaître : l'adresse restant **dérivée**, l'ajout d'un second fleet-admin chez cdef31
le mettrait **silencieusement** en destinataire du rapport. Décision du propriétaire : on laisse
dérivé, c'est le bon comportement.

### L'inventaire des envois qui peuvent atteindre un client

| Modèle | Déclencheur | Va vers | État au 27/09 |
|---|---|---|---|
| `weekly_report` | cron, **lundi 08:00 Paris** | dérivé : FLEET_ADMIN actifs | cdef31 → `j.hendriks@` · mh cars → `mhcars31@` · **Client test, A2R, Ahmed : coupés** |
| `reservation_request_pending` | demande par le lien public | `standard@` + `j.hendriks@` | ✅ |
| `reservation_requested` / `_confirmed` | dépôt / validation | le demandeur | ✅ |
| `device_verification` · `password_reset` | geste de l'utilisateur | lui-même | ✅ |
| `critical_error_alert` · `error_rate_alert` · `agents_pause` | exploitation | `contact@vizyoagency.com`, débrayable | ✅ 0 depuis la coupure |
| rappels d'entretien | cron 07:00 | fleet-admins | ✅ **inerte** : cdef31 a 0 plan |
| `alert` · `lead*` · `quote*` · `invitation` · `installation_*` | flux dédiés | — | dormants ou hors cdef31 |

### Le ménage du 27/09 — vérifié après écriture

| | Avant | Après |
|---|---|---|
| Objets de recette sur Client test | 11 | **0** |
| La demande de recette restée sur cdef31 | 1 | **0** |
| Courriels bloqués en `QUEUED` | 1 | **0** |
| `agents-locaux` CRITICAL ouvertes | 2 | **0** |
| `email-bloque` CRITICAL ouvertes | 6 | **0** |
| `autonomy` en base pour cdef31 | `auto_high_confidence` | **`suggest`** |

Deux précisions : **aucune table ne référence `vehicle_events`**, la suppression ne cascadait donc
sur rien ; et **cdef31 est la seule société à avoir une ligne `agenda_agent_settings`**, le piège du
rebranchement n'existe nulle part ailleurs. Les **77 réservations annulées** du 23/09 sont
conservées : ce n'est pas de la recette mais la trace de D2, et elles sont invisibles au calendrier
(R-5).

### 🔴 Deux défauts de plus, dans du code écrit pendant cette revue

**T83 — la sentinelle de file ne referme pas ses propres lignes.** Deux `agents-locaux` `CRITICAL`
du 23/09 11:50 étaient **encore ouvertes** au 27/09 alors que la file est vide depuis. Elle crie
quand la file se bouche et se tait quand elle se vide, sans jamais dire que c'est réglé. Closes à la
main ; le correctif reste à écrire, sinon ça reviendra à la prochaine pause.

**L'écran d'arriéré surestime le rythme — l'erreur que ce document dénonçait, recommise dedans.**
`background-tasks.service.ts` calcule `parJour` avec `polylineMatchedAt >= now() - 24h`, **sans
écarter les trajets recalés à leur création**. Mesuré sur 7 jours : **463/jour affichés contre
367/jour de vrai rattrapage** (+26 %), soit ~19 jours annoncés au lieu de **~24 jours réels**.
🔑 *Écrire la leçon ne suffit pas : il faut la relire en codant l'écran qui la mesure.*

### Ce qui reste avant demain

| | Sujet | Qui |
|---|---|---|
| ✅ | **Le tactile réel** — glisser-déposer au doigt sur un vrai téléphone | **validé par le propriétaire le 27/09 au soir**. La dernière case s'est cochée là où elle devait : sur l'appareil. |
| ⚠️ | La vraie adresse de `astreinte@cdef31.org` | à demander au client |
| ✅ | P1-4, P1-5, P2-1, P2-3 → P2-7, compteur « en retard » ≠ liste | **corrigés, testés et poussés le 27/09 au soir** (`7e104eef`, `b7bf1b74`, `e030e80c`) — voir ci-dessous. **Pas déployés** : décision du moment de mise en production laissée au propriétaire, la veille du go-live. |

### 28/09 01:00 — la preview sur la démo, avant de mettre en ligne

Décision du propriétaire : **déployer lundi vers 10 h, mais tester avant sur de vraies données.**
La démo (`demo-tracky.vizyoagency.com`) est faite pour ça : la vraie flotte pseudonymisée
(« Transports Méridien », 37 véhicules, 16 884 trajets), isolée de tout véhicule et de toute clé
SMS/push. Les images de `main` (`cd472914`) ont été construites sur le VPS **sans recréer la
production** (même image `11ad5120fb74` avant et après, vérifié), la démo seule recréée, saine en
20 s, les marqueurs du nouveau code présents dans ses deux conteneurs. Plan de recette, une case
par geste : [`RECETTE-PREVIEW-DEMO-2026-09-28.md`](./RECETTE-PREVIEW-DEMO-2026-09-28.md).

⚠️ **L'agenda de la démo part vide, par construction** : `vehicle_events`, propositions, réglages
d'agent et liens publics sont exclus de l'import (ce sont les tables qui portent noms, téléphones
et textes libres). On y crée ses objets, et on fait tourner l'agent sur les vrais trajets.

⚠️ Les six lignes d'erreur au démarrage de la démo sont **structurelles** (webhooks fermés faute de
secret, SMS en `noop`, kill-switch des coupes) — celles que son compose annonce. Rien du nouveau code.

### 27/09 au soir — les six derniers points de l'audit, corrigés

Tous mesurés avant d'être touchés ; aucune migration dans le lot ; `ng build` passé (seul lui voit
les gabarits Angular). +12 tests.

| | Ce qui était faux | Ce qui est vrai maintenant |
|---|---|---|
| **P2-1** | « Terminé » / « Supprimer » sur une MISSION depuis le panneau du jour **libérait le véhicule pendant une mission qui existait toujours** ; le serveur ne refusait que la RÉSERVATION | Refusé côté serveur avec le bon geste dans le message (« se pilote depuis l'onglet Missions »), et le panneau n'offre plus ces boutons sur une mission. Dormant chez cdef31 (0 mission), actif chez mh cars (7). |
| **compteur ≠ liste** | « En retard » ne comptait que les PLANNED ; la liste affichait aussi OPEN et IN_PROGRESS — « 1 en retard » au-dessus de trois lignes rouges | **Une seule règle**, `estUneEcheance` (`agenda.utils.ts`), appliquée des deux côtés : PLANNED, et OPEN à échéance passée. Un IN_PROGRESS n'est ni à venir ni en retard — il est en cours, et c'est « Incidents ouverts » et le panneau du jour qui le portent. Le contrat du DTO disait déjà « PLANNED/OPEN » : le contrat était juste, le code non. |
| **P2-4** | Filtrer par groupe ou véhicule ne changeait pas les compteurs | Même périmètre que la liste (`vehicleId` / `groupId` sur `/agenda/summary`). Le filtre de **type** reste hors des compteurs, exprès : chacun est typé par nature. |
| **P2-3** | `take: 1000`, trié par date : au-delà, **la fin du mois disparaissait en silence** | Plafond à 3 000 (un parc de 30 véhicules à deux réservations par jour en produirait 2 500 sur six semaines), et **quand il mord, le journal le dit** avec la société et la fenêtre. |
| **P2-5** | 2 049 `expired` + 172 `dismissed` jamais purgées, ~30 lignes par nuit et par société | Purge horaire, bornée par lot, des propositions closes depuis plus d'un trimestre. **Jamais** `pending`, `applied`, `auto_applied` — elles pointent une réservation créée, c'est l'historique qui a permis la mesure du 23/09. Mesuré : au premier passage elle n'efface **rien** (plus ancienne close : 09/07, 81 j). |
| **P2-6** | `GET /reservations/suggest` et son client web : aucun appelant | Retirés. `ReservationsService.suggest()` reste — l'optimiseur de placement s'en sert. Une route sans consommateur est de la surface d'attaque, pas une fonctionnalité. |
| **P2-7** | Un type de pastille `report` que rien ne produisait, et un `case 'report': break` « à brancher plus tard » | Retiré de l'union. On l'ajoutera avec son producteur. |
| **P1-4** | La feuille Optimisation avait **son** sélecteur de société : l'en-tête pouvait dire cdef31 pendant que la feuille changeait le métier de mh cars ; et `loadedOnce` ne chargeait qu'à la première ouverture | Une seule source : la société du **bandeau**, affichée dans la feuille. Chaque ouverture relit métier et mutualisations. |
| **P1-5** | Un rechargement pendant ou après l'analyse de capacité perdait le résultat → **analyse repayée** | Mémorisé dans le navigateur dès qu'il arrive, par société, restauré avec sa date, oublié une fois appliqué. 🔑 **La clé porte la société réelle** (bandeau pour un super-admin, compte pour les autres) : ma première version utilisait une clé commune à tous les non-super-admins — deux comptes de sociétés différentes sur le même navigateur auraient lu les plaques et modèles l'un de l'autre. Trouvé en relisant avant de committer. |

### Le ménage et les correctifs du 27/09 au soir

**Corrigés, testés, poussés (`2f35014e`) — mais PAS déployés**, décision assumée : on ne recrée pas
la production la veille d'une mise en service pour de l'observabilité. À déployer après lundi.

- **T83** — une file redevenue saine archive maintenant sa ligne, par type, et oublie son
  refroidissement (sinon une rechute dans les 23 h resterait muette, et la fermeture n'aurait servi
  qu'à masquer la panne). Et l'âge part du plus tard de la création du travail **et** de la fin de la
  dernière pause : une file ne reproche que les heures où quelque chose pouvait la consommer.
  La fermeture, elle, n'est **pas** muette sous pause — une file vidée a cessé d'être bouchée.
- **`parJour`** — l'écran exclut désormais les tracés recalés à leur création. 13 tests ajoutés.
- ⚠️ **Un mensonge du harnais trouvé en écrivant ces tests** : le double de
  `pauseAgentsLocaux.findFirst` rendait la première ligne quoi qu'il arrive, donc une pause **déjà
  levée** passait encore pour active et la sentinelle se taisait à tort. Le test était juste, le mock
  avait tort.

**Ménage de la production, vérifié après écriture** : 11 objets de recette sur « Client test », ma
demande de recette restée sur cdef31, et les **77 réservations annulées à venir** supprimées ; le
courriel bloqué en `QUEUED` clos ; les **8 `CRITICAL`** de ce chantier refermées ; `autonomy` aligné
sur `suggest`. Le filet `_sauvegarde_resa_auto_cdef31_20260923` garde ses **116 lignes**, et les
**43 annulations passées** restent barrées là où elles expliquent un trou d'activité.
🔑 **Aucune table ne référence `vehicle_events`** : les suppressions ne cascadaient sur rien.

**`astreinte@cdef31.org`, ce qu'il était possible de faire** : `reservationNoticeEnabled` est le
**seul** interrupteur e-mail par compte du modèle `User`, et il est coupé. L'adresse n'apparaît dans
**aucun** réglage (ni `weeklyReportEmail`, ni `recipients`). Restent deux émetteurs **sans
interrupteur par compte** — `depot-incident.service.ts` et `mission-requests.service.ts`, qui visent
tous les `FLEET_ADMIN` + `FLEET_MANAGER` — mais ils sont **inertes chez cdef31** : 0 compte dépôt,
0 mission, 0 demande de mission. ⚠️ Les deux chemins restants (`password_reset`,
`device_verification`) sont déclenchés par l'utilisateur : **ce compte ne peut donc pas franchir une
vérification d'appareil**, et c'est ça le vrai problème, pas la notification.

---

## 2026-09-28, 07 h – 09 h — la recette sur la démo, et ce qu'elle a trouvé

Chrome piloté sur `demo-tracky.vizyoagency.com` (compte du propriétaire, bandeau « Transports
Méridien »), plan `RECETTE-PREVIEW-DEMO-2026-09-28.md`, sections 0 à 4 et 7 exercées geste par
geste, **requêtes réseau lues à chaque étape**. Le tactile avait été validé la veille au téléphone
par le propriétaire. Les cases cochées et les verdicts sont dans le plan lui-même.

### Ce qui marche, prouvé à l'écran et dans le réseau

- **Compteurs et liste** suivent le même périmètre : `GET /agenda/summary?…&vehicleId=` part à
  chaque changement de filtre (P2-4) ; le filtre de type laisse les compteurs en place.
- **Glisser-déposer** à la souris : `PATCH` 200, heure et durée conservées ; vers le passé : refusé.
- **Réservation** depuis la barre : le motif devient le titre (R-1) ; **carte QR** avec le domaine
  de la démo (R-6) ; **lien public** → demande de 11 places → deux véhicules de 9 pré-retenus (même
  `bookingRef`) ; `reservation_requested` au demandeur, `reservation_request_pending` aux deux
  valideurs cochés, `public_booking_submitted` dans l'activité ; **valider** →
  `reservation_validee` + courriel de confirmation ; **refuser** → `reservation_refusee` ; couper le
  **dernier** destinataire → `PUT` 400 et toast (garde tenue).
- **L'agent** sur les vrais trajets : activé, métier GENERIC enregistré (`PUT agent-settings` 200,
  `PATCH fleet-metier` 200), « Lancer l'analyse » → **453 propositions, 0 réservation ferme**, en
  pointillé sur la grille ; panneau du jour « Proposé par l'agent » → **Réserver** (`POST …/apply`
  201 : pilule ferme, pointillé décrémenté) et **Écarter** (`POST …/dismiss` 201) ; la liste
  « Propositions IA » ne montre que des départs à venir ; **Réorganiser** → 30 j → posées par
  l'agent → simulation juste, appliquée (`POST /reservations/reorganiser` 200 × 2), et **les deux
  annulations ont disparu de la grille** (R-5).
- `/admin/background-tasks` : le catalogue rend le rattrapage des récits avec son rythme et son
  périmètre, sans erreur de rendu.

### Ce qu'elle a trouvé — neuf défauts corrigés le matin même, sur `main`

| | Constat | Correctif |
|---|---|---|
| 🔴 **F18** | **« Posées par l'agent » englobait les demandes du lien public.** Le flux public écrit `source: SYSTEM` comme l'agent ; « Réorganiser → posées par l'agent → tout annuler » aurait annulé une demande de conducteur validée par le standard. Chez un client où l'agent ne réserve rien (cdef31, autonomie « suggestions »), **les SYSTEM sont même exclusivement ça**. Vu à l'écran : « GD-057-AG · agent » sur ma demande publique. | `origineReservation()` dans `reservations.service.ts` : `agent` / `public` (`metadata.public`) / `manuelle` ; le filtre `auto` ne prend plus que l'agent ; l'aperçu porte `origine` et l'écran étiquette « lien public ». Test ajouté. |
| 🔴 **F19** | **La grille ne montrait que les 200 premières propositions** (`take: 200` dans `list()`, tri par départ) : 453 préparées, badge « 200 », et **plus rien après le 3 octobre** — sans un mot. Même famille que P2-3. | Plafond porté à 1 000, et le journal le dit quand il mord (`PROPOSITIONS_LISTE_MAX`). |
| **F1** | **Un incident déclaré à l'instant passait « EN RETARD » dans la seconde** : la règle commune du 27/09 (« PLANNED, ou OPEN à échéance passée ») comptait un OPEN dont `startAt` = maintenant. Mon propre défaut, né en corrigeant « compteur ≠ liste ». | Seul un PLANNED est une échéance, des deux côtés (`estUneEcheance`, `summary`) ; le **contrat du DTO** est corrigé — c'est lui qui avait tort le 24/09, pas seulement le code. Un OPEN vit dans « Incidents ouverts », comme un IN_PROGRESS. Tests réécrits. |
| **F2** | Les badges **● activité / ~ prévu**, empilés en colonne, recouvraient la première pilule : « Vidange + filtres (recette — J… » passait sous « ● 13 / ~18 ». | Badges en ligne, sur la rangée du numéro du jour (`agenda-calendar.component.ts`). |
| **F5** | La carte du jour d'une réservation montrait **le motif deux fois** (il est devenu le titre le 24/09). | `reservationReason()` tait le motif quand il est le titre. |
| **F6** | **Paramètres → Métier affichait « Transport d'enfants » pour une flotte GENERIC** : `[value]` sur le `<select>` est posé avant que les options existent (`@for`), le navigateur retombe sur la première. Rien n'était écrit à tort (le `PATCH` ne part qu'au changement), mais on lisait un réglage faux. | `[selected]` sur chaque option. |
| **F7** | **Deux ascenseurs emboîtés** dans la feuille Paramètres (`.aas-body` 62 dvh dans `.bs-content`) : à la molette, « Qui reçoit les demandes à valider » et les boutons du bas restaient hors d'atteinte. | Un seul ascenseur (celui de la feuille), pied en `position: sticky`. |
| **F14** | La ligne d'un destinataire était un `<label>` entier : **un clic sur l'adresse basculait l'avis, et le `PUT` partait aussitôt** — j'ai coupé l'avis d'un gestionnaire par un clic égaré (rétabli). | Seul l'interrupteur agit ; l'adresse est son `aria-label`. |
| **F15** | La file « À valider » appelait `GET /reservations?status=REQUESTED` **sans le filtre société** du bandeau (super-admin) — « Demander » le portait, « À valider » l'avait oublié. | `fleetId` passé. |

### Ce qui reste à reprendre — après la mise en service, rien de bloquant

- **F3** — les badges ● / ~ des cellules ignorent les filtres véhicule / groupe (ils parlent de tout
  le parc) ; à scoper, ou à dire.
- **F13** — une demande publique de 11 places pré-retient **deux** véhicules de 9 : la file « À
  valider » les montre comme deux demandes indépendantes (même `bookingRef`). À regrouper : une
  carte, un choix, une décision.
- **F16** — un **refus** ne prévient pas le demandeur (la validation, si).
- **F17** — l'activité système note `actor: 'utilisateur'` sur une décision, le nom n'est qu'en
  `meta.parUtilisateur` ; c'est la convention de tout le dépôt (`opérateur`, `conducteur`…) : à
  changer d'un coup, ou pas.
- **F20** — le lien « Agent IA — DÉCOUVRIR » de la barre latérale mène à `/agenda`, rien de plus.

### Ce que la démo n'a pas pu éprouver, et pourquoi

| | Pourquoi | Ce qui en tient lieu |
|---|---|---|
| **§5 Optimisation** (P1-4, P1-5) | le bouton n'existe que si la fonctionnalité IA « capacité » est ouverte à la société (`aiStatus.can('capacity')`), et elle ne l'est pas sur la démo | `ng build` + tests unitaires de la feuille ; **à regarder en prod après déploiement**, société cdef31 |
| **§6 Missions** | la démo n'a aucun compte dépôt | 3 tests API (refus MISSION) + gabarit vérifié à la construction |
| **§8 Rôles** | il faut se connecter avec les comptes `demo-*` — je ne saisis jamais un mot de passe | matrice des permissions relue le 22/09, inchangée |
| **Hors service** (§3) | non exercé ce matin | même code que la prod (`computeSuggestions`), éprouvé en prod le 24/09 |
| `/admin/errors` | route super-admin : sur la démo, le compte est renvoyé à la connexion | lecture directe de `error_logs` de la démo en SQL : voir le plan, § 7 |

### Les demandes du propriétaire, à concevoir (28/09, en regardant la recette)

> « Un véhicule en garage, ça peut prendre une semaine. » — et il faut « penser comme les users :
> la page doit être pratique, pas une tâche ».

- **F8 / F9 — des évènements et des réservations sur plusieurs jours.** Le modèle porte déjà
  `startAt` / `endAt` ; ce sont les formulaires (une date) et la disponibilité du jour (qui ne regarde
  que `startAt`) qu'il faut faire raisonner sur l'intervalle. Une maintenance du 5 au 12 doit
  immobiliser le véhicule **tous les jours** de l'intervalle, dans le panneau du jour comme dans les
  suggestions.
- **F10 — celui qui valide doit pouvoir changer les dates** (une réservation validée reste éditable
  côté API depuis le 24/09 — `update()` — et une maintenance aussi : c'est l'écran qui ne l'offre pas).
- **F11 — « cette maintenance est-elle terminée ? »** : à l'ouverture de l'agenda, une liste des
  maintenances en cours dont la fin est passée (ou sans fin depuis plus d'un jour), avec **Oui,
  terminée** / **Non, nouvelle date de fin**. C'est ce qui fait de la page un outil et non une
  corvée : la clôture vient à l'utilisateur, il ne va pas la chercher.

Ces quatre points sont **un lot** — ils changent le même modèle de disponibilité — et ils ne se
font pas la matinée d'une mise en service.

---

## Ce qu'il ne faut pas défaire

- **L'agent ne réserve plus fermement.** Le réglage `autonomy` est passé à `suggest` en base le
  27/09 pour que les deux disent la même chose, mais ce n'est pas lui qui décide :
  c'est `AUTONOMIE_FERME_AUTORISEE` qui décide, à un seul endroit. Mesure qui l'a tranché : sur 321
  réservations automatiques passées, **le véhicule avait réellement roulé sur le créneau 57 fois sur
  100, et pas du tout ce jour-là 23 fois sur 100** ; l'heure dérape de 47 min en médiane.
- **L'exclusion des véhicules hors service et dormants est en UN seul endroit**
  (`computeSuggestions`), ce qui couvre les 4 surfaces d'un coup : disponibilité, suggestion, lien
  public, attribution automatique. Éprouvée en production : un véhicule accidenté, **seul candidat
  restant**, a été écarté au profit d'un autre.
- **Le lien public classe au lieu d'exclure** (rang 1 : aucun engagement · rang 2 : pris ailleurs ·
  rang 3 : déplace une proposition, signalée au valideur). Avant, un parc pré-rempli faisait
  **refuser** une demande humaine.
- **Le refus du dernier destinataire**, et celui de fermer les deux canaux d'alerte. Deux gardes de
  la même famille : on ne laisse pas l'application devenir muette par un réglage.
